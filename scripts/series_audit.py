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

    Run it ON THE PLEX HOST as root. The token comes from Preferences.xml, which
    is root-owned -- over a network mount the file is visible but unreadable, so
    running it from a workstation fails on the token, not on anything it could
    retry. Set PLEX_TOKEN to override; PLEX_URL and INCIPIT_API if either moves.
"""

import argparse
import csv
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

# Where Preferences.xml lives, most specific first. This homelab's appdata puts
# Plug-ins/ and Logs/ DIRECTLY under plex/ with no "Library/Application Support/
# Plex Media Server/" nesting, so the stock path is the WRONG default here --
# reaching for it is what made the first run of this script fail outright.
PREFS_CANDIDATES = (
    '/mnt/user/appdata/plex/Preferences.xml',
    '/Volumes/appdata/plex/Preferences.xml',
    '/mnt/user/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml',
    '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
)
PLEX = os.environ.get('PLEX_URL', 'http://127.0.0.1:32400')
# NOT validated at import. A module-level `raise SystemExit` ran before argparse
# ever saw the command line, so `--help` exited non-zero instead of printing
# usage, and the module could not be imported at all (FOLDER_POS_RE is worth
# reading on its own). main() checks it after parsing instead.
API = os.environ.get('INCIPIT_API')
TIMEOUT = 15

# EXACTLY the agent's update_tools.FOLDER_NUMBER_RE, character for character.
# This script's whole claim is "what the agent would read off the path", and a
# paraphrase of the real regex diverged four ways on its first audit: unbounded
# digits accepted the year-shaped "1632 - ..." the agent's 3-digit cap refuses,
# the separator class missed the "03_Title" underscore the agent accepts, a
# "Book " prefix was honored that the agent ignores, and no author anchor was
# required at all. Every divergence was a wrong row in the report.
FOLDER_POS_RE = re.compile(r'^\s*(\d{1,3}(?:\.\d{1,2})?)\s*[-._\s]\s*\S')

# The agent folds a leading article and all punctuation before comparing series
# names, and positions numerically ("01" == "1"); comparing raw strings here
# flagged agreeing shelves as DISAGREE.
ARTICLE_RE = re.compile(r'^(the|a|an)\s+', re.I)
NAME_FOLD_RE = re.compile(r'[\W_]+')


def series_fold(name):
    """A series name reduced the way the agent compares them."""
    return NAME_FOLD_RE.sub('', ARTICLE_RE.sub('', (name or '').strip().lower()))


def positions_equal(a, b):
    """Numeric when possible, so "01" == "1" and "1.0" == "1"."""
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return str(a) == str(b)


def die(msg):
    sys.stderr.write('error: %s\n' % msg)
    sys.exit(1)


def plex_token():
    """
    The server token: $PLEX_TOKEN, else Preferences.xml.

    Preferences.xml is root-owned, so over an SMB mount the file is visible but
    unreadable -- which is a different failure from "not found" and has a
    different fix. Say which one happened.
    """
    token = os.environ.get('PLEX_TOKEN')
    if token:
        return token

    override = os.environ.get('PLEX_PREFS')
    candidates = (override,) if override else PREFS_CANDIDATES
    found = next((p for p in candidates if os.path.exists(p)), None)
    if not found:
        die('no Preferences.xml found. Tried:\n  %s\nRun this on the Plex host, or set '
            'PLEX_PREFS=<path>, or PLEX_TOKEN=<token>.' % '\n  '.join(candidates))
    try:
        token = ET.parse(found).getroot().get('PlexOnlineToken')
    except PermissionError:
        die('%s is not readable by this user (it is root-owned; over a network mount that\n'
            'means you cannot read it from here). Run this on the Plex host as root, or pass\n'
            'PLEX_TOKEN=<token>.' % found)
    except Exception as exc:
        die('could not parse %s (%s)' % (found, exc))
    if not token:
        die('%s has no PlexOnlineToken' % found)
    return token


def get_xml(url):
    with urlopen(url, timeout=TIMEOUT) as response:
        return ET.parse(response).getroot()


# A failed API call is NOT a missing series. Folding every exception into None
# meant a down/slow API silently reclassified the whole library as
# FALLBACK/NO-DATA -- a plausible-looking, mass-wrong report. A 404 stays a
# genuine miss (the API really has no such book); everything else returns this
# sentinel, surfaces as UNKNOWN, and is counted for the closing warning.
API_ERROR = object()
API_ERRORS = {'count': 0, 'last': ''}


def get_json(url):
    import json
    try:
        with urlopen(url, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode('utf8'))
    except HTTPError as exc:
        if exc.code == 404:
            return None
        API_ERRORS['count'] += 1
        API_ERRORS['last'] = '%s -> HTTP %s' % (url.split('?')[0], exc.code)
        return API_ERROR
    except Exception as exc:
        API_ERRORS['count'] += 1
        API_ERRORS['last'] = '%s -> %s' % (url.split('?')[0], exc)
        return API_ERROR


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


def folder_series(path, author=None):
    """
    (series, position) as the agent would read them off the path.

    The album directory sits under its series directory:
        <author>/<series>/<NN - Title>/    -> (series, NN)
        <author>/<Title>/                  -> (None, None), a standalone
    Only a NUMBERED album folder proves a series directory above it; an
    unnumbered one is just as likely to be a standalone.

    The AUTHOR anchor mirrors the agent: it only trusts <series>/<NN - Title>
    when the folder above the series is the credited author. Without it, a flat
    <author>/<NN - Title>/ tree reported the AUTHOR folder as the series --
    a fabricated FALLBACK row for a layout the agent reads as no-series.
    """
    if not path:
        return None, None
    leaf = os.path.basename(path)
    parent = os.path.basename(os.path.dirname(path))
    grand = os.path.basename(os.path.dirname(os.path.dirname(path)))
    match = FOLDER_POS_RE.match(leaf)
    if not match or not parent:
        return None, None
    if author:
        # Flat tree: the parent IS the author, so there is no series folder.
        if series_fold(parent) == series_fold(author):
            return None, None
        # Anchored tree: the series folder must sit directly under the author.
        if series_fold(grand) != series_fold(author):
            return None, None
    return parent, match.group(1)


def api_series(book_id):
    """
    (series, position, ok) the API would hand the agent.

    ok=False means the CALL failed (timeout, refused, 5xx, 429) -- which says
    nothing about the book and must not read as "no series".
    """
    if not book_id:
        return None, None, True
    book = get_json('%s/books/%s' % (API, quote(book_id)))
    if book is API_ERROR:
        return None, None, False
    primary = (book or {}).get('seriesPrimary') or {}
    return primary.get('name'), primary.get('position'), True


def provider_id(album):
    """
    The API's book id, taken whole from the agent guid.

        com.plexapp.agents.incipit://<providerId>_<region>?lang=en

    It is NOT always an Audible ASIN. This library matches OverDrive, Hardcover
    and OpenLibrary too, and their ids look nothing like one --
    "overdrive-2654482", "hardcover-edition-31806861",
    "openlibrary-works-OL17770504W". Pulling a 10-character ASIN out with a
    regex reported every one of those books as having NO series (9 of Brandon
    Sanderson's 43 albums, six of them one series), and on a longer id it could
    match ten characters out of the middle and quietly query a different book.
    """
    guid = album.get('guid') or ''
    if '://' not in guid:
        return None
    ident = guid.split('://', 1)[1].split('?', 1)[0]
    return re.sub(r'_[a-z]{2}$', '', ident) or None


def shelvable(position):
    """A position only builds a sort title when it is a plain number."""
    return position is not None and re.match(r'^\d+(\.\d+)?$', str(position).strip())


def describe(name, position):
    """
    A series for display.

    A name with NO position is the whole reason a book lands in FALLBACK, so it
    has to read differently from a placed one -- printing it as "#None" states
    the opposite of what happened, that a position exists and is the string
    "None".
    """
    if not name:
        return '-'
    return '%s #%s' % (name, position) if position is not None else '%s (no position)' % name


def classify(api_name, api_pos, dir_name, dir_pos, api_ok=True):
    """Which of the five states this album is in. The API wins at runtime."""
    if not api_ok:
        # The API call failed; nothing here is evidence about the book.
        return 'UNKNOWN'
    if shelvable(api_pos):
        if not dir_name:
            return 'OK'
        # Folded comparison, matching the agent: "The Spellmonger" == "Spellmonger"
        # and "01" == "1" are agreements, not conflicts.
        same_name = series_fold(dir_name) == series_fold(api_name)
        return 'OK' if same_name and positions_equal(dir_pos, api_pos) else 'DISAGREE'
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

    # After parsing, so --help works and the module stays importable.
    if not API:
        die('INCIPIT_API must be set (e.g. http://10.0.0.2:3737) -- '
            'this repo is public and carries no host defaults')

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
            dir_name, dir_pos = folder_series(path, author=author)
            api_name, api_pos, api_ok = api_series(provider_id(album))
            rows.append({
                'state': classify(api_name, api_pos, dir_name, dir_pos, api_ok),
                'author': author,
                'album': album.get('title') or '',
                'api': describe(api_name, api_pos),
                'folder': describe(dir_name, dir_pos),
                'path': path or '',
            })

    for row in rows:
        if wanted and row['state'] not in wanted:
            continue
        print('%-9s %-22s %-32s api=%-38s folder=%s' % (
            row['state'], row['author'][:22], row['album'][:32], row['api'][:38], row['folder']))

    tally = Counter(r['state'] for r in rows)
    sys.stderr.write('\n%d albums: %s\n' % (
        len(rows), ', '.join('%s=%d' % (k, tally[k]) for k in sorted(tally))))
    sys.stderr.write(
        'FALLBACK = the folder decides the shelf; rename it and the shelf moves.\n'
        'DISAGREE = the API wins at runtime, so the folder name is the misleading one.\n'
        'UNKNOWN  = the API call FAILED for this row; it says nothing about the book.\n')
    if API_ERRORS['count']:
        sys.stderr.write(
            'WARNING: %d API call(s) failed (last: %s). UNKNOWN rows are not\n'
            'verdicts -- re-run when the API is healthy before acting on this report.\n'
            % (API_ERRORS['count'], API_ERRORS['last']))

    if args.csv:
        with open(args.csv, 'w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else
                                    ['state', 'author', 'album', 'api', 'folder', 'path'])
            writer.writeheader()
            writer.writerows(rows)
        sys.stderr.write('wrote %s\n' % args.csv)


if __name__ == '__main__':
    main()
