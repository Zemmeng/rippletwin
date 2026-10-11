#!/usr/bin/env python3
"""Purpose: compute the junction's hourly demand profile from raw open data and write public/demand/demand_2921.json.

Usage:
  python3 apps/sim/tools/build_demand.py --scats <cbd_volume.csv> --ped <cbd_pedestrian_hourly.csv> \
      --sensors <sensor_locations.csv> [--out apps/sim/public/demand/demand_2921.json]

Inputs (none are committed; see "Data sources" in apps/sim/README.md for how to download and trim them):
  --scats    DataVic Traffic Signal Volume Data CSV (a subset trimmed to the CBD is fine), columns NB_SCATS_SITE, QT_INTERVAL_COUNT, NB_DETECTOR, V00..V95
  --ped      City of Melbourne Pedestrian Counting System hourly counts CSV, columns location_id, sensing_date, hourday, direction_1, direction_2
  --sensors  sensor locations CSV, used to record what direction_1 / direction_2 mean for each sensor
Output: {scats: {key: {wd: [24 hourly means], we: [...]}}, ped: {key: {wd: [[direction 1, direction 2] × 24], we: ...}}, ped_dirs: {...}}
  wd = Monday to Friday, we = Saturday and Sunday; negative values (detector faults) count as missing and are left out of the means.
Exit code: 0 success; 1 the input has no rows for site 2921
"""
import argparse, csv, datetime, json, sys

SITE = '2921'  # Swanston St / La Trobe St
HOLIDAYS = {'2026-09-25'}  # Victorian public holiday on the Friday before the AFL Grand Final
DET = {  # detector number → stream (from the site 2921 configuration sheet: detector plan on page 2, detector function table on page 4)
    'car_eb': 7, 'car_wb': 5, 'car_sb_left': 3,
    'bike_nb_swanston': 1, 'bike_wb_latrobe': 4,
    'tram_sb_swanston': 11, 'tram_nb_swanston': 13, 'tram_wb_latrobe': 22,
}
PED = {'3': 'ped_swanston_west', '66': 'ped_swanston_east', '62': 'ped_latrobe_north_w', '187': 'ped_latrobe_north_e'}


def kind(date):
    return 'we' if datetime.date.fromisoformat(date).weekday() >= 5 else 'wd'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scats', required=True)
    ap.add_argument('--ped', required=True)
    ap.add_argument('--sensors', required=True)
    ap.add_argument('--out', default='apps/sim/public/demand/demand_2921.json')
    a = ap.parse_args()

    inv = {v: k for k, v in DET.items()}
    acc = {k: {'wd': [[0, 0] for _ in range(24)], 'we': [[0, 0] for _ in range(24)]} for k in DET}
    rows = 0
    for r in csv.reader(open(a.scats, encoding='utf-8-sig')):
        if r[0] != SITE or not r[2].isdigit() or int(r[2]) not in inv or r[1] in HOLIDAYS:
            continue
        rows += 1
        v = [int(x) for x in r[3:99]]
        for h in range(24):
            q = v[h * 4:h * 4 + 4]
            if all(x >= 0 for x in q):
                c = acc[inv[int(r[2])]][kind(r[1])][h]
                c[0] += sum(q); c[1] += 1
    if not rows:
        print('❌ %s has no data for site %s' % (a.scats, SITE)); sys.exit(1)
    out = {'scats': {k: {d: [round(s / n, 1) if n else None for s, n in acc[k][d]] for d in ('wd', 'we')} for k in acc}}

    pacc = {v: {d: [[0, 0, 0] for _ in range(24)] for d in ('wd', 'we')} for v in PED.values()}
    for r in csv.DictReader(open(a.ped, encoding='utf-8-sig')):
        if r['location_id'] not in PED or r['sensing_date'] in HOLIDAYS:
            continue
        c = pacc[PED[r['location_id']]][kind(r['sensing_date'])][int(r['hourday'])]
        c[0] += int(r['direction_1']); c[1] += int(r['direction_2']); c[2] += 1
    out['ped'] = {k: {d: [[round(x / n, 1), round(y / n, 1)] if n else None for x, y, n in pacc[k][d]] for d in ('wd', 'we')} for k in pacc}
    sensors = {s['location_id']: s for s in csv.DictReader(open(a.sensors, encoding='utf-8-sig'))}
    out['ped_dirs'] = {PED[k]: [sensors[k]['direction_1'], sensors[k]['direction_2'], sensors[k]['sensor_description']] for k in PED}
    json.dump(out, open(a.out, 'w'))
    print('✅ wrote %s (%d SCATS rows)' % (a.out, rows))


if __name__ == '__main__':
    main()
