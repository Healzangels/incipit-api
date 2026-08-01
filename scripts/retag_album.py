#!/usr/bin/env python3
"""
Retag the ALBUM of audiobook files so one album means one book, dry-run first.

WHY THIS EXISTS
    Plex's SCANNER groups tracks into albums by (album artist, album tag).
    Folders do not enter into it. So two different books whose files both carry
    the SERIES name in the album tag collapse into a single album, and the
    metadata agent -- which only ever describes the structure the scanner hands
    it -- cannot split them back apart. Same architectural wall as
    retag_author.py: the fix has to be in the FILES.

    Measured live 2026-07-29 on the Alcatraz shelf (main library, section 6).
    Books 1 and 3 sat in one album titled "Alcatraz Versus the Knights of
    Crystallia" while book 4 stood correctly alone:

        1 - Alcatraz vs. The Evil Librarians   @alb 'Alcatraz Smedry'   <- series
        3 - ...Knights of Crystallia           @alb 'Alcatraz Smedry'   <- series
        4 - ...Shattered Lens                  @alb 'Alcatraz Versus the Shattered Lens'

    The operator had already tried moving a book to its own directory; the merge
    simply moved to the next sibling, because the directory was never what bound
    them together.

    Note the shape of the correct sibling: its album tag is exactly its track
    title minus the "NN - " index and the " - YYYY" year. That is what
    --from-track-title reproduces, so a whole shelf converges on the form the
    already-correct files in it use.

BEHAVIOUR
    * Dry run by DEFAULT: prints current -> proposed, writes nothing. --apply
      to commit.
    * Tag edit only (mutagen MP4 atoms) -- the audio stream is never touched,
      no re-encode, no container rewrite beyond the tag atoms.
    * Only files whose album tag DIFFERS are written; correct files are
      reported and skipped.
    * Refuses to write an empty album, and refuses non-.m4b/.m4a paths loudly.
    * Directories are walked for m4b/m4a; single files are taken as given.

USAGE (run on the box that holds the media files)
    SHELF="/mnt/user/data/media/audiobooks/Brandon Sanderson/Alcatraz vs. the Evil Librarians"

    # 1. see which album tags are shared by more than one book
    python3 retag_album.py --audit "$SHELF"

    # 2. propose per-book albums derived from each file's own track title
    python3 retag_album.py --from-track-title "$SHELF"

    # 3. commit
    python3 retag_album.py --from-track-title --apply "$SHELF"

    # or set one explicit album for specific files
    python3 retag_album.py --album "The Scrivener's Bones" FILE [FILE...]

    Needs mutagen:  pip3 install mutagen

AFTER APPLYING -- RETAGGING ALONE IS NOT ENOUGH FOR FILES PLEX ALREADY HAS
    Plex fixes an album's membership when the track is FIRST scanned and never
    revisits it. Measured on the Alcatraz shelf 2026-07-29, in this order:

      * retag + scan            -- tracks touched (updatedAt moved), NOT split
      * rename the file + scan  -- Plex FOLLOWED the rename and kept the track
                                   in the same album, still NOT split
      * verified on disk        -- the two files' album tags were by now
                                   correct AND different from each other

    The one thing that did work was accidental: the operator had moved book 2
    out of the library entirely, so its track row was deleted; when it came
    back it scanned as new and landed in its own album immediately.

    So for a file Plex has already scanned, the tag edit only takes effect once
    the TRACK ROW is gone. Move the book's folder outside the library root,
    Scan Library Files (autoEmptyTrash removes the row), move it back, scan
    again. cover.jpg travels with the folder and re-serves via prefer_local,
    so posters survive. A brand-new file needs none of this -- it groups by its
    tag the first time it is seen, which is why fixing tags BEFORE import is
    always cheaper than fixing them after.
"""

import argparse
import os
import re
import sys
from collections import defaultdict

try:
    from mutagen.mp4 import MP4
except ImportError:
    sys.stderr.write('mutagen is required: pip3 install mutagen\n')
    sys.exit(1)

ALBUM_ATOM = '\xa9alb'
TRACK_TITLE_ATOM = '\xa9nam'
ARTIST_ATOM = '\xa9ART'
ALBUM_ARTIST_ATOM = 'aART'

AUDIO_SUFFIXES = ('.m4b', '.m4a')

# "01 - ", "3. ", "12) " -- the disc/track index publishers prefix onto a title.
INDEX_PREFIX_RE = re.compile(r'^\s*\d{1,3}\s*[-.–—)]\s*')
# " - 2007" -- the release year suffixed after the title.
YEAR_SUFFIX_RE = re.compile(r'\s*[-–—]\s*(?:1[89]|20)\d{2}\s*$')


