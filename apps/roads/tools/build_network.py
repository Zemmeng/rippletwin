#!/usr/bin/env python3
"""Purpose: turn the OSM network and SCATS site list in raw/ into public/<area>/network.json and signals.json (format: PRD section 5).

Usage:
  apps/roads/.venv/bin/python apps/roads/tools/build_network.py [--bbox S,W,N,E] [--area cbd]
Prerequisites: run tools/fetch_osm.py (raw/osm_drive.graphml, raw/osm_tram.geojson)
      and tools/fetch_scats.py --sites (raw/victorian_traffic_signals.csv) first
Exit code: 0 success; 1 raw input files missing
Method:
  1. On the unsimplified network, compute per segment the lanes in this direction, the speed limit and whether there is a bike lane (OSM tags are per way and become lists after simplification)
  2. Simplify to junction-to-junction links: lanes take the minimum (bottleneck), free-flow times are summed, and a link has a bike lane if more than half its length does
  3. Keep only the largest strongly connected component: dead ends at the bbox edge that cannot be driven out of would leave the engine without a detour
  4. Snap each SCATS site to the nearest node within 30 m; links whose end node has a signal within 30 m (SCATS junction / pedestrian signal, or OSM traffic_signals) get capacity at a 0.5 green ratio
  5. Trams: a link is tagged tram when more than half its length lies within 12 m of tram track
"""
import argparse, csv, datetime, json, math, os, sys, warnings
from zoneinfo import ZoneInfo

warnings.filterwarnings('ignore')
import networkx as nx
import osmnx as ox

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BBOX = (-37.8235, 144.9480, -37.8060, 144.9760)
SAT_FLOW = 1800          # saturation flow per lane per hour (vehicles)
GREEN_SIGNAL = 0.5       # green ratio when the end node is a signalised junction
GREEN_FREE = 0.9         # reduction factor when the end node is not signalised
DEFAULT_SPEED = 40       # common CBD speed limit
MATCH_M = 30             # maximum distance when snapping a signal to a node
TRAM_M = 12              # how close to tram track counts as "this road carries trams"
SIMPLIFY_DEG = 0.00003   # polyline simplification tolerance (about 3 m), to keep network.json under 500 KB
BIKE_VALUES = {'lane', 'track', 'separate', 'opposite_lane', 'opposite_track'}
HW_RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']
SIGNAL_TYPES = {'INT', 'POS'}  # FLASH PX is a flashing-amber pedestrian crossing, not reduced like a signal


def first(v):
    return v[0] if isinstance(v, list) else v


def as_int(v):
    """OSM lanes may be '2', '2;3' or a list; return the first positive integer that parses."""
    for x in (v if isinstance(v, list) else [v]):
        try:
            n = int(str(x).split(';')[0].strip())
            if n >= 1:
                return n
        except (ValueError, TypeError):
            pass
    return None


def as_speed(v):
    for x in (v if isinstance(v, list) else [v]):
        try:
            s = float(str(x).split(';')[0].split()[0])
            if 5 <= s <= 110:
                return s
        except (ValueError, TypeError, IndexError):
            pass
    return None


def best_highway(v):
    vals = [x.replace('_link', '') for x in (v if isinstance(v, list) else [v]) if isinstance(x, str)]
    return min(vals, key=lambda x: HW_RANK.index(x) if x in HW_RANK else 99) if vals else 'unclassified'


def default_lanes(hw):
    return 2 if best_highway(hw) in ('primary', 'secondary', 'trunk', 'motorway') else 1


def truthy(v):
    return str(first(v)).lower() in ('true', 'yes', '1')


