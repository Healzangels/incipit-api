#!/usr/bin/env python3
"""Shelf snapshot / revert — the undo story for reviewed refresh windows.

Before refreshing albums whose shelves a deliberate change will move, capture
what Plex currently shows; if a landed change is regretted, restore the sort
titles from the snapshot.

  capture:  python3 scripts/shelfSnapshot.py capture --host <plex-host> \
                --token TOKEN --rks 731384,731376 --out snap.json
            (--from-impact prod_impact.json takes the rk list from an impact file)
  restore:  python3 scripts/shelfSnapshot.py restore --host <plex-host> \
                --token TOKEN --snap snap.json [--rks only,these]

Restore writes titleSort back WITH the lock flag set, so a later agent refresh
does not immediately re-overwrite the operator's revert. Unlock by hand in
Plex if the field should float again. Moods are captured for the record but
NOT restored (they are additive tags; deleting them is a separate operator
decision — see the redesign amendments).
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def fetch(host, token, rk):
    url = "http://%s:32400/library/metadata/%s?X-Plex-Token=%s" % (host, rk, token)
    with urllib.request.urlopen(url, timeout=30) as r:
        root = ET.fromstring(r.read())
    d = root.find("Directory")
    if d is None:
        return None
    return {
        "ratingKey": rk,
        "title": d.get("title"),
        "titleSort": d.get("titleSort") or "",
        "artist": d.get("parentTitle"),
        "moods": [m.get("tag") for m in d.findall("Mood")],
        "updatedAt": d.get("updatedAt"),
    }


def capture(args):
    rks = load_rks(args)
    out = []
    for rk in rks:
        row = fetch(args.host, args.token, rk)
        if row:
            out.append(row)
            print("  captured rk%s  %-40s sort=%s" % (rk, (row["title"] or "")[:38], row["titleSort"][:50]))
    with open(args.out, "w") as f:
        json.dump({"host": args.host, "rows": out}, f, indent=1)
    print("snapshot: %d albums -> %s" % (len(out), args.out))


def restore(args):
    with open(args.snap) as f:
        snap = json.load(f)
    only = set(args.rks.split(",")) if args.rks else None
    for row in snap["rows"]:
        rk = row["ratingKey"]
        if only and rk not in only:
            continue
        q = urllib.parse.urlencode({
            "titleSort.value": row["titleSort"],
            "titleSort.locked": "1",
            "X-Plex-Token": args.token,
        })
        url = "http://%s:32400/library/metadata/%s?%s" % (args.host, rk, q)
        req = urllib.request.Request(url, method="PUT")
        with urllib.request.urlopen(req, timeout=30) as r:
            ok = r.status == 200
        print("  %s rk%s -> titleSort=%r (locked)" % ("restored" if ok else "FAILED", rk, row["titleSort"][:50]))


def load_rks(args):
    if args.rks:
        return [r.strip() for r in args.rks.split(",") if r.strip()]
    if args.from_impact:
        with open(args.from_impact) as f:
            return [row["rk"] for row in json.load(f)]
    sys.exit("need --rks or --from-impact")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    for name in ("capture", "restore"):
        p = sub.add_parser(name)
        p.add_argument("--host", required=True)
        p.add_argument("--token", required=True)
        if name == "capture":
            p.add_argument("--rks")
            p.add_argument("--from-impact")
            p.add_argument("--out", required=True)
        else:
            p.add_argument("--snap", required=True)
            p.add_argument("--rks")
    args = ap.parse_args()
    capture(args) if args.mode == "capture" else restore(args)


if __name__ == "__main__":
    main()
