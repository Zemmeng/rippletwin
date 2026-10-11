#!/usr/bin/env python3
"""Purpose: validate network.json, flows.json, signals.json, equipment.json, transit.json, walk.json and peds.json under public/cbd/ (rules: PRD.md section 7, PRD-2.md section 6).
Before the files exist only the skeleton is checked; once a file appears, its checks run automatically.
Usage: python3 tests/test_roads.py (test.sh runs it); the last line is always "N passed, M failed"
"""
import collections, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.dirname(HERE)
CBD = os.path.join(MOD, 'public', 'cbd')
P = F = 0


def ok(cond, msg):
    global P, F
    if cond:
        P += 1; print('✅ ' + msg)
    else:
        F += 1; print('❌ ' + msg)


def load(name):
    p = os.path.join(CBD, name)
    if not os.path.exists(p):
        print('·  %s not generated yet, skipping its checks' % name)
        return None, p
    with open(p, encoding='utf-8') as f:
        return json.load(f), p


def largest_scc_share(node_ids, links):
    """Share of all nodes in the largest strongly connected component (Kosaraju, iterative to avoid deep recursion)."""
    fwd, rev = {n: [] for n in node_ids}, {n: [] for n in node_ids}
    for l in links:
        if l['from'] in fwd and l['to'] in fwd:
            fwd[l['from']].append(l['to']); rev[l['to']].append(l['from'])
    seen, order = set(), []
    for s in node_ids:
        if s in seen:
            continue
        stack = [(s, iter(fwd[s]))]; seen.add(s)
        while stack:
            v, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                stack.pop(); order.append(v)
            elif nxt not in seen:
                seen.add(nxt); stack.append((nxt, iter(fwd[nxt])))
    comp, best = {}, 0
    for s in reversed(order):
        if s in comp:
            continue
        size, stack = 0, [s]; comp[s] = s
        while stack:
            v = stack.pop(); size += 1
            for u in rev[v]:
                if u not in comp:
                    comp[u] = s; stack.append(u)
        best = max(best, size)
    return best / max(1, len(node_ids))


# ---- skeleton ----
ok(os.path.exists(os.path.join(MOD, 'PRD.md')) and os.path.exists(os.path.join(MOD, 'README.md')), 'PRD.md and README.md both exist')
tools = [f for f in os.listdir(os.path.join(MOD, 'tools')) if f.endswith('.py')] if os.path.isdir(os.path.join(MOD, 'tools')) else []
bad = []
for t in tools:
    src = os.path.join(MOD, 'tools', t)
    try:
        compile(open(src, encoding='utf-8').read(), src, 'exec')  # syntax check only, no .pyc written
    except SyntaxError as e:
        bad.append('%s line %s: %s' % (t, e.lineno, e.msg))
ok(not bad, 'all %d scripts under tools/ have valid syntax%s' % (len(tools), (': ' + '; '.join(bad)) if bad else ''))

