#!/usr/bin/env python3
"""Purpose: validate public/cbd/vectormap.json (the real OSM vector layers used as the basemap for the web app's CITY layer). Before the file exists only the skeleton is checked.
tools/fetch_vectormap.py decodes the data at build time from OpenFreeMap's OpenMapTiles vector tiles; at run time the page fetches only this one same-origin file.
Usage: python3 tests/test_vectormap.py (test.sh runs it); the last line is always "N passed, M failed"
Licence: ODbL (OpenStreetMap) + CC BY 4.0 (OpenMapTiles schema).
"""
import json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CBD = os.path.join(os.path.dirname(HERE), 'public', 'cbd')
P = F = 0
FILL_KINDS = ['water', 'aeroway', 'wood', 'grass', 'wetland', 'ice', 'sand', 'park', 'sport', 'civic', 'urban']
LINE_KINDS = ['waterway', 'rail', 'transit']
MIN_AREA_M2 = 200.0          # same as fetch_vectormap.py: smaller polygons are dropped at build time
PAD_DEG = 0.022              # tiles are decoded whole (not clipped to the bbox), so allow one z14 tile beyond the bbox (longitude 360/2^14 ≈ 0.02197°)
YARRA_LAT = -37.815          # the Yarra lies in the south of the bbox; used to confirm water was not decoded in the wrong place


def ok(cond, msg):
    global P, F
    if cond:
        P += 1; print('✅ ' + msg)
    else:
        F += 1; print('❌ ' + msg)


def area_m2(ring):
    """Equirectangular approximation, same algorithm as the build script (used only to filter slivers)"""
    k = 111320 * math.cos(math.radians(ring[0][0]))
    a = 0.0
    for i in range(len(ring)):
        la0, lo0 = ring[i]
        la1, lo1 = ring[(i + 1) % len(ring)]
        a += (lo0 * k) * (la1 * 111320) - (lo1 * k) * (la0 * 111320)
    return abs(a) / 2


def line_len(pts):
    k = 111320 * math.cos(math.radians(pts[0][0]))
    return sum(math.hypot((pts[i + 1][0] - pts[i][0]) * 111320, (pts[i + 1][1] - pts[i][1]) * k)
               for i in range(len(pts) - 1))


p = os.path.join(CBD, 'vectormap.json')
if not os.path.exists(p):
    print('·  vectormap.json not generated yet, skipping its checks (python3 tools/fetch_vectormap.py)')
    ok(True, 'skeleton: test_vectormap.py runs')
