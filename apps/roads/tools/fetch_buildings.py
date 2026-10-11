#!/usr/bin/env python3
"""Purpose: CBD building footprints + height + use + frontage links -> public/<area>/buildings.json (issue #21).

Usage:
  apps/roads/.venv/bin/python apps/roads/tools/fetch_buildings.py [--bbox S,W,N,E] [--area cbd] [--refresh]
      the first run (or --refresh) downloads building=* from OSM into raw/osm_buildings.gpkg; later runs rebuild from the local file only
Prerequisites: public/<area>/network.json (tools/build_network.py);
      optional raw/com_footprints_2018.geojson (City of Melbourne 2018 building footprints, fills heights missing in OSM; download command in the README)
      optional raw/com_buildings_clue.csv (City of Melbourne CLUE census 2024, fills use and floor count for buildings OSM classes as other; download command in the README)
Height priority: City of Melbourne 2018 measured footprints -> OSM height -> OSM building:levels x 3.2 -> default 12 m (height_src records the source)
      (a different order from issue #21: the height on an OSM outer outline is often only the podium; see the comment in build() and the README)
Exit code: 0 success; 1 every Overpass server failed, or network.json is missing
Dependencies: requests, geopandas and shapely as installed with osmnx 2.x (the download does not go through osmnx)
Data licence: ODbL; pages must show "© OpenStreetMap contributors".
Gotcha: the main Overpass server often refuses connections and mirrors often return 504, so each server is tried once with a hard timeout, in OVERPASS order; progress is printed line by line.
"""
import argparse, os, sys, warnings

warnings.filterwarnings('ignore')

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BBOX = (-37.8235, 144.9480, -37.8060, 144.9760)
M_PER_LEVEL = 3.2        # metres per floor when only the floor count is known
DEFAULT_HEIGHT = 12.0    # when neither OSM nor the City of Melbourne data has a height
FRONTAGE_M = 30          # frontage: maximum distance from the building to a link centreline
FRONTAGE_MAX = 4         # maximum frontage links per building (keeps the file small)
SIMPLIFY_DEG = 0.000005  # footprint simplification, about 0.5 m
TIMEOUT_S = 120          # how long to wait for each Overpass server
KEEP_TAGS = ['name', 'building', 'height', 'building:levels', 'amenity', 'shop', 'office', 'tourism']
# private.coffee and kumi are the same machine (193.219.97.30) and often returned 504 on 29 Sep, so they go last
OVERPASS = ['https://overpass-api.de/api', 'https://maps.mail.ru/osm/tools/overpass/api',
            'https://overpass.private.coffee/api', 'https://overpass.kumi.systems/api']


def fetch(bbox, raw):
    """-> raw/osm_buildings.gpkg. Sends the Overpass request directly; each server is tried once with a hard TIMEOUT_S timeout.
    Not ox.features_from_bbox: it checks /status and waits for the slot the server gives, and retries forever on 504, which looks like a hang."""
    import requests
    import geopandas as gpd
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize, unary_union

    s, w, n, e = bbox
    q = ('[out:json][timeout:%d];(way["building"](%f,%f,%f,%f);relation["building"]["type"="multipolygon"](%f,%f,%f,%f););out tags geom;'
         % (TIMEOUT_S, s, w, n, e, s, w, n, e))
    data = None
    for url in OVERPASS:
        print('·  trying %s (up to %d s)…' % (url, TIMEOUT_S), flush=True)
        try:
            r = requests.post(url + '/interpreter', data={'data': q}, timeout=TIMEOUT_S + 30,
                              headers={'User-Agent': 'hackathon-roads/1.0 (T11 buildings)'})
            if r.status_code != 200:
                print('   HTTP %d, trying the next server' % r.status_code, flush=True); continue
            data = r.json(); break
        except Exception as ex:
            print('   failed: %s, trying the next server' % str(ex)[:120], flush=True)
    if data is None:
        print('❌ every Overpass server failed'); sys.exit(1)
    rows = []
    for el in data.get('elements', []):
        tags = el.get('tags', {})
        if el['type'] == 'way':
            pts = [(g['lon'], g['lat']) for g in el.get('geometry', [])]
            if len(pts) < 4 or pts[0] != pts[-1]:
                continue
            geom = Polygon(pts)
        else:  # multipolygon: join the outer members into rings
            lines = [LineString([(g['lon'], g['lat']) for g in m['geometry']])
                     for m in el.get('members', []) if m.get('role') == 'outer' and len(m.get('geometry', [])) >= 2]
            polys = list(polygonize(unary_union(lines))) if lines else []
            if not polys:
                continue
            geom = unary_union(polys)
        row = {'element': 'way' if el['type'] == 'way' else 'relation', 'id': el['id'], 'geometry': geom}
        row.update({k: tags.get(k) for k in KEEP_TAGS})
        rows.append(row)
    B = gpd.GeoDataFrame(rows, geometry='geometry', crs=4326)
    p = os.path.join(raw, 'osm_buildings.gpkg')
    B.to_file(p, driver='GPKG')
    print('✅ %d OSM buildings (%s) → %s' % (len(B), url, p), flush=True)
    return p