def annotate_segments(G):
    """On the unsimplified graph, write per segment: dir_lanes (lanes in this direction), t0 (seconds), bike_len (length with a bike lane)."""
    for u, v, d in G.edges(data=True):
        oneway, rev = truthy(d.get('oneway')), truthy(d.get('reversed'))
        lanes = None
        if oneway:
            lanes = as_int(d.get('lanes'))
        else:
            lanes = as_int(d.get('lanes:backward' if rev else 'lanes:forward'))
            if lanes is None and as_int(d.get('lanes')):
                lanes = math.ceil(as_int(d.get('lanes')) / 2)
        d['dir_lanes'] = lanes or default_lanes(d.get('highway'))
        spd = as_speed(d.get('maxspeed')) or DEFAULT_SPEED
        d['t0'] = d['length'] / (spd / 3.6)
        # Australia drives on the left: forward traffic is on the way's left side, reverse on the right; one-way roads count both sides
        sides = ['cycleway', 'cycleway:both']
        sides += ['cycleway:left', 'cycleway:right'] if oneway else (['cycleway:right'] if rev else ['cycleway:left'])
        bike = any(str(first(d.get(k))) in BIKE_VALUES for k in sides)
        d['bike_len'] = d['length'] if bike else 0.0


def load_sites(path, bbox):
    s, w, n, e = bbox
    out = []
    for r in csv.DictReader(open(path, encoding='utf-8-sig')):
        try:
            la, lo = float(r['LATITUDE']), float(r['LONGITUDE'])
        except ValueError:
            continue
        if s <= la <= n and w <= lo <= e:
            out.append({'site': r['SITE_NO'].strip(), 'name': r['SITE_NAME'].strip(), 'type': r['TYPE'].strip(), 'lat': la, 'lon': lo})
    return out


