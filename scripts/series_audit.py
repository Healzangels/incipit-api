#!/usr/bin/env python3
"""
Read-only audit: what the agent will shelve each book as, vs what its folder says.

WHY THIS EXISTS
    A book's series comes from whichever source can actually PLACE it. When the
    API (Goodreads-authoritative) returns a series AND a numeric position, the
    agent uses that. When it cannot, the agent falls back to parsing the folder
    path -- and the folder inherits whatever the downstream library manager
    picked, which is how one shelf ends up half provider-named and half
    folder-named.

    That split was found by hand, one author at a time, only when someone
    happened to notice a wrong sort order in Plex. This finds every instance in
    one pass.

WHAT IT REPORTS, per album
    OK         the API places the book and the folder agrees
    FALLBACK   the API cannot place it -- the FOLDER decides the shelf. These
               are the books whose series is only as good as the directory name,
               and the ones that strand a shelf on an old name after a rename.
    DISAGREE   both can place it but they name a different series, or put it at
               a different position. The API wins at runtime, so the folder is
               the thing that is misleading.
    NO-DATA    neither source offers a series: a standalone, or a miss.

STRICTLY READ-ONLY
    It issues GETs and prints. It never renames a directory, never writes a
    cover.jpg, never PUTs a poster, never edits Plex. Covers in this library are
    hand-curated and must never be touched by a bulk process.

USAGE (on the Plex host)
    python3 series_audit.py                      # audit every audiobook album
    python3 series_audit.py --author "Brandon Sanderson"
    python3 series_audit.py --only FALLBACK,DISAGREE
    python3 series_audit.py --csv report.csv

    The Plex token is read from Preferences.xml, so no secret is passed on the
    command line or stored in this file.
"""

import argparse
import csv
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from urllib.parse import quote
from urllib.request import urlopen

PREFS = '/mnt/user/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml'
PLEX = os.environ.get('PLEX_URL', 'http://127.0.0.1:32400')
API = os.environ.get('INCIPIT_API', 'http://10.0.1.99:3737')
TIMEOUT = 15

# "12 - Title", "1.5 - Title", "Book 3 - Title". The number is what makes a
# folder able to POSITION a book; a bare title folder can only name the series.
FOLDER_POS_RE = re.compile(r'^(?:book\s*)?(\d+(?:\.\d+)?)\s*[-.\s]\s*(.+)$', re.I)


def die(msg):
    sys.stderr.write('error: %s\n' % msg)
    sys.exit(1)


def plex_token():
    """The server token, read from Preferences.xml (needs root on the Plex host)."""
    path = os.environ.get('PLEX_PREFS', PREFS)
    if not os.path.exists(path):
        die('no Preferences.xml at %s -- set PLEX_PREFS, or run this on the Plex host' % path)
    try:
        token = ET.parse(path).getroot().get('PlexOnlineToken')
    except Exception as exc:
        die('could not parse %s (%s)' % (path, exc))
    if not token:
        die('Preferences.xml has no PlexOnlineToken')
    return token


def get_xml(url):
    with urlopen(url, timeout=TIMEOUT) as response:
        return ET.parse(response).getroot()


def get_json(url):
    import json
    try:
        with urlopen(url, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode('utf8'))
    except Exception:
        return None


def audiobook_sections(token):
    """Every music section, which is how audiobooks are stored."""
    root = get_xml('%s/library/sections?X-Plex-Token=%s' % (PLEX, token))
    return [(d.get('key'), d.get('title'))
            for d in root.findall('.//Directory') if d.get('type') == 'artist']


def albums(token, section_key):
    """Every album in a section, with its author and rating key."""
    url = '%s/library/sections/%s/all?type=9&X-Plex-Token=%s' % (PLEX, section_key, token)
    return get_xml(url).findall('.//Directory')


def album_path(token, rating_key):
    """The directory holding the album's files, via its first track."""
    url = '%s/library/metadata/%s/children?X-Plex-Token=%s' % (PLEX, rating_key, token)
    try:
        root = get_xml(url)
    except Exception:
        return None
    part = root.find('.//Part')
    if part is None or not part.get('file'):
        return None
    return os.path.dirname(part.get('file'))