def num(v):
    """'24', '24 m', '24.5;30' -> 24.0; None if it cannot be parsed."""
    try:
        x = float(str(v).split(';')[0].replace('m', '').strip())
        return x if x > 0 else None
    except (ValueError, TypeError):
        return None


def use_of(r):
    """OSM tags -> the use enum from section 5 of issue #21."""
    g = lambda k: str(r.get(k) or '').lower()
    b, am, tour = g('building'), g('amenity'), g('tourism')
    if b == 'parking' or am in ('parking', 'parking_entrance'):
        return 'parking'
    if b == 'hotel' or tour in ('hotel', 'hostel', 'motel', 'apartment', 'guest_house'):
        return 'hotel'
    if b in ('university', 'school', 'college', 'kindergarten') or am in ('university', 'school', 'college', 'kindergarten'):
        return 'education'
    if b in ('civic', 'public', 'government', 'church', 'cathedral', 'chapel', 'hospital', 'train_station', 'transportation',
             'museum', 'library', 'fire_station', 'stadium') \
            or am in ('library', 'townhall', 'courthouse', 'place_of_worship', 'hospital', 'theatre', 'police', 'arts_centre',
                      'community_centre', 'post_office', 'fire_station', 'cinema', 'conference_centre') \
            or tour in ('museum', 'gallery', 'attraction'):
        return 'public'
    if b in ('retail', 'supermarket', 'kiosk', 'shop') or g('shop'):
        return 'retail'
    if b in ('office', 'commercial') or g('office'):
        return 'office'
    if b in ('apartments', 'residential', 'house', 'terrace', 'dormitory', 'semidetached_house', 'detached'):
        return 'residential'
    return 'other'


# City of Melbourne CLUE census predominant_space_use -> use. Matched by keyword (not by full value), first match wins; unmatched values are printed at run time for checking
CLUE_USE = [('parking', ('car park', 'parking')),
            ('hotel', ('hotel', 'hostel', 'serviced apartment', 'motel', 'commercial accommodation')),
            ('education', ('education', 'school', 'university')),
            # Student Accommodation is student housing, so residential (do not let 'student' pull it into education)
            ('residential', ('residential', 'apartment', 'house', 'townhouse', 'dwelling', 'accommodation')),
            ('retail', ('retail', 'shop', 'hospitality', 'restaurant', 'food')),
            ('office', ('office', 'commercial', 'business')),
            ('public', ('community', 'hospital', 'health', 'entertainment', 'recreation', 'cultural', 'public', 'government',
                        'transport', 'worship', 'institutional', 'assembly', 'hall', 'performance', 'conference'))]


def clue_use(v):
    t = str(v or '').lower()
    for use, keys in CLUE_USE:
        if any(k in t for k in keys):
            return use
    return None