def dist_m(la1, lo1, la2, lo2):
    k = 111320.0
    return math.hypot((la1 - la2) * k, (lo1 - lo2) * k * math.cos(math.radians((la1 + la2) / 2)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', default=','.join(map(str, DEFAULT_BBOX)), help='south,west,north,east')
    ap.add_argument('--area', default='cbd')
    ap.add_argument('--raw', default=os.path.join(MOD, 'raw'))
    a = ap.parse_args()
    bbox = tuple(float(x) for x in a.bbox.split(','))
    need = ['osm_drive.graphml', 'osm_tram.geojson', 'victorian_traffic_signals.csv']
    miss = [f for f in need if not os.path.exists(os.path.join(a.raw, f))]
    if miss:
        print('❌ raw/ is missing %s: run tools/fetch_osm.py and tools/fetch_scats.py --sites first' % miss); sys.exit(1)

    G = ox.load_graphml(os.path.join(a.raw, 'osm_drive.graphml'))
    osm_signals = [(d['y'], d['x']) for _, d in G.nodes(data=True) if d.get('highway') == 'traffic_signals']
    annotate_segments(G)
    S = ox.simplify_graph(G, edge_attr_aggs={'length': sum, 't0': sum, 'dir_lanes': min, 'bike_len': sum})
    S.remove_edges_from([(u, v, k) for u, v, k in S.edges(keys=True) if u == v])
    before = S.number_of_nodes()
    S = S.subgraph(max(nx.strongly_connected_components(S), key=len)).copy()

    # Trams: compare after projecting to metric coordinates
    import geopandas as gpd
    from shapely.geometry import LineString
    trams = gpd.read_file(os.path.join(a.raw, 'osm_tram.geojson')).to_crs(32755)
    tram_zone = trams.buffer(TRAM_M).unary_union if len(trams) else None

    sites = load_sites(os.path.join(a.raw, 'victorian_traffic_signals.csv'), bbox)
    nodes_xy = {n: (d['y'], d['x']) for n, d in S.nodes(data=True)}
    node_signal, signal_nodes = {}, set()
    for st in sites:  # site -> nearest node
        best = min(nodes_xy, key=lambda n: dist_m(st['lat'], st['lon'], *nodes_xy[n]))
        dm = dist_m(st['lat'], st['lon'], *nodes_xy[best])
        st['node'] = 'n%s' % best if dm <= MATCH_M else None
        st['dist_m'] = round(dm, 1)
    for n, (la, lo) in nodes_xy.items():  # node -> nearest site within 30 m
        near = [(dist_m(la, lo, st['lat'], st['lon']), st) for st in sites]
        near = [x for x in near if x[0] <= MATCH_M]
        if near:
            st = min(near, key=lambda x: x[0])[1]
            node_signal[n] = st['site']
            if st['type'] in SIGNAL_TYPES:
                signal_nodes.add(n)
        if any(dist_m(la, lo, sa, so) <= MATCH_M for sa, so in osm_signals):
            signal_nodes.add(n)

    nodes = [{'id': 'n%s' % n, 'lat': round(la, 6), 'lon': round(lo, 6), 'osm': int(n), 'signal': node_signal.get(n)}
             for n, (la, lo) in sorted(nodes_xy.items())]
    links = []
    for u, v, k, d in sorted(S.edges(keys=True, data=True), key=lambda x: (x[0], x[1], x[2])):
        geom = d.get('geometry') or LineString([(nodes_xy[u][1], nodes_xy[u][0]), (nodes_xy[v][1], nodes_xy[v][0])])
        length = float(d['length']); t0 = float(d['t0'])
        lanes = int(d['dir_lanes'])
        tram = False
        if tram_zone is not None:
            g = gpd.GeoSeries([geom], crs=4326).to_crs(32755).iloc[0]
            tram = g.length > 0 and g.intersection(tram_zone).length / g.length >= 0.5
        name = first(d.get('name'))
        way = first(d.get('osmid'))
        links.append({
            'id': 'l%s_%s' % (u, v) + ('_%d' % k if k else ''), 'from': 'n%s' % u, 'to': 'n%s' % v,
            'name': name if isinstance(name, str) else None, 'highway': best_highway(d.get('highway')),
            'len_m': round(length, 1), 'lanes': lanes, 'speed_kmh': round(length / t0 * 3.6, 1),
            'cap_vph': int(lanes * SAT_FLOW * (GREEN_SIGNAL if v in signal_nodes else GREEN_FREE)),
            't0_s': round(t0, 1), 'tram': bool(tram), 'bike_lane': d['bike_len'] >= 0.5 * length,
            'osm_way': int(way) if way is not None else None,
            'geometry': [[round(y, 5), round(x, 5)] for x, y in geom.simplify(SIMPLIFY_DEG).coords],
        })

    out = os.path.join(MOD, 'public', a.area)
    os.makedirs(out, exist_ok=True)
    now = datetime.datetime.now(ZoneInfo('Australia/Melbourne')).isoformat(timespec='seconds')
    net = {
        'version': 1, 'area': a.area, 'bbox': list(bbox), 'generated': now,
        'sources': ['© OpenStreetMap contributors (ODbL)', 'Victorian traffic signals, DTP (CC BY 4.0)'],
        'assumptions': {'sat_flow_vph_per_lane': SAT_FLOW, 'green_ratio_signal': GREEN_SIGNAL, 'green_ratio_free': GREEN_FREE,
                        'default_speed_kmh': DEFAULT_SPEED, 'signal_match_m': MATCH_M, 'tram_buffer_m': TRAM_M,
                        'speed_kmh_note': 'where a link has several speed limits, this is the time-weighted equivalent speed (len_m / t0_s)'},
        'nodes': nodes, 'links': links,
    }
    with open(os.path.join(out, 'network.json'), 'w', encoding='utf-8') as f:
        json.dump(net, f, ensure_ascii=False, separators=(',', ':'))
    sig = {'version': 1, 'sites': sorted(sites, key=lambda x: int(x['site']) if x['site'].isdigit() else 0)}
    with open(os.path.join(out, 'signals.json'), 'w', encoding='utf-8') as f:
        json.dump(sig, f, ensure_ascii=False, separators=(',', ':'))
    print('✅ network.json: %d nodes (%d after simplification, %d not strongly connected removed), %d links (tram %d, bike lane %d, signalised end %d)'
          % (len(nodes), before, before - len(nodes), len(links), sum(l['tram'] for l in links),
             sum(l['bike_lane'] for l in links), sum(1 for l in links if l['cap_vph'] < l['lanes'] * SAT_FLOW * GREEN_FREE)))
    print('✅ signals.json: %d sites, %d matched to nodes' % (len(sites), sum(1 for s in sites if s['node'])))
    print('   size: network %d KB · signals %d KB' % (os.path.getsize(os.path.join(out, 'network.json')) // 1024,
                                                   os.path.getsize(os.path.join(out, 'signals.json')) // 1024))


if __name__ == '__main__':
    main()