# ---- network.json ----
net, p = load('network.json')
link_ids = set()
if net is not None:
    ok(os.path.getsize(p) < 2 * 1024 * 1024, 'network.json is under 2 MB (actual %d KB)' % (os.path.getsize(p) // 1024))
    nodes, links = net.get('nodes', []), net.get('links', [])
    nid = [n.get('id') for n in nodes]; lid = [l.get('id') for l in links]
    link_ids = set(lid)
    ok(isinstance(net.get('version'), int), 'version is an integer')
    ok(len(nid) == len(set(nid)) and len(lid) == len(set(lid)) and nodes and links, '%d nodes, %d links, ids unique within each' % (len(nid), len(lid)))
    ns = set(nid)
    dangling = [l['id'] for l in links if l.get('from') not in ns or l.get('to') not in ns]
    ok(not dangling, 'every link\'s from / to is an existing node%s' % (' (bad: %s)' % dangling[:5] if dangling else ''))
    badv = []
    for l in links:
        try:
            spd = l['speed_kmh']; t_expect = l['len_m'] / (spd / 3.6)
            if not (l['len_m'] > 0 and l['lanes'] >= 1 and 5 <= spd <= 110 and l['cap_vph'] > 0 and abs(l['t0_s'] - t_expect) <= 0.05 * t_expect + 0.1):
                badv.append(l['id'])
        except (KeyError, TypeError, ZeroDivisionError):
            badv.append(l.get('id'))
    ok(not badv, 'link length, lanes, speed limit, capacity and free-flow time are all plausible%s' % (' (problems: %d links, e.g. %s)' % (len(badv), badv[:5]) if badv else ''))
    s, w, n, e = net.get('bbox', [0, 0, 0, 0]); m = 300 / 111320.0; mlon = m / max(0.1, math.cos(math.radians((s + n) / 2)))
    outside = [x['id'] for x in nodes if not (s - m <= x['lat'] <= n + m and w - mlon <= x['lon'] <= e + mlon)]
    ok(not outside, 'all nodes are inside the bbox (with a 300 m margin)%s' % (' (%d outside)' % len(outside) if outside else ''))
    share = largest_scc_share(nid, links)
    ok(share >= 0.9, 'network connectivity: the largest strongly connected component holds %.0f%% of nodes (required ≥ 90%%)' % (share * 100))

# ---- flows.json ----
flows, p = load('flows.json')
if flows is not None:
    ok(os.path.getsize(p) < 2 * 1024 * 1024, 'flows.json is under 2 MB (actual %d KB)' % (os.path.getsize(p) // 1024))
    days = flows.get('days', {})
    badf = []
    for d in ('wd', 'we'):
        for k, arr in days.get(d, {}).items():
            if not (isinstance(arr, list) and len(arr) == 24 and all(isinstance(x, (int, float)) and x >= 0 for x in arr)):
                badf.append('%s/%s' % (d, k))
    ok(not badf, 'every profile is 24 non-negative numbers%s' % (' (problems: %s)' % badf[:5] if badf else ''))
    if link_ids:
        miss = [k for k in link_ids if k not in days.get('wd', {}) or k not in days.get('we', {})]
        ok(not miss, 'every network link has weekday and weekend flows%s' % (' (%d missing)' % len(miss) if miss else ''))
        names = {l['id']: l.get('name') or '' for l in net['links']}
        lat = [days['wd'][k][17] for k in days.get('wd', {}) if 'la trobe' in str(names.get(k, '')).lower()]
        ok(any(100 <= v <= 2000 for v in lat), 'sanity: at least one La Trobe link carries 100–2000 veh/h at 17:00 on weekdays (%d links found)' % len(lat))
        # Calibration: per-lane flow estimated per junction (site_split) must be within 2x of per-lane measurements (detector_map)
        meth = flows.get('method', {}); lanes = {l['id']: l['lanes'] for l in net['links']}
        per_lane = lambda m: sorted(days['wd'][k][17] / lanes[k] for k, v in meth.items() if v == m and k in lanes)
        dm, ss = per_lane('detector_map'), per_lane('site_split')
        if dm and ss:
            a, b = dm[len(dm) // 2], ss[len(ss) // 2]
            ok(0.5 <= b / max(a, 1) <= 2, 'calibration: site_split median per lane at 17:00 is %d, detector_map %d, within 2x' % (b, a))
        cap = {l['id']: l['cap_vph'] for l in net['links']}
        over = [k for k in days.get('wd', {}) if k in cap and max(days['wd'][k]) > 1.2 * cap[k]]
        ok(len(over) <= 0.05 * max(1, len(cap)), 'no more than 5%% of links exceed 1.2x capacity in any weekday hour (%d links)' % len(over))
    cov = flows.get('coverage', {})
    ok(cov.get('links') == cov.get('measured', -1) + cov.get('estimated', -1), 'coverage: links = measured + estimated')

# ---- signals.json ----
sig, p = load('signals.json')
if sig is not None:
    sites = sig.get('sites', [])
    ids = [x.get('site') for x in sites]
    ok(len(ids) == len(set(ids)), 'signal site numbers are unique (%d sites)' % len(ids))
    if net is not None:
        ns = {n['id'] for n in net['nodes']}
        badn = [x['site'] for x in sites if x.get('node') is not None and x['node'] not in ns]
        ok(not badn, 'every matched node exists%s' % (' (bad: %s)' % badn[:5] if badn else ''))

# ---- equipment.json (PRD-2 section 6.4) ----
eq, p = load('equipment.json')
if eq is not None:
    ok(isinstance(eq.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'equipment.json: version is an integer, under 2 MB')
    items = eq.get('items', [])
    ids = [x.get('id') for x in items]
    ok(items and len(ids) == len(set(ids)), '%d equipment types, ids unique' % len(ids))
    CAT = {'barrier', 'sign', 'vms', 'arrow_board', 'ped_signal'}
    EFF = {'close', 'route_vehicles', 'route_peds', 'warn', 'message', 'control_crossing'}
    bad = [x.get('id') for x in items if x.get('category') not in CAT or x.get('effect') not in EFF]
    ok(not bad, 'category and effect take only the agreed values%s' % (' (bad: %s)' % bad if bad else ''))
    bad = [x['id'] for x in items if x.get('category') == 'barrier' and not (x.get('unit_len_m') or 0) > 0]
    bad += [x['id'] for x in items if x.get('category') == 'vms' and not ((x.get('lines') or 0) > 0 and (x.get('chars_per_line') or 0) > 0)]
    ok(not bad, 'every barrier has unit_len_m > 0 and every VMS has lines and chars_per_line%s' % (' (bad: %s)' % bad if bad else ''))
    bad = [x['id'] for x in items if not (isinstance(x.get('qty'), (int, float)) and x['qty'] >= 0)
           or not set(x.get('assumed', [])) <= set(x)]
    ok(not bad, 'every item has qty ≥ 0 and every field listed in assumed exists%s' % (' (bad: %s)' % bad if bad else ''))
    # VMS characters per line must match readSigns() / /api/read in apps/api (10 per line, longer gets a 400); the RPM Hire FAQ says 12–13 but its message guide says 10, which is used
    vms = {x['id']: x.get('chars_per_line') for x in items if x.get('category') == 'vms'}
    ok(vms and all(v == 10 for v in vms.values()), 'VMS has 10 characters per line, matching the sign-reading API (%s)' % vms)
    have = {x.get('category') for x in items}
    ok({'barrier', 'sign', 'vms', 'arrow_board', 'ped_signal'} <= have and sum(x.get('category') == 'sign' for x in items) >= 5,
       'minimum list: barriers, ≥ 5 static signs, VMS, arrow board and portable pedestrian signals are all present')

# ---- transit.json (PRD-2 section 6) ----
tr, p = load('transit.json')
if tr is not None:
    ok(isinstance(tr.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'transit.json: version is an integer, under 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    routes, stops = tr.get('routes', []), tr.get('stops', [])
    rids, sids = {r['id'] for r in routes}, {x['id'] for x in stops}
    ok(len(rids) == len(routes) and len(sids) == len(stops) and routes and stops, '%d routes, %d stops, ids unique within each' % (len(routes), len(stops)))
    if net is not None:
        lk = {l['id']: l for l in net['links']}
        bad = [x for r in routes for d in r['dirs'] for x in d['links'] if x not in lk]
        bad += [x['road_link'] for x in stops if x.get('road_link') is not None and x['road_link'] not in lk]
        ok(not bad, 'every link used by a route and every stop road_link is in network.json%s' % (' (bad: %s)' % bad[:5] if bad else ''))
        tram_links = {x for r in routes if r['mode'] == 'tram' for d in r['dirs'] for x in d['links']}
        share = sum(lk[x]['tram'] for x in tram_links if x in lk) / max(1, len(tram_links))
        ok(share >= 0.8, '%.0f%% of links used by tram routes are tagged tram in network.json (required ≥ 80%%)' % (share * 100))
        on_lt = {r['id'] for r in routes if r['mode'] == 'tram' for d in r['dirs'] for x in d['links'] if 'la trobe' in str(lk.get(x, {}).get('name') or '').lower()}
        ok(on_lt, 'sanity: at least one tram route runs on La Trobe St (%s)' % sorted(on_lt))
    bad = [x for r in routes for d in r['dirs'] for x in d['stops'] if x not in sids]
    bad += [r_ for x in stops for r_ in x.get('routes', []) if r_ not in rids]
    ok(not bad, 'route stops and stop routes reference each other consistently%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    bad = ['%s/%s/%s' % (r['id'], d['dir'], k) for r in routes for d in r['dirs'] for k in ('wd', 'we')
           if not (len(d['trips'].get(k, [])) == 24 and all(isinstance(v, (int, float)) and v >= 0 for v in d['trips'][k]))]
    ok(not bad, 'trips for every direction are 24 non-negative numbers%s' % (' (bad: %s)' % bad[:5] if bad else ''))

# ---- walk.json + peds.json (PRD-2 section 6) ----
wk, p = load('walk.json')
wl_ids = set()
if wk is not None:
    ok(isinstance(wk.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'walk.json: version is an integer, under 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    wn, wls = wk.get('nodes', []), wk.get('links', [])
    wnid = [x['id'] for x in wn]; wl_ids = {x['id'] for x in wls}
    ok(wn and wls and len(wnid) == len(set(wnid)) and len(wl_ids) == len(wls), '%d walking nodes, %d links, ids unique within each' % (len(wnid), len(wls)))
    ns = set(wnid)
    bad = [x['id'] for x in wls if x['a'] not in ns or x['b'] not in ns]
    if net is not None:
        lk = {l['id'] for l in net['links']}
        bad += [x['road_link'] for x in wls if x.get('road_link') is not None and x['road_link'] not in lk]
    ok(not bad, 'every walking link\'s endpoints and road_link exist%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    KIND = {'sidewalk', 'crossing', 'path', 'mall', 'other'}; CROSS = {'signal', 'zebra', 'uncontrolled', None}
    bad = [x['id'] for x in wls if x.get('kind') not in KIND or x.get('crossing') not in CROSS or x.get('side') not in ('left', 'right', None)]
    ok(not bad, 'kind / crossing / side take only the agreed values%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    # largest connected component of the undirected graph (union-find)
    par = {x: x for x in ns}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for x in wls:
        par[find(x['a'])] = find(x['b'])
    comp = collections.Counter(find(x) for x in ns) if ns else collections.Counter()
    share = max(comp.values()) / len(ns) if ns else 0
    ok(share >= 0.9, 'walking network connectivity: the largest connected component holds %.0f%% of nodes (required ≥ 90%%)' % (share * 100))

pd_, p = load('peds.json')
if pd_ is not None:
    ok(isinstance(pd_.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'peds.json: version is an integer, under 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    days = pd_.get('days', {})
    bad = ['%s/%s' % (d, k) for d in ('wd', 'we') for k, arr in days.get(d, {}).items()
           if not (isinstance(arr, list) and len(arr) == 24 and all(isinstance(v, (int, float)) and v >= 0 for v in arr))]
    ok(not bad, 'every pedestrian profile is 24 non-negative numbers%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    if wl_ids:
        bad = [k for d in ('wd', 'we') for k in days.get(d, {}) if k not in wl_ids]
        bad += [x['walk_link'] for x in pd_.get('sensors', []) if x.get('walk_link') is not None and x['walk_link'] not in wl_ids]
        ok(not bad, 'every pedestrian flow key and sensor walk_link is in walk.json%s' % (' (bad: %s)' % bad[:5] if bad else ''))
    cov = pd_.get('coverage', {})
    ok(cov.get('links') == cov.get('measured', -1) + cov.get('estimated', -1), 'peds coverage: links = measured + estimated')
    peaks = [max(days['wd'][x['walk_link']]) for x in pd_.get('sensors', []) if x.get('walk_link') in days.get('wd', {})]
    ok(peaks and 500 <= max(peaks) <= 10000, 'sanity: the busiest weekday sensor hour is between 500 and 10,000 ped/h (%s)' % (max(peaks) if peaks else 'none'))

print('%d passed, %d failed' % (P, F))
sys.exit(1 if F else 0)
