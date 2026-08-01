#!/usr/bin/env python3
"""
Retag the artist/albumartist of specific audiobook files, dry-run first.

WHY THIS EXISTS
    Plex's SCANNER parents an album under whatever artist the file tags lead
    with -- the metadata agent cannot re-parent an album, ever. Measured on the
    Mitch Rapp continuation novels (2026-07-25): five m4bs tagged
    "Kyle Mills" alone landed under Kyle Mills, while "Code Red", whose tag
    reads "Vince Flynn, Kyle Mills, Steven Weber", sits correctly under Vince
    Flynn. The matched records credit ['Vince Flynn', 'Kyle Mills'] -- the
    agent's data was right; only the tags disagreed.

    The fix is therefore in the FILES: lead the artist tags with the primary
    (franchise) author, keep the actual writer credited after them.

BEHAVIOUR
    * Dry run by DEFAULT: prints current -> proposed for every file, writes
      nothing. --apply to commit.
    * Tag edit only (mutagen MP4 atoms) -- the audio stream is never touched,
      no re-encode, no container rewrite beyond the tag atoms.
    * Only files whose current lead artist DIFFERS are written; already-correct
      files are reported and skipped.
    * Refuses non-.m4b/.m4a paths and missing files loudly.

USAGE (run on the box that holds the media files)
    python3 retag_author.py --artist "Vince Flynn, Kyle Mills" FILE [FILE...]
    python3 retag_author.py --artist "Vince Flynn, Kyle Mills" --apply FILE...

    Needs mutagen:  pip3 install mutagen

AFTER APPLYING
    Rescan the affected folders in Plex (Scan Library Files). The scanner
    re-reads the tags and re-parents the albums; cover.jpg files on disk are
    untouched and re-serve via prefer_local, so posters survive the move.
"""

import argparse
import os
import sys

try:
    from mutagen.mp4 import MP4
except ImportError:
    sys.stderr.write('mutagen is required: pip3 install mutagen\n')
    sys.exit(1)

ARTIST_ATOM = '\xa9ART'
ALBUM_ARTIST_ATOM = 'aART'


def current_tags(mp4):
    """(artist, albumartist) as displayed strings, '' when absent."""
    def first(atom):
        values = mp4.tags.get(atom) if mp4.tags else None
        return values[0] if values else ''
    return first(ARTIST_ATOM), first(ALBUM_ARTIST_ATOM)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--artist', required=True,
                        help='the full artist credit, primary author FIRST, '
                             'e.g. "Vince Flynn, Kyle Mills"')
    parser.add_argument('--apply', action='store_true',
                        help='write the tags (default is a dry run)')
    parser.add_argument('files', nargs='+', help='m4b/m4a files to retag')
    args = parser.parse_args()

    wanted = args.artist.strip()
    if not wanted:
        sys.stderr.write('--artist must not be empty\n')
        sys.exit(2)

    mode = 'APPLY' if args.apply else 'DRY RUN'
    print('== %s: lead artist -> %r' % (mode, wanted))
    changed = skipped = failed = 0
    for path in args.files:
        name = os.path.basename(path)
        if not path.lower().endswith(('.m4b', '.m4a')):
            print('REFUSE  %s (not an mp4-family audiobook)' % name)
            failed += 1
            continue
        if not os.path.isfile(path):
            print('MISSING %s' % path)
            failed += 1
            continue
        try:
            mp4 = MP4(path)
        except Exception as exc:
            print('ERROR   %s (%s)' % (name, exc))
            failed += 1
            continue
        artist, album_artist = current_tags(mp4)
        if artist == wanted and album_artist == wanted:
            print('OK      %-40s already %r' % (name[:40], wanted))
            skipped += 1
            continue
        print('CHANGE  %-40s artist %r -> %r | albumartist %r -> %r' % (
            name[:40], artist, wanted, album_artist, wanted))
        if args.apply:
            try:
                mp4[ARTIST_ATOM] = [wanted]
                mp4[ALBUM_ARTIST_ATOM] = [wanted]
                mp4.save()
                changed += 1
            except Exception as exc:
                print('ERROR   %s write failed (%s)' % (name, exc))
                failed += 1
        else:
            changed += 1
    print('== %s: %d to change, %d already correct, %d problems'
          % (mode, changed, skipped, failed))
    if not args.apply and changed:
        print('   re-run with --apply to write, then Scan Library Files in Plex')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
