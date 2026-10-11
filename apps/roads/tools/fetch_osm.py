#!/usr/bin/env python3
"""Purpose: download the drivable road network (unsimplified) and tram tracks inside the bbox from OpenStreetMap into raw/ for build_network.py.

Usage:
  apps/roads/.venv/bin/python apps/roads/tools/fetch_osm.py [--bbox S,W,N,E] [--out raw/]
      -> raw/osm_drive.graphml (raw network, keeps tags such as lanes:forward / cycleway*)
      -> raw/osm_tram.geojson (railway=tram lines)
  apps/roads/.venv/bin/python apps/roads/tools/fetch_osm.py --walk [--overpass https://overpass.kumi.systems/api]
      -> raw/osm_walk.graphml (walking network, unsimplified, keeps footway / crossing tags)
Exit code: 0 success; 1 Overpass request failed
Dependencies: osmnx 2.x (`python3 -m venv apps/roads/.venv && apps/roads/.venv/bin/pip install osmnx`)
Data licence: ODbL; pages must show "© OpenStreetMap contributors".
Gotcha: the OSMnx 2.x bbox order is (west, south, east, north), unlike this repo's --bbox order (south, west, north, east).
"""
import argparse, os, sys, warnings

warnings.filterwarnings('ignore')
import osmnx as ox

DEFAULT_BBOX = (-37.8235, 144.9480, -37.8060, 144.9760)
EXTRA_WAY_TAGS = ['lanes:forward', 'lanes:backward', 'cycleway', 'cycleway:left', 'cycleway:right',
                  'cycleway:both', 'maxspeed', 'oneway']
WALK_WAY_TAGS = ['footway', 'sidewalk', 'crossing', 'foot', 'crossing:signals']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', default=','.join(map(str, DEFAULT_BBOX)), help='south,west,north,east')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'raw'))
    ap.add_argument('--walk', action='store_true', help='download only the walking network -> raw/osm_walk.graphml (for build_walk.py)')
    ap.add_argument('--overpass', help='use another Overpass server, e.g. https://overpass.kumi.systems/api (when the main server refuses connections)')
    a = ap.parse_args()
    s, w, n, e = (float(x) for x in a.bbox.split(','))
    os.makedirs(a.out, exist_ok=True)
    ox.settings.cache_folder = os.path.join(a.out, 'osm_cache')  # defaults to cache/ in the current directory, which would land outside the module
    if a.overpass:
        ox.settings.overpass_url = a.overpass
    ox.settings.requests_timeout = 300  # the walking network is much larger than the drive network; mirrors time out at the default 180 s
    ox.settings.useful_tags_way = sorted(set(ox.settings.useful_tags_way) | set(EXTRA_WAY_TAGS) | set(WALK_WAY_TAGS))
    ox.settings.useful_tags_node = sorted(set(ox.settings.useful_tags_node) | {'highway', 'crossing'})
    if a.walk:
        try:
            W = ox.graph_from_bbox((w, s, e, n), network_type='walk', simplify=False, retain_all=True)
        except Exception as ex:
            print('❌ Overpass request failed: %s (try --overpass to switch servers)' % ex); sys.exit(1)
        wp = os.path.join(a.out, 'osm_walk.graphml')
        ox.save_graphml(W, wp)
        print('✅ walking network: %d nodes, %d edges → %s' % (W.number_of_nodes(), W.number_of_edges(), wp))
        return
    try:
        # Do not simplify or cut to the largest component here: build_network.py decides how to simplify and trim
        G = ox.graph_from_bbox((w, s, e, n), network_type='drive', simplify=False, retain_all=True)
        trams = ox.features_from_bbox((w, s, e, n), {'railway': 'tram'})
    except Exception as ex:  # Overpass timeout / rate limit
        print('❌ Overpass request failed: %s' % ex); sys.exit(1)
    gp = os.path.join(a.out, 'osm_drive.graphml')
    ox.save_graphml(G, gp)
    trams = trams[trams.geometry.geom_type.isin(['LineString', 'MultiLineString'])][['geometry']]
    tp = os.path.join(a.out, 'osm_tram.geojson')
    trams.to_file(tp, driver='GeoJSON')
    print('✅ road network: %d nodes, %d directed edges → %s' % (G.number_of_nodes(), G.number_of_edges(), gp))
    print('✅ tram tracks: %d lines → %s' % (len(trams), tp))


if __name__ == '__main__':
    main()
