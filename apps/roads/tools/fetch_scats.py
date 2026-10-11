#!/usr/bin/env python3
"""Purpose: pull SCATS data from DataVic remotely without first downloading the full monthly archive (the server supports HTTP Range).

Usage:
  python3 apps/roads/tools/fetch_scats.py --day 2026-09-22 [--bbox S,W,N,E] [--out raw/]
      extract one day, keep only rows for sites inside the bbox, save as raw/cbd_VSDATA_20260922.csv (about 4.6 MB download)
  python3 apps/roads/tools/fetch_scats.py --range 2026-08-01..2026-09-27
      extract a date range (each month's zip is opened once; days already extracted or missing are skipped); 8 weeks is about 270 MB and 30 minutes
  python3 apps/roads/tools/fetch_scats.py --sites [--out raw/]
      download the traffic signal site list raw/victorian_traffic_signals.csv (about 300 KB)
  python3 apps/roads/tools/fetch_scats.py --sheet 2921 [--out raw/]
      extract one junction's configuration sheet (PDF or web page) from the detector configuration bundle (about 2 GB)
Exit code: 0 success; 1 data not found (date outside the published months, site number not in the bundle, etc.)
Dependencies: Python standard library only. Data licence CC BY 4.0 (Victorian Department of Transport and Planning).
"""
import argparse, csv, io, json, os, sys, urllib.request, zipfile

CKAN = 'https://discover.data.vic.gov.au/api/3/action/package_show?id='
DEFAULT_BBOX = (-37.8235, 144.9480, -37.8060, 144.9760)


class HTTPRange(io.RawIOBase):
    """Read a remote file as if it were a local seekable file, so zipfile fetches only the byte ranges it needs."""

    def __init__(self, url):
        self.url, self.pos, self.fetched = url, 0, 0
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as r:
            self.size = int(r.headers['Content-Length'])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        req = urllib.request.Request(self.url, headers={'Range': 'bytes=%d-%d' % (self.pos, self.pos + n - 1)})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = r.read()
        b[:len(d)] = d; self.pos += len(d); self.fetched += len(d)
        return len(d)


def resources(pkg):
    with urllib.request.urlopen(CKAN + pkg, timeout=60) as r:
        return json.load(r)['result']['resources']


def remote_zip(url):
    f = HTTPRange(url)
    # Use a large buffer: every readinto is one HTTPS Range request; at 64 KB a day takes dozens of round trips (about 2 minutes per day)
    return zipfile.ZipFile(io.BufferedReader(f, buffer_size=4 << 20)), f


def sites_csv(out):
    url = resources('victorian-traffic-signals')[0]['url']
    p = os.path.join(out, 'victorian_traffic_signals.csv')
    urllib.request.urlretrieve(url, p)
    print('✅ site list → %s' % p)
    return p


def in_bbox(sites_path, bbox):
    s, w, n, e = bbox
    keep = set()
    for r in csv.DictReader(open(sites_path, encoding='utf-8-sig')):
        try:
            la, lo = float(r['LATITUDE']), float(r['LONGITUDE'])
        except ValueError:
            continue
        if s <= la <= n and w <= lo <= e:
            keep.add(r['SITE_NO'])
    return keep


def fetch_days(days, bbox, out, strict=True):
    """Extract several days, opening each month's remote zip only once. Days already extracted (raw/cbd_VSDATA_<date>.csv exists) are skipped."""
    import datetime
    sp = os.path.join(out, 'victorian_traffic_signals.csv')
    if not os.path.exists(sp):
        sites_csv(out)
    keep = in_bbox(sp, bbox)
    by_month = {}
    for day in days:
        by_month.setdefault(day[:7], []).append(day)
    all_res = resources('traffic-signal-volume-data')
    for ym, ds in sorted(by_month.items()):
        todo = [d for d in ds if not os.path.exists(os.path.join(out, 'cbd_VSDATA_%s.csv' % d.replace('-', '')))]
        if not todo:
            print('·  %s: all %d days already extracted, skipping' % (ym, len(ds))); continue
        name = 'traffic signal volume data %s %s' % (datetime.date.fromisoformat(ds[0]).strftime('%B').lower(), ym[:4])
        res = [r for r in all_res if r['name'].lower() == name]
        if not res:
            print('❌ monthly archive "%s" not found (maybe not yet published, or that year is packaged as one annual archive)' % name); sys.exit(1)
        z, f = remote_zip(res[0]['url'])
        names = set(z.namelist())
        for day in todo:
            member = 'VSDATA_%s.csv' % day.replace('-', '')
            if member not in names:
                print('❌ %s is not in the monthly archive (the official data has missing days, e.g. 2026-08-31)' % member)
                if strict:
                    sys.exit(1)
                continue
            rd = csv.reader(io.TextIOWrapper(z.open(member), encoding='utf-8-sig'))
            p = os.path.join(out, 'cbd_' + member)
            n = 0
            with open(p + '.part', 'w', newline='') as fo:  # write .part first so an interruption never leaves half a file
                w = csv.writer(fo); w.writerow(next(rd))
                for r in rd:
                    if r[0] in keep:
                        w.writerow(r); n += 1
            os.replace(p + '.part', p)
            print('✅ %s → %s (%d sites in bbox, %d rows; %.1f MB downloaded so far)' % (member, p, len(keep), n, f.fetched / 1e6), flush=True)


def fetch_day(day, bbox, out):
    fetch_days([day], bbox, out)


def fetch_sheet(site, out):
    num = int(site)
    for r in resources('traffic-signal-configuration-data-sheets'):
        try:
            lo, hi = [int(x) for x in r['name'].rsplit(' ', 1)[-1].split('-')]
        except ValueError:
            continue
        if lo <= num <= hi:
            z, f = remote_zip(r['url'])
            hits = [m for m in z.namelist() if os.path.basename(m).split('.')[0] == str(num) or ('/%d_files/' % num) in m]
            if not hits:
                print('❌ %s does not contain site %s' % (r['name'], site)); sys.exit(1)
            for m in hits:
                if m.endswith('/'):
                    continue
                dst = os.path.join(out, 'sheet_' + m.replace('/', '__'))
                open(dst, 'wb').write(z.read(m))
            print('✅ configuration sheet for site %s: %d files → %s (%.1f MB downloaded)' % (site, len(hits), out, f.fetched / 1e6))
            return
    print('❌ no configuration sheet bundle covers site %s' % site); sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--day'); g.add_argument('--sites', action='store_true'); g.add_argument('--sheet')
    g.add_argument('--range', help='start..end, e.g. 2026-08-01..2026-09-27; missing days are skipped without error')
    ap.add_argument('--bbox', default=','.join(map(str, DEFAULT_BBOX)), help='south,west,north,east')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'raw'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.sites:
        sites_csv(a.out)
    elif a.sheet:
        fetch_sheet(a.sheet, a.out)
    elif a.range:
        import datetime
        lo, hi = (datetime.date.fromisoformat(x) for x in a.range.split('..'))
        days = [(lo + datetime.timedelta(i)).isoformat() for i in range((hi - lo).days + 1)]
        fetch_days(days, tuple(float(x) for x in a.bbox.split(',')), a.out, strict=False)
    else:
        fetch_day(a.day, tuple(float(x) for x in a.bbox.split(',')), a.out)


if __name__ == '__main__':
    main()