def album_from_track_title(track_title):
    """The book's own title, as the correctly-tagged files in a shelf spell it.

    Strips a leading track index and a trailing release year -- and nothing
    else, so a real subtitle is never mangled. Returns '' when there is
    nothing usable left, which the caller must treat as a refusal.
    """
    if not track_title:
        return ''
    title = INDEX_PREFIX_RE.sub('', track_title)
    title = YEAR_SUFFIX_RE.sub('', title)
    return title.strip()


def first_tag(mp4, atom):
    values = mp4.tags.get(atom) if mp4.tags else None
    return values[0] if values else ''


def label_for(path):
    """parent/name -- audiobook trees routinely name every file the same."""
    parent = os.path.basename(os.path.dirname(path))
    name = os.path.basename(path)
    return '%s/%s' % (parent, name) if parent else name


def collect(paths):
    """Expand directories into m4b/m4a files; keep explicit files as given."""
    out = []
    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, names in os.walk(path):
                for name in sorted(names):
                    if name.lower().endswith(AUDIO_SUFFIXES):
                        out.append(os.path.join(root, name))
        else:
            out.append(path)
    return out


def audit(files):
    """Report album tags shared by more than one file -- the merge class."""
    groups = defaultdict(list)
    unreadable = 0
    for path in files:
        try:
            mp4 = MP4(path)
        except Exception as exc:
            print('ERROR   %s (%s)' % (label_for(path), exc))
            unreadable += 1
            continue
        artist = first_tag(mp4, ALBUM_ARTIST_ATOM) or first_tag(mp4, ARTIST_ATOM)
        groups[(artist, first_tag(mp4, ALBUM_ATOM))].append(path)

    shared = {key: paths for key, paths in groups.items() if len(paths) > 1}
    print('== audit: %d files, %d distinct albums, %d SHARED by 2+ files'
          % (len(files) - unreadable, len(groups), len(shared)))
    for (artist, album), paths in sorted(shared.items()):
        print('\n  %r / %r  <- %d files land in ONE Plex album' % (artist, album, len(paths)))
        for path in sorted(paths):
            mp4 = MP4(path)
            proposed = album_from_track_title(first_tag(mp4, TRACK_TITLE_ATOM))
            print('     %s' % path)
            print('        track title -> %r' % (proposed or '(nothing derivable)'))
    if not shared:
        print('   nothing shared -- every file already has its own album')
    return 1 if unreadable else 0


def retag(files, explicit_album, apply_changes):
    mode = 'APPLY' if apply_changes else 'DRY RUN'
    if explicit_album:
        print('== %s: album -> %r' % (mode, explicit_album))
    else:
        print('== %s: album -> derived from each file\'s track title' % mode)

    changed = skipped = failed = 0
    for path in files:
        name = label_for(path)
        if not path.lower().endswith(AUDIO_SUFFIXES):
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

        current = first_tag(mp4, ALBUM_ATOM)
        if explicit_album:
            wanted = explicit_album
        else:
            wanted = album_from_track_title(first_tag(mp4, TRACK_TITLE_ATOM))
            if not wanted:
                print('REFUSE  %-52s no usable track title to derive from'
                      % name[:52])
                failed += 1
                continue

        if current == wanted:
            print('OK      %-52s already %r' % (name[:52], wanted))
            skipped += 1
            continue

        print('CHANGE  %-52s album %r -> %r' % (name[:52], current, wanted))
        if apply_changes:
            try:
                mp4[ALBUM_ATOM] = [wanted]
                mp4.save()
                changed += 1
            except Exception as exc:
                print('ERROR   %s write failed (%s)' % (name, exc))
                failed += 1
        else:
            changed += 1

    print('== %s: %d to change, %d already correct, %d problems'
          % (mode, changed, skipped, failed))
    if not apply_changes and changed:
        print('   re-run with --apply to write, then Scan Library Files in Plex')
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--album',
                        help='one explicit album title for every file given')
    parser.add_argument('--from-track-title', action='store_true',
                        help="derive each file's album from its own track "
                             'title (index and year stripped)')
    parser.add_argument('--audit', action='store_true',
                        help='report album tags shared by 2+ files, write nothing')
    parser.add_argument('--apply', action='store_true',
                        help='write the tags (default is a dry run)')
    parser.add_argument('paths', nargs='+', help='m4b/m4a files or directories')
    args = parser.parse_args()

    files = collect(args.paths)
    if not files:
        sys.stderr.write('no m4b/m4a files found under the given paths\n')
        sys.exit(2)

    if args.audit:
        if args.apply:
            sys.stderr.write('--audit never writes; drop --apply\n')
            sys.exit(2)
        sys.exit(audit(files))

    if bool(args.album) == bool(args.from_track_title):
        sys.stderr.write('give exactly one of --album or --from-track-title '
                         '(or --audit)\n')
        sys.exit(2)

    album = args.album.strip() if args.album else None
    if args.album is not None and not album:
        sys.stderr.write('--album must not be empty\n')
        sys.exit(2)

    sys.exit(retag(files, album, args.apply))


if __name__ == '__main__':
    main()