def folder_series(path):
    """
    (series, position) as the agent would read them off the path.

    The album directory sits under its series directory:
        <author>/<series>/<NN - Title>/    -> (series, NN)
        <author>/<Title>/                  -> (None, None), a standalone
    Only a NUMBERED album folder proves a series directory above it; an
    unnumbered one is just as likely to be a standalone.
    """
    if not path:
        return None, None
    leaf = os.path.basename(path)
    parent = os.path.basename(os.path.dirname(path))
    match = FOLDER_POS_RE.match(leaf)
    if not match or not parent:
        return None, None
    return parent, match.group(1)


def api_series(asin):
    """(series, position) the API would hand the agent, or (None, None)."""
    if not asin:
        return None, None
    book = get_json('%s/books/%s' % (API, quote(asin)))
    primary = (book or {}).get('seriesPrimary') or {}
    return primary.get('name'), primary.get('position')


def asin_of(album):
    """The ASIN inside the agent's guid, e.g. com.plexapp.agents.incipit://B07XYZ_us."""
    guid = album.get('guid') or ''
    match = re.search(r'([A-Z0-9]{10})', guid)
    return match.group(1) if match else None


def shelvable(position):
    """A position only builds a sort title when it is a plain number."""
    return position is not None and re.match(r'^\d+(\.\d+)?$', str(position).strip())


def classify(api_name, api_pos, dir_name, dir_pos):
    """Which of the four states this album is in. The API wins at runtime."""
    if shelvable(api_pos):
        if not dir_name:
            return 'OK'
        same_name = dir_name.strip().lower() == (api_name or '').strip().lower()
        return 'OK' if same_name and str(dir_pos) == str(api_pos) else 'DISAGREE'
    # The API cannot place it, so the folder decides the shelf.
    if dir_name:
        return 'FALLBACK'
    return 'NO-DATA'


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--author', help='limit to one author (exact, case-insensitive)')
    parser.add_argument('--only', help='comma-separated states to print, e.g. FALLBACK,DISAGREE')
    parser.add_argument('--csv', help='also write every row to this file')
    args = parser.parse_args()

    wanted = {s.strip().upper() for s in args.only.split(',')} if args.only else None
    token = plex_token()
    sections = audiobook_sections(token)
    if not sections:
        die('no artist/music sections found on %s' % PLEX)

    rows = []
    for key, title in sections:
        sys.stderr.write('scanning section %s (%s)...\n' % (title, key))
        for album in albums(token, key):
            author = album.get('parentTitle') or ''
            if args.author and author.strip().lower() != args.author.strip().lower():
                continue
            path = album_path(token, album.get('ratingKey'))
            dir_name, dir_pos = folder_series(path)
            api_name, api_pos = api_series(asin_of(album))
            rows.append({
                'state': classify(api_name, api_pos, dir_name, dir_pos),
                'author': author,
                'album': album.get('title') or '',
                'api': '%s #%s' % (api_name, api_pos) if api_name else '-',
                'folder': '%s #%s' % (dir_name, dir_pos) if dir_name else '-',
                'path': path or '',
            })

    for row in rows:
        if wanted and row['state'] not in wanted:
            continue
        print('%-9s %-24s %-34s api=%-30s folder=%s' % (
            row['state'], row['author'][:24], row['album'][:34], row['api'][:30], row['folder']))

    tally = Counter(r['state'] for r in rows)
    sys.stderr.write('\n%d albums: %s\n' % (
        len(rows), ', '.join('%s=%d' % (k, tally[k]) for k in sorted(tally))))
    sys.stderr.write(
        'FALLBACK = the folder decides the shelf; rename it and the shelf moves.\n'
        'DISAGREE = the API wins at runtime, so the folder name is the misleading one.\n')

    if args.csv:
        with open(args.csv, 'w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else
                                    ['state', 'author', 'album', 'api', 'folder', 'path'])
            writer.writeheader()
            writer.writerows(rows)
        sys.stderr.write('wrote %s\n' % args.csv)


if __name__ == '__main__':
    main()
