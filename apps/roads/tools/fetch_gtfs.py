#!/usr/bin/env python3
"""Purpose: extract only the tram and metropolitan bus sub-feeds from the DataVic "GTFS Schedule" bundle (about 275 MB) into raw/gtfs/.

Usage: python3 apps/roads/tools/fetch_gtfs.py [--modes 3,4] [--out raw/gtfs]
      -> raw/gtfs/3.zip (tram, about 14 MB download), raw/gtfs/4.zip (metropolitan bus, about 87 MB download); skipped if already present
Exit code: 0 success; 1 bundle or sub-feed not found
Dependencies: Python standard library only (reuses the HTTP Range reader from fetch_scats.py). Data licence CC BY 4.0 (Victorian Department of Transport and Planning / PTV).
Gotchas: the sub-feeds are stored compressed (deflate) inside the bundle, so each one must be downloaded whole; you cannot Range into it.
    Sub-feed numbers follow the PTV convention (3 tram, 4 metropolitan bus); route_type in routes.txt is authoritative (0 = tram, 3 = bus).
"""
import argparse, os, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_scats import remote_zip, resources  # noqa: E402

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--modes', default='3,4')
    ap.add_argument('--out', default=os.path.join(MOD, 'raw', 'gtfs'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    zips = [r['url'] for r in resources('gtfs-schedule') if r['url'].lower().endswith('.zip')]
    if not zips:
        print('❌ the gtfs-schedule dataset has no zip'); sys.exit(1)
    z, f = remote_zip(zips[0])
    names = set(z.namelist())
    for m in a.modes.split(','):
        member, dst = '%s/google_transit.zip' % m, os.path.join(a.out, '%s.zip' % m)
        if os.path.exists(dst):
            print('·  %s already exists, skipping' % dst); continue
        if member not in names:
            print('❌ %s is not in the bundle' % member); sys.exit(1)
        with z.open(member) as src, open(dst + '.part', 'wb') as out:
            shutil.copyfileobj(src, out, 1 << 20)
        os.replace(dst + '.part', dst)
        print('✅ %s → %s (%.1f MB downloaded so far)' % (member, dst, f.fetched / 1e6), flush=True)


if __name__ == '__main__':
    main()