def load_clue(raw, xy):
    """raw/com_buildings_clue.csv (latest census year, inside the bbox) -> [(Point, use or None, raw value, floors above ground)]; [] if the file is absent."""
    import csv
    from shapely.geometry import Point
    p = os.path.join(raw, 'com_buildings_clue.csv')
    if not os.path.exists(p):
        return []
    out = []
    for r in csv.DictReader(open(p, encoding='utf-8-sig'), delimiter=';'):
        try:
            la, lo = float(r['latitude']), float(r['longitude'])
        except (KeyError, ValueError):
            continue
        fl = num(r.get('number_of_floors_above_ground'))
        out.append((Point(*xy(la, lo)), clue_use(r.get('predominant_space_use')), r.get('predominant_space_use') or '', fl))
    return out


def build(bbox, raw, area):
    import json, datetime, math
    from zoneinfo import ZoneInfo
    import geopandas as gpd
    from shapely import STRtree
    from shapely.geometry import LineString, Point, Polygon, box

    np_ = os.path.join(MOD, 'public', area, 'network.json')
    if not os.path.exists(np_):
        print('❌ %s not found: run tools/build_network.py first' % np_); sys.exit(1)
    net = json.load(open(np_, encoding='utf-8'))
    s, w, n, e = bbox
    lat0, lon0 = (s + n) / 2, (w + e) / 2
    k = math.cos(math.radians(lat0))
    xy = lambda la, lo: ((lo - lon0) * 111320 * k, (la - lat0) * 111320)

    B = gpd.read_file(os.path.join(raw, 'osm_buildings.gpkg'))
    B = B[B['element'].isin(['way', 'relation'])]
    area_box = box(w, s, e, n)

    # City of Melbourne 2018 footprints: each row is part of a building; height = highest roof of the parts - the building's ground level (structure_min_elevation)
    com = []
    cp = os.path.join(raw, 'com_footprints_2018.geojson')
    if os.path.exists(cp):
        C = gpd.read_file(cp)
        for g, top, base in zip(C.geometry, C['footprint_max_elevation'], C['structure_min_elevation']):
            if g is not None and top is not None and base is not None and top > base:
                p = g.representative_point()
                com.append((Point(*xy(p.y, p.x)), float(top) - float(base)))
    com_tree = STRtree([c[0] for c in com]) if com else None
    clue = load_clue(raw, xy)
    clue_tree = STRtree([c[0] for c in clue]) if clue else None
    unmapped, use_src = {}, {'osm': 0, 'clue': 0, 'none': 0}

    segs, seg_link = [], []
    for l in net['links']:
        pts = [xy(*q) for q in l['geometry']]
        for a_, b_ in zip(pts, pts[1:]):
            if a_ != b_:
                segs.append(LineString([a_, b_])); seg_link.append(l['id'])
    link_tree = STRtree(segs)

    out, src_cnt = [], {}
    for _, r in B.iterrows():
        geom = r.geometry
        if geom is None or not geom.is_valid and not geom.buffer(0).is_valid:
            continue
        geom = geom if geom.is_valid else geom.buffer(0)
        if not area_box.contains(geom):
            continue  # drop buildings that cross the bbox edge (acceptance requires every point inside the bbox)
        poly = max(geom.geoms, key=lambda x: x.area) if geom.geom_type == 'MultiPolygon' else geom
        poly = Polygon(poly.exterior).simplify(SIMPLIFY_DEG)
        ring = [(round(la, 5), round(lo, 5)) for lo, la in poly.exterior.coords][:-1]
        ring = [p for i, p in enumerate(ring) if i == 0 or p != ring[i - 1]]
        if len(ring) < 3:
            continue
        pxy = Polygon([xy(la, lo) for la, lo in ring])
        levels = num(r.get('building:levels'))
        # Measured municipal heights first: for CBD towers the height on the OSM outer outline is often only the podium (the tower is a separate building:part),
        # e.g. Eureka Tower OSM 20 m, City of Melbourne 298 m (actual about 297 m); Rialto OSM 20 m, City of Melbourne 249 m (actual about 251 m)
        h, src = None, None
        if com_tree is not None:
            hits = [com[i][1] for i in com_tree.query(pxy, predicate='contains')]
            if hits:
                h, src = max(hits), 'com'
        if h is None and num(r.get('height')):
            h, src = num(r.get('height')), 'osm_height'
        if h is None and levels:
            h, src = levels * M_PER_LEVEL, 'osm_levels'
        if h is None:
            h, src = DEFAULT_HEIGHT, 'default'
        h = min(h, 340.0)
        near = {}
        for i in link_tree.query(pxy, predicate='dwithin', distance=FRONTAGE_M):
            d = segs[i].distance(pxy)
            if seg_link[i] not in near or d < near[seg_link[i]]:
                near[seg_link[i]] = d
        frontage = [{'link': lid, 'dist_m': round(d, 1)} for lid, d in sorted(near.items(), key=lambda kv: kv[1])[:FRONTAGE_MAX]]
        name = r.get('name')
        # Use: OSM wins where it can tell; buildings OSM classes as other (e.g. only building=yes) take the census records inside them (most common use if several)
        use = use_of(r)
        if use != 'other':
            use_src['osm'] += 1
        elif clue_tree is not None:
            recs = [clue[i] for i in clue_tree.query(pxy, predicate='contains')]
            mapped = [c[1] for c in recs if c[1]]
            for c in recs:
                if not c[1] and c[2]:
                    unmapped[c[2]] = unmapped.get(c[2], 0) + 1
            if mapped:
                use = max(set(mapped), key=mapped.count); use_src['clue'] += 1
            else:
                use_src['none'] += 1
            if not levels:
                fls = [c[3] for c in recs if c[3]]
                levels = max(fls) if fls else None
        else:
            use_src['none'] += 1
        out.append({'id': '%s%s' % ('w' if r['element'] == 'way' else 'r', int(r['id'])),
                    'name': name if isinstance(name, str) and name else None, 'use': use,
                    'height_m': round(h, 1), 'levels': int(levels) if levels else None, 'height_src': src,
                    'footprint': [list(p) for p in ring], 'frontage': frontage})
        src_cnt[src] = src_cnt.get(src, 0) + 1
    out.sort(key=lambda x: x['id'])
    doc = {'version': 1, 'area': area, 'bbox': list(bbox),
           'generated': datetime.datetime.now(ZoneInfo('Australia/Melbourne')).isoformat(timespec='seconds'),
           'sources': ['© OpenStreetMap contributors (ODbL)', 'City of Melbourne 2018 Building Footprints (CC BY)',
                       'City of Melbourne CLUE Building information, census 2024 (CC BY)'],
           'assumptions': {'m_per_level': M_PER_LEVEL, 'default_height_m': DEFAULT_HEIGHT, 'frontage_m': FRONTAGE_M,
                           'frontage_max': FRONTAGE_MAX, 'simplify_deg': SIMPLIFY_DEG,
                           'com_height': 'City of Melbourne 2018 footprints: max footprint_max_elevation of the parts inside the building − structure_min_elevation'},
           'buildings': out}
    p = os.path.join(MOD, 'public', area, 'buildings.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    uses = {}
    for x in out:
        uses[x['use']] = uses.get(x['use'], 0) + 1
    print('✅ buildings.json: %d buildings; height sources %s; uses %s (from OSM %d, census %d, none %d); %d with frontage links; %d KB'
          % (len(out), src_cnt, uses, use_src['osm'], use_src['clue'], use_src['none'],
             sum(1 for x in out if x['frontage']), os.path.getsize(p) // 1024))
    if unmapped:
        print('·  census use values with no mapping (check CLUE_USE): %s' % sorted(unmapped.items(), key=lambda kv: -kv[1])[:15])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', default=','.join(map(str, DEFAULT_BBOX)), help='south,west,north,east')
    ap.add_argument('--area', default='cbd')
    ap.add_argument('--raw', default=os.path.join(MOD, 'raw'))
    ap.add_argument('--refresh', action='store_true', help='download from OSM again')
    a = ap.parse_args()
    bbox = tuple(float(x) for x in a.bbox.split(','))
    os.makedirs(a.raw, exist_ok=True)
    gp = os.path.join(a.raw, 'osm_buildings.gpkg')
    if a.refresh or not os.path.exists(gp):
        fetch(bbox, a.raw)
    build(bbox, a.raw, a.area)


if __name__ == '__main__':
    main()
