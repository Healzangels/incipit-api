#!/usr/bin/env python3
"""
Read-only audit: artists the agent could not match, and the files behind them.

WHY THIS EXISTS
    Plex's scanner files an album under the artist its FILE TAGS name, before the
    agent runs, and no agent can move it. A file with no artist tag lands under
    Plex's catch-all "[Unknown Artist]", which the agent deliberately never
    matches: it holds every untagged file in the section, whoever wrote it. The
    album still matches (the agent reads the author off the folder), so nothing
    looks wrong until someone opens the artist. Found 2026-09-30 on an m4b-tool
    release carrying no artist or album-artist tag. Chaptarr imports with
    writeAudioTags off, so nothing downstream fills the gap.

WHAT IT REPORTS, per artist Plex holds as unmatched (guid local://)
    UNTAGGED   "[Unknown Artist]": the files under it carry no artist tag.
    UNMATCHED  any other name the agent could not resolve to an author: a
               narrator, a credit string, a co-author's bare surname.
    Per album: the file, the author folder it sits in, and the retag_author.py
    dry run that would put it under that author. After retagging, Scan Library
    Files; if Plex keeps the album where it was, move its folder out of the
    library root, scan, move it back and scan again.

STRICTLY READ-ONLY
    It issues GETs and prints. It never edits Plex and never touches a file.

USAGE (on the Plex host as root, or anywhere with PLEX_URL + PLEX_TOKEN set)
    python3 artist_audit.py
    python3 artist_audit.py --section 6

    Exit status: 0 nothing to fix, 1 something listed (so a scheduled run can
    alert), 2 the audit itself failed.

    Paths are printed as Plex sees them. The library is /data/... inside the
    container, which is /mnt/user/data/... on the host; run retag_author.py in a
    container with the same mount, or translate the prefix.
"""

import argparse
import os
import sys
import xml.etree.ElementTree as ET
from urllib.request import urlopen

PREFS_CANDIDATES = (
    '/mnt/user/appdata/plex/Preferences.xml',
    '/Volumes/appdata/plex/Preferences.xml',
    '/mnt/user/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml',
    '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
)
PLEX = os.environ.get('PLEX_URL', 'http://127.0.0.1:32400')
TIMEOUT = 30

# Plex's own name for the artist of files that carry no artist tag.
UNKNOWN_ARTIST = '[Unknown Artist]'


def die(msg):
    sys.stderr.write('error: %s\n' % msg)
    sys.exit(2)


def plex_token():
    """The server token: $PLEX_TOKEN, else Preferences.xml (root-owned)."""
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
        die('%s is not readable by this user (it is root-owned). Run this on the Plex '
            'host as root, or pass PLEX_TOKEN=<token>.' % found)
    except Exception as exc:
        die('could not parse %s (%s)' % (found, exc))
    if not token:
        die('%s has no PlexOnlineToken' % found)
    return token


def get_xml(path, token):
    sep = '&' if '?' in path else '?'
    with urlopen('%s%s%sX-Plex-Token=%s' % (PLEX, path, sep, token), timeout=TIMEOUT) as response:
        return ET.parse(response).getroot()


# The agent's identifier, as Plex records it on each section.
INCIPIT_AGENT = 'com.plexapp.agents.incipit'


def audiobook_sections(root):
    """(key, title, [library roots]) for every section the Incipit agent serves.

    Audiobooks live in MUSIC sections, but so does music: an unmatched artist in a
    Plex Music section is that agent's business, and a retag_author.py line for it
    would be wrong advice.
    """
    return [(d.get('key'), d.get('title'), [loc.get('path') for loc in d.findall('Location')])
            for d in root.findall('Directory')
            if d.get('type') == 'artist' and d.get('agent') == INCIPIT_AGENT]


def classify(title):
    """UNTAGGED for Plex's no-tag catch-all, UNMATCHED for any other unresolved name."""
    return 'UNTAGGED' if title == UNKNOWN_ARTIST else 'UNMATCHED'


def folder_author(path, roots):
    """The first folder under the library root the file sits in, i.e. <root>/<Author>/..."""
    for root in sorted(roots, key=len, reverse=True):
        prefix = root.rstrip('/') + '/'
        if path.startswith(prefix):
            parts = path[len(prefix):].split('/')
            return parts[0] if len(parts) > 1 else None
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--section', help='only this section key (default: every Incipit section)')
    args = parser.parse_args()

    token = plex_token()
    try:
        sections = audiobook_sections(get_xml('/library/sections', token))
    except Exception as exc:
        die('could not list sections from %s (%s)' % (PLEX, exc))
    if args.section:
        sections = [s for s in sections if s[0] == args.section]
        if not sections:
            die('no Incipit section with key %s' % args.section)

    found = 0
    for key, title, roots in sections:
        try:
            artists = get_xml('/library/sections/%s/all?type=8' % key, token).findall('Directory')
        except Exception as exc:
            die('could not list artists in section %s (%s)' % (key, exc))
        unmatched = [a for a in artists if (a.get('guid') or '').startswith('local://')]
        print('== section %s (%s): %d artists, %d unmatched' % (key, title, len(artists), len(unmatched)))
        for artist in unmatched:
            name = artist.get('title') or ''
            print('%-9s %s  (rk %s)' % (classify(name), name, artist.get('ratingKey')))
            try:
                albums = get_xml('/library/metadata/%s/children' % artist.get('ratingKey'), token)
            except Exception as exc:
                die('could not list albums of artist %s (%s)' % (artist.get('ratingKey'), exc))
            for album in albums.findall('Directory'):
                found += 1
                matched = not (album.get('guid') or '').startswith('local://')
                print('  album  %s  (rk %s, %s)' % (album.get('title'), album.get('ratingKey'),
                                                    'matched' if matched else 'UNMATCHED'))
                try:
                    tracks = get_xml('/library/metadata/%s/children' % album.get('ratingKey'), token)
                except Exception as exc:
                    die('could not list tracks of album %s (%s)' % (album.get('ratingKey'), exc))
                files = [p.get('file') for p in tracks.iter('Part') if p.get('file')]
                author = folder_author(files[0], roots) if files else None
                for f in files[:3]:
                    print('    file   %s' % f)
                if len(files) > 3:
                    print('    ...    %d more' % (len(files) - 3))
                if author and files:
                    print('    fix    retag_author.py --artist "%s" "%s"%s' % (
                        author, files[0], ' ...' if len(files) > 1 else ''))
                else:
                    print('    fix    no author folder under the library root -- retag by hand')
    print('== %d album(s) under unmatched artists' % found)
    sys.exit(1 if found else 0)


if __name__ == '__main__':
    main()
