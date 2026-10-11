#!/usr/bin/env python3
"""Purpose: validate public/cbd/buildings.json (acceptance criteria: issue #21 section 7). Before the file exists only the skeleton is checked.
Usage: python3 tests/test_buildings.py (test.sh runs it); the last line is always "N passed, M failed"
"""
import json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CBD = os.path.join(os.path.dirname(HERE), 'public', 'cbd')
P = F = 0
USES = {'retail', 'office', 'residential', 'education', 'public', 'parking', 'hotel', 'other'}
SRCS = {'osm_height', 'osm_levels', 'com', 'default'}
FIELDS = {'id', 'name', 'use', 'height_m', 'levels', 'height_src', 'footprint', 'frontage'}
SWANSTON_LATROBE = (-37.809594, 144.963826)  # SCATS 2921


def ok(cond, msg):
    global P, F
    if cond:
        P += 1; print('✅ ' + msg)
    else:
        F += 1; print('❌ ' + msg)


def dist_m(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * k)


p = os.path.join(CBD, 'buildings.json')
if not os.path.exists(p):
    print('·  buildings.json not generated yet, skipping its checks')
    ok(True, 'skeleton: test_buildings.py runs')
else:
    raw = open(p, encoding='utf-8').read()
    doc = json.loads(raw)
    ok(os.path.getsize(p) <= 2 * 1024 * 1024, 'buildings.json ≤ 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    ok(isinstance(doc.get('version'), int) and 'bbox' in doc and doc.get('buildings'), 'version, bbox and buildings all present (%d buildings)' % len(doc.get('buildings', [])))
    net_p = os.path.join(CBD, 'network.json')
    net = json.load(open(net_p, encoding='utf-8')) if os.path.exists(net_p) else None
    if net is not None:
        ok(doc['bbox'] == net['bbox'], 'bbox matches network.json')
    bs = doc.get('buildings', [])
    ids = [b['id'] for b in bs]
    ok(len(ids) == len(set(ids)) and all(re.match(r'^[wr]\d+$', i) for i in ids), 'ids are unique and are w / r + OSM id')
    s, w, n, e = doc['bbox']
    bad = [b['id'] for b in bs if len(b['footprint']) < 3 or not all(s <= la <= n and w <= lo <= e for la, lo in b['footprint'])]
    ok(not bad, 'every footprint has ≥ 3 points, all inside the bbox%s' % (' (%d bad, e.g. %s)' % (len(bad), bad[:3]) if bad else ''))
    bad = [b['id'] for b in bs if not (0 < b['height_m'] < 350) or b['height_src'] not in SRCS or b['use'] not in USES]
    ok(not bad, '0 < height_m < 350, and height_src and use are in their enums%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    tall = {b['name']: b['height_m'] for b in bs if b.get('name') in ('Eureka Tower', 'Rialto Towers')}
    ok(all(h >= 200 for h in tall.values()), 'sanity: Eureka Tower and Rialto Towers are ≥ 200 m tall (%s; the OSM outer outline carries only the 20 m podium)' % tall)
    other = sum(1 for b in bs if b['use'] == 'other') / max(1, len(bs))
    ok(other <= 0.5, '%.0f%% of buildings have use other (required ≤ 50%%; 76%% with OSM alone, about 36%% after adding the City of Melbourne census)' % (other * 100))
    share = sum(1 for b in bs if b['height_src'] != 'default') / max(1, len(bs))
    ok(share >= 0.7, '%.0f%% of heights come from a source other than default (required ≥ 70%%)' % (share * 100))
    if net is not None:
        lk = {l['id'] for l in net['links']}
        bad = [f['link'] for b in bs for f in b['frontage'] if f['link'] not in lk]
        ok(not bad, 'every frontage link id is in network.json%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    near = lambda b: min(dist_m(SWANSTON_LATROBE, tuple(q)) for q in b['footprint'])
    for want in ('State Library Victoria', 'Melbourne Central'):  # exact full-name match: a substring match would also pick up the State Library Station metro station
        hit = [b['name'] for b in bs if b.get('name') == want and near(b) <= 150]
        ok(hit, 'landmark: "%s" is found by name within 150 m of Swanston × La Trobe (%s)' % (want, hit[:2]))
    # Reverse assertions: no keys / tokens and no personal information about occupants (only the agreed fields are allowed)
    ok(not re.search(r'(sk-[A-Za-z0-9]{16,}|api[_-]?key|secret|token|Bearer\s)', raw, re.I), 'reverse: the file contains no key / token strings')
    extra = sorted({k for b in bs for k in b} - FIELDS)
    ok(not extra and not re.search(r'addr:|phone|email|contact:|@[a-z0-9-]+\.[a-z]', raw, re.I),
       'reverse: no personal information fields such as address, phone or email%s' % (' (extra fields: %s)' % extra if extra else ''))

print('%d passed, %d failed' % (P, F))
sys.exit(1 if F else 0)