else:
    raw = open(p, encoding='utf-8').read()
    doc = json.loads(raw)
    ok(os.path.getsize(p) <= 2 * 1024 * 1024, 'vectormap.json ≤ 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    FIELDS = {'version', 'area', 'bbox', 'generated', 'zoom', 'tile_source', 'sources', 'assumptions', 'polygons', 'lines'}
    ok(set(doc) == FIELDS, 'top-level fields are exactly the agreed set%s' % (' (extra: %s)' % sorted(set(doc) - FIELDS) if set(doc) - FIELDS else ''))
    ok(doc.get('version') == 1 and doc.get('area') == 'cbd', 'version 1, area cbd')
    ok(doc.get('generated', '').startswith('2'), 'generation time recorded (%s)' % doc.get('generated', '')[:19])
    # bbox must match the other two files in this directory, or the CITY layer would have a piece missing or extra
    for name in ('network.json', 'buildings.json'):
        q = os.path.join(CBD, name)
        if os.path.exists(q):
            ok(doc['bbox'] == json.load(open(q, encoding='utf-8'))['bbox'], 'bbox matches %s' % name)

    # tile source: must be a template, not one hard-coded tile
    ts = doc.get('tile_source', '')
    ok(ts.startswith('https://') and '{z}' in ts and '{x}' in ts and '{y}' in ts,
       'tile_source is a {z}/{x}/{y} template (%s)' % ts[:60])
    ok(isinstance(doc.get('sources'), list) and any('OpenStreetMap' in s for s in doc['sources'])
       and any('OpenMapTiles' in s for s in doc['sources']), 'attribution includes both OSM and OpenMapTiles')
    ok(doc.get('zoom') == 14 and doc['assumptions'].get('round') == 6, 'zoom 14, lat/lon kept to 6 decimal places')

    # layers: kinds in the enum, fixed order (re-runs diff cleanly), no empty layers
    pk = [x['kind'] for x in doc['polygons']]
    lk = [x['kind'] for x in doc['lines']]
    ok(all(k in FILL_KINDS for k in pk) and len(pk) == len(set(pk)), 'polygon kinds are in the enum with no duplicates (%s)' % pk)
    ok(all(k in LINE_KINDS for k in lk) and len(lk) == len(set(lk)), 'line kinds are in the enum with no duplicates (%s)' % lk)
    ok(pk == [k for k in FILL_KINDS if k in pk] and lk == [k for k in LINE_KINDS if k in lk], 'kinds are written in a fixed order')
    ok(not [x for x in doc['polygons'] if not x['polys']] and not [x for x in doc['lines'] if not x['pts']],
       'no empty layers')

    s, w, n, e = doc['bbox']
    bad, thin, dup, prec = [], [], 0, 0
    for x in doc['polygons']:
        ok_kind = x['kind']
        for poly in x['polys']:
            for ring in poly:
                if len(ring) < 3:
                    thin.append((ok_kind, len(ring))); continue
                if area_m2(ring) < MIN_AREA_M2:
                    bad.append((ok_kind, round(area_m2(ring)), ring[0]))
                for la, lo in ring:
                    if not (s - PAD_DEG <= la <= n + PAD_DEG and w - PAD_DEG <= lo <= e + PAD_DEG):
                        bad.append((ok_kind, (la, lo)))
                    if round(la, 6) != la or round(lo, 6) != lo:
                        prec += 1
    for x in doc['lines']:
        for pts in x['pts']:
            if len(pts) < 2:
                thin.append((x['kind'], len(pts))); continue
            if line_len(pts) < 1:
                bad.append((x['kind'], 'zero length', pts[0]))
            for la, lo in pts:
                if not (s - PAD_DEG <= la <= n + PAD_DEG and w - PAD_DEG <= lo <= e + PAD_DEG):
                    bad.append((x['kind'], (la, lo)))
                if round(la, 6) != la or round(lo, 6) != lo:
                    prec += 1
    for x in doc['polygons']:
        for poly in x['polys']:
            for ring in poly:
                dup += sum(1 for i in range(len(ring)) if ring[i] == ring[(i + 1) % len(ring)])
    for x in doc['lines']:
        for pts in x['pts']:
            dup += sum(1 for i in range(len(pts) - 1) if pts[i] == pts[i + 1])
    ok(not thin, 'every polygon ring has ≥ 3 points and every line ≥ 2 points%s' % (' (bad: %s)' % thin[:3] if thin else ''))
    ok(not bad, 'every polygon/line is within bbox ± %.3f°, area ≥ %d m², length > 0%s' % (PAD_DEG, MIN_AREA_M2, (' (bad: %s)' % bad[:3]) if bad else ''))
    ok(not dup and prec == 0, 'no adjacent duplicate points (%d found), all lat/lon rounded to 6 places (%d over-precise)' % (dup, prec))
    # winding: outer rings and holes are both kept and the page fills them in one nonzero pass; here we only confirm rings are not written as open polylines
    ok(all(len(ring) >= 3 and ring[0] != ring[-1] for x in doc['polygons'] for poly in x['polys'] for ring in poly),
       'rings do not repeat the first point at the end (canvas closePath closes them)')

    # sanity: water must include the Yarra (a large water body in the south of the bbox), rail/tram lines must exist, and no line may be absurdly long
    water = [ring for x in doc['polygons'] if x['kind'] == 'water' for poly in x['polys'] for ring in poly]
    big = [a for a in (area_m2(r) for r in water) if a >= 50000]
    ok(len(big) >= 1, 'water includes a body of ≥ 50,000 m² (the Yarra); found %d' % len(big))
    ok(all(min(la for la, _ in r) < YARRA_LAT for r in water if area_m2(r) >= 50000),
       'large water bodies lie in the south of the bbox (the Yarra is south of Flinders St)')
    tr = [pts for x in doc['lines'] if x['kind'] == 'transit' for pts in x['pts']]
    ok(tr and any(line_len(q) >= 200 for q in tr), 'tram lines (transit): %d segments, at least one longer than 200 m' % len(tr))
    rl = [pts for x in doc['lines'] if x['kind'] == 'rail' for pts in x['pts']]
    ok(rl and all(line_len(q) <= 3000 for q in rl), 'rail lines: %d segments, none longer than 3 km (a tile cannot hold a straight run that long)' % len(rl))
    rails = sum(line_len(q) for q in rl)
    ok(1000 <= rails <= 200000, 'total rail length %d m is a plausible order of magnitude for a CBD' % round(rails))

    # Reverse assertions: no keys / tokens and no personal information (only the agreed coordinates and fields are allowed)
    ok(not re.search(r'(sk-[A-Za-z0-9]{16,}|api[_-]?key|secret|token|Bearer\s)', raw, re.I), 'reverse: the file contains no key / token strings')
    extra = sorted(({k for x in doc['polygons'] for k in x} | {k for x in doc['lines'] for k in x}) - {'kind', 'polys', 'pts'})
    ok(not extra and not re.search(r'addr:|phone|email|@[a-z0-9-]+\.[a-z]', raw, re.I),
       'reverse: only kind / polys / pts, no fields such as address or email%s' % (' (extra fields: %s)' % extra if extra else ''))
    ok(not re.search(r'https?://(?!tiles\.openfreemap\.org)', raw), 'reverse: the only URL in the file is the tile source; no other external links')

print('%d passed, %d failed' % (P, F))
sys.exit(1 if F else 0)
