#!/usr/bin/env python3
"""Purpose: generate public/<area>/walk.json (undirected walking network) and peds.json (pedestrian volumes, same layout as flows.json). Format: PRD-2 section 3C.

Usage:
  apps/roads/.venv/bin/python apps/roads/tools/build_walk.py [--area cbd] [--from 2026-08-01] [--to 2026-09-27]
Prerequisites: raw/osm_walk.graphml (tools/fetch_osm.py --walk), raw/peds.csv + raw/ped_sensors.csv (the curl commands in the README),
      public/<area>/network.json
Exit code: 0 success; 1 input files missing
Method:
  walk.json
    0. Drop indoor corridors (highway=corridor), parking aisles and driveways (service=parking_aisle / driveway / drive-through)
    1. Convert the OSM walking network to an undirected graph, keep endpoints where highway / footway changes, then simplify; keep only the largest connected component
    2. kind: footway=sidewalk -> sidewalk; footway=crossing or highway=crossing -> crossing;
       highway=pedestrian -> mall; footway / path / steps / cycleway -> path; everything else (walking along a roadway) -> other
    3. crossing: crossing=traffic_signals -> signal; zebra -> zebra; everything else -> uncontrolled
    4. road_link + side: sidewalk / other links look for a parallel road link within ROAD_M metres;
       Australia drives on the left, so a sidewalk is attached to the direction it lies to the left of (side=left); on a one-way road with only one direction it may be right;
       a crossing is attached to the link it crosses (side=null)
  peds.json
    sensor         each sensor is attached to the nearest sidewalk (within SENSOR_M metres); 8-week hourly means for weekdays / weekends
    street_interp  sidewalks on a street with the same name use the nearest sensor on that street (within STREET_M metres)
    class_default  the rest: median of sensors by the class of the adjacent road; links not beside a roadway (paths, plazas) take the 25th percentile of all sensors
"""
import argparse, collections, csv, datetime, json, math, os, statistics, sys, warnings

warnings.filterwarnings('ignore')
import networkx as nx
import osmnx as ox
from shapely import STRtree
from shapely.geometry import LineString, Point

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOLIDAYS = {'2026-09-25'}
ROAD_M = 25        # how close to a roadway centreline a sidewalk must be to count as beside it
SENSOR_M = 40      # maximum distance when attaching a sensor to a sidewalk
STREET_M = 800     # how far away a same-street sensor can be for interpolation
PARALLEL = 30      # bearing difference (degrees) that still counts as parallel
SIMPLIFY_DEG = 0.00003
DROP_SERVICE = {'parking_aisle', 'driveway', 'drive-through'}


class Proj:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0, self.k = lat0, lon0, math.cos(math.radians(lat0))

    def xy(self, lat, lon):
        return ((lon - self.lon0) * 111320 * self.k, (lat - self.lat0) * 111320)


def first(v):
    return v[0] if isinstance(v, list) else v


def vals(v):
    return [str(x) for x in (v if isinstance(v, list) else [v]) if x is not None]


def kind_of(d):
    hw, fw = vals(d.get('highway')), vals(d.get('footway'))
    if 'sidewalk' in fw:
        return 'sidewalk'
    if 'crossing' in fw or 'crossing' in hw:
        return 'crossing'
    if 'pedestrian' in hw:
        return 'mall'
    if set(hw) & {'footway', 'path', 'steps', 'cycleway', 'corridor', 'bridleway'}:
        return 'path'
    return 'other'


def crossing_of(d):
    c = vals(d.get('crossing')) + vals(d.get('crossing:signals'))
    if 'traffic_signals' in c or 'yes' in vals(d.get('crossing:signals')):
        return 'signal'
    if 'zebra' in c:
        return 'zebra'
    return 'uncontrolled'


def bearing(x1, y1, x2, y2):
    return math.degrees(math.atan2(y2 - y1, x2 - x1)) % 360


def adiff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--area', default='cbd')
    ap.add_argument('--raw', default=os.path.join(MOD, 'raw'))
    ap.add_argument('--from', dest='d_from', default='2026-08-01')
    ap.add_argument('--to', dest='d_to', default='2026-09-27')
    a = ap.parse_args()
    out_dir = os.path.join(MOD, 'public', a.area)
    need = [os.path.join(a.raw, f) for f in ('osm_walk.graphml', 'peds.csv', 'ped_sensors.csv')] + [os.path.join(out_dir, 'network.json')]
    miss = [p for p in need if not os.path.exists(p)]
    if miss:
        print('❌ missing %s' % miss); sys.exit(1)
    net = json.load(open(os.path.join(out_dir, 'network.json'), encoding='utf-8'))
    s, w, n, e = net['bbox']
    P = Proj((s + n) / 2, (w + e) / 2)

    # ---- walking network ----
    G = ox.load_graphml(os.path.join(a.raw, 'osm_walk.graphml'))
    # Indoor corridors, parking aisles and driveways: roadworks do not affect them and they are not pedestrian detours; dropping them keeps peds.json under 2 MB
    G.remove_edges_from([(u, v, k) for u, v, k, d in G.edges(keys=True, data=True)
                         if 'corridor' in vals(d.get('highway')) or set(vals(d.get('service'))) & DROP_SERVICE])
    G.remove_nodes_from([x for x in list(G.nodes) if G.degree(x) == 0])
    for _, _, d in G.edges(data=True):
        d['kind'] = kind_of(d)
    G = ox.simplify_graph(G, edge_attrs_differ=['kind'])
    U = ox.convert.to_undirected(G)
    U.remove_edges_from([(u, v, k) for u, v, k in U.edges(keys=True) if u == v])
    before = U.number_of_nodes()
    U = U.subgraph(max(nx.connected_components(U), key=len)).copy()

    # Roadway index: stored per segment (link id, bearing)
    segs, meta = [], []
    for l in net['links']:
        pts = [P.xy(*p) for p in l['geometry']]
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            if (x1, y1) != (x2, y2):
                segs.append(LineString([(x1, y1), (x2, y2)])); meta.append((l['id'], bearing(x1, y1, x2, y2), x1, y1))
    tree = STRtree(segs)
    road = {l['id']: l for l in net['links']}

    def attach(geom_xy, kind):
        """-> (road_link, side)"""
        line = LineString(geom_xy)
        mid = line.interpolate(0.5, normalized=True)
        (x1, y1), (x2, y2) = geom_xy[0], geom_xy[-1]
        b = bearing(x1, y1, x2, y2)
        best = None
        for i in tree.query(mid, predicate='dwithin', distance=ROAD_M):
            lid, sb, sx, sy = meta[i]
            para = min(adiff(b, sb), adiff(b, (sb + 180) % 360))
            if kind == 'crossing':
                if para < 90 - PARALLEL:  # a crossing must be roughly perpendicular to the roadway
                    continue
            elif para > PARALLEL:
                continue
            dd = segs[i].distance(mid)
            if best is None or dd < best[0]:
                best = (dd, i)
        if best is None:
            return None, None
        lid, sb, sx, sy = meta[best[1]]
        if kind == 'crossing':
            return lid, None
        # cross product > 0: the sidewalk is to the left of this roadway segment
        ex, ey = math.cos(math.radians(sb)), math.sin(math.radians(sb))
        left = ex * (mid.y - sy) - ey * (mid.x - sx) > 0
        if left:
            return lid, 'left'
        rev = [l['id'] for l in net['links'] if l['from'] == road[lid]['to'] and l['to'] == road[lid]['from']]
        return (rev[0], 'left') if rev else (lid, 'right')

    nodes_out, links_out, wl_geom = [], [], {}
    for nid, d in sorted(U.nodes(data=True)):
        nodes_out.append({'id': 'w%s' % nid, 'lat': round(d['y'], 6), 'lon': round(d['x'], 6)})
    for u, v, k, d in sorted(U.edges(keys=True, data=True), key=lambda x: (min(x[0], x[1]), max(x[0], x[1]), x[2])):
        a_, b_ = (u, v) if u <= v else (v, u)
        geom = d.get('geometry') or LineString([(U.nodes[u]['x'], U.nodes[u]['y']), (U.nodes[v]['x'], U.nodes[v]['y'])])
        coords = list(geom.coords)
        if (round(coords[0][0], 7), round(coords[0][1], 7)) != (round(U.nodes[a_]['x'], 7), round(U.nodes[a_]['y'], 7)):
            coords = coords[::-1]
        xy = [P.xy(la, lo) for lo, la in coords]
        kind = first(d.get('kind')) if not isinstance(d.get('kind'), list) else ('crossing' if 'crossing' in d['kind'] else d['kind'][0])
        rl, side = attach(xy, kind) if kind in ('sidewalk', 'other', 'crossing') else (None, None)
        lid = 'wl%s_%s' % (a_, b_) + ('_%d' % k if k else '')
        links_out.append({'id': lid, 'a': 'w%s' % a_, 'b': 'w%s' % b_, 'len_m': round(float(d['length']), 1), 'kind': kind,
                          'crossing': crossing_of(d) if kind == 'crossing' else None, 'road_link': rl, 'side': side,
                          'geometry': [[round(la, 5), round(lo, 5)] for lo, la in LineString(coords).simplify(SIMPLIFY_DEG).coords]})
        wl_geom[lid] = LineString(xy)
    walk = {'version': 1, 'area': a.area, 'bbox': net['bbox'],
            'sources': ['© OpenStreetMap contributors (ODbL)'],
            'assumptions': {'road_m': ROAD_M, 'parallel_deg': PARALLEL, 'side_rule': 'Australia drives on the left: a sidewalk is attached to the direction of travel it lies to the left of'},
            'nodes': nodes_out, 'links': links_out}

    # ---- pedestrian volumes ----
    sensors = {}
    for r in csv.DictReader(open(os.path.join(a.raw, 'ped_sensors.csv'), encoding='utf-8-sig'), delimiter=';'):
        try:
            la, lo = float(r['latitude']), float(r['longitude'])
        except ValueError:
            continue
        if s <= la <= n and w <= lo <= e:
            sensors[r['location_id']] = {'id': r['location_id'], 'name': r['sensor_name'], 'lat': la, 'lon': lo}
    acc = collections.defaultdict(lambda: {'wd': [[0, 0] for _ in range(24)], 'we': [[0, 0] for _ in range(24)]})
    days = {'wd': set(), 'we': set()}
    for r in csv.DictReader(open(os.path.join(a.raw, 'peds.csv'), encoding='utf-8-sig'), delimiter=';'):
        sid, day = r['location_id'], r['sensing_date'][:10]
        if sid not in sensors or not (a.d_from <= day <= a.d_to) or day in HOLIDAYS:
            continue
        k = 'we' if datetime.date.fromisoformat(day).weekday() >= 5 else 'wd'
        days[k].add(day)
        c = acc[sid][k][int(r['hourday']) % 24]
        c[0] += int(r['pedestriancount']); c[1] += 1
    prof = {}
    for sid, byk in acc.items():
        pr = {k: [t / c if c else None for t, c in byk[k]] for k in ('wd', 'we')}
        if all(x is not None for k in pr for x in pr[k]):
            prof[sid] = pr
    walk_tree_ids = [x['id'] for x in links_out if x['kind'] in ('sidewalk', 'mall', 'other', 'path')]
    wtree = STRtree([wl_geom[i] for i in walk_tree_ids])
    sens_out, flows, method = [], {'wd': {}, 'we': {}}, {}
    link_by = {x['id']: x for x in links_out}
    for sid, sv in sorted(sensors.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
        if sid not in prof:
            continue
        pt = Point(*P.xy(sv['lat'], sv['lon']))
        cand = sorted(((wl_geom[walk_tree_ids[i]].distance(pt), walk_tree_ids[i]) for i in wtree.query(pt, predicate='dwithin', distance=SENSOR_M)),
                      key=lambda t: (link_by[t[1]]['kind'] != 'sidewalk', t[0]))
        wl = cand[0][1] if cand else None
        sens_out.append({'id': sid, 'name': sv['name'], 'lat': round(sv['lat'], 6), 'lon': round(sv['lon'], 6),
                         'walk_link': wl, 'road_link': link_by[wl]['road_link'] if wl else None})
        if wl and wl not in method:
            for k in ('wd', 'we'):
                flows[k][wl] = prof[sid][k]
            method[wl] = 'sensor'
    # same-street interpolation
    placed = [x for x in sens_out if x['walk_link']]
    street_of = lambda wl: (road.get(link_by[wl]['road_link']) or {}).get('name') if link_by[wl]['road_link'] else None
    by_street = collections.defaultdict(list)
    for x in placed:
        nm = street_of(x['walk_link'])
        if nm:
            by_street[nm].append(x)
    for lid, x in link_by.items():
        if lid in method or x['kind'] not in ('sidewalk', 'other', 'crossing'):
            continue
        nm = street_of(lid)
        if not nm or nm not in by_street:
            continue
        mid = wl_geom[lid].interpolate(0.5, normalized=True)
        best = min(by_street[nm], key=lambda sx: mid.distance(Point(*P.xy(sx['lat'], sx['lon']))))
        if mid.distance(Point(*P.xy(best['lat'], best['lon']))) <= STREET_M:
            for k in ('wd', 'we'):
                flows[k][lid] = prof[best['id']][k]
            method[lid] = 'street_interp'
    # road-class defaults
    by_cls = collections.defaultdict(list)
    for x in placed:
        rl = link_by[x['walk_link']]['road_link']
        by_cls[road[rl]['highway'] if rl else None].append(x['id'])
    all_ids = [x['id'] for x in placed]
    med = lambda ids, k, h, q=0.5: sorted(prof[i][k][h] for i in ids)[int(q * (len(ids) - 1))]
    for lid, x in link_by.items():
        if lid in method:
            continue
        cls = road[x['road_link']]['highway'] if x['road_link'] else None
        ids, q = (by_cls[cls], 0.5) if cls and len(by_cls.get(cls, [])) >= 3 else (all_ids, 0.5 if cls else 0.25)
        for k in ('wd', 'we'):
            flows[k][lid] = [med(ids, k, h, q) for h in range(24)]
        method[lid] = 'class_default'
    n_meas = sum(1 for m in method.values() if m == 'sensor')
    peds = {'version': 1, 'unit': 'ped/h',
            'period': '%s..%s (excluding the public holiday %s)' % (a.d_from, a.d_to, ', '.join(sorted(HOLIDAYS))),
            'days_used': {k: len(v) for k, v in days.items()},
            'sources': ['City of Melbourne Pedestrian Counting System (CC BY)'],
            'assumptions': {'sensor_m': SENSOR_M, 'street_m': STREET_M,
                            'class_default': 'median of sensors on the adjacent road class; links not beside a roadway take the 25th percentile of all sensors'},
            'sensors': sens_out,
            'days': {k: {lid: [round(v) for v in flows[k][lid]] for lid in link_by} for k in ('wd', 'we')},
            'method': {lid: method[lid] for lid in link_by},
            'coverage': {'links': len(link_by), 'measured': n_meas, 'estimated': len(link_by) - n_meas}}

    for name, obj in (('walk.json', walk), ('peds.json', peds)):
        with open(os.path.join(out_dir, name), 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    cnt = collections.Counter(x['kind'] for x in links_out)
    mc = collections.Counter(method.values())
    print('✅ walk.json: %d nodes (%d disconnected removed), %d links (%s); %d attached to a roadway; %d KB'
          % (len(nodes_out), before - len(nodes_out), len(links_out), ', '.join('%s %d' % kv for kv in cnt.most_common()),
             sum(1 for x in links_out if x['road_link']), os.path.getsize(os.path.join(out_dir, 'walk.json')) // 1024))
    print('✅ peds.json: %d sensors (%d attached to a sidewalk); %s; %d weekdays, %d weekend days; %d KB'
          % (len(sens_out), len(placed), ', '.join('%s %d' % kv for kv in mc.most_common()), len(days['wd']), len(days['we']),
             os.path.getsize(os.path.join(out_dir, 'peds.json')) // 1024))


if __name__ == '__main__':
    main()
