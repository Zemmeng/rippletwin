#!/usr/bin/env python3
"""Purpose: download hourly historical weather for the Melbourne CBD (Open-Meteo archive, ecmwf_ifs) -> public/<area>/weather_hourly.json.

Usage: python3 apps/roads/tools/fetch_weather.py [--from 2026-08-01 --to 2026-09-27] [--area cbd]
      without --from / --to, the window runs from the earliest to the latest day of traffic data in raw/ (SCATS cbd_VSDATA_*.csv, pedestrian peds.csv),
      so the weather covers every day that has traffic data; the traffic data coverage is recorded in the output's traffic_days
Exit code: 0 success; 1 request failed or the hour count does not match
Dependencies: Python standard library only. Free, no key.
Data licence: CC BY 4.0, attribution "Weather data by Open-Meteo.com" (https://open-meteo.com/).
Gotchas (tested 30 Sep):
  - always pass models=ecmwf_ifs: visibility from the default model is all null
  - the returned grid point is -37.786, 144.940, about 3 km north-west of the CBD, not the requested coordinates
  - times are local without a timezone offset; this whole window is UTC+10 (daylight saving starts on 4 Oct)
  - precipitation at time T covers the hour before T (Open-Meteo documentation; see backtest_weather.py for alignment to SCATS hours)
"""
import argparse, csv, datetime, glob, json, os, re, sys, urllib.parse, urllib.request

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://archive-api.open-meteo.com/v1/archive'
LAT, LON = -37.8136, 144.9631   # Melbourne CBD (requested coordinates; the returned grid point is in the output's grid)
VARS = ['precipitation', 'rain', 'temperature_2m', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code', 'visibility']


def traffic_days(raw):
    """-> {'scats': [dates...], 'peds': [dates...]}, read from the files actually present in raw/"""
    scats = sorted('%s-%s-%s' % (m[:4], m[4:6], m[6:]) for m in
                   (re.search(r'(\d{8})', os.path.basename(p)).group(1) for p in glob.glob(os.path.join(raw, 'cbd_VSDATA_*.csv'))))
    peds = set()
    pp = os.path.join(raw, 'peds.csv')
    if os.path.exists(pp):
        peds = {r['sensing_date'][:10] for r in csv.DictReader(open(pp, encoding='utf-8-sig'), delimiter=';')}
    return {'scats': scats, 'peds': sorted(peds)}


def gaps(days):
    if not days:
        return []
    d0, d1 = datetime.date.fromisoformat(days[0]), datetime.date.fromisoformat(days[-1])
    have = set(days)
    return [(d0 + datetime.timedelta(i)).isoformat() for i in range((d1 - d0).days + 1) if (d0 + datetime.timedelta(i)).isoformat() not in have]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='d_from', help='default: earliest day of traffic data')
    ap.add_argument('--to', dest='d_to', help='default: latest day of traffic data')
    ap.add_argument('--area', default='cbd')
    ap.add_argument('--raw', default=os.path.join(MOD, 'raw'))
    a = ap.parse_args()
    td = traffic_days(a.raw)
    alld = sorted(set(td['scats']) | set(td['peds']))
    if not (a.d_from and a.d_to):
        if not alld:
            print('❌ no traffic data in raw/: pass --from / --to, or run fetch_scats.py --range first'); sys.exit(1)
        a.d_from, a.d_to = a.d_from or alld[0], a.d_to or alld[-1]
        print('·  window set from traffic data: %s .. %s (SCATS %d days, pedestrians %d days)' % (a.d_from, a.d_to, len(td['scats']), len(td['peds'])))
    q = {'latitude': LAT, 'longitude': LON, 'start_date': a.d_from, 'end_date': a.d_to, 'hourly': ','.join(VARS),
         'timezone': 'Australia/Melbourne', 'models': 'ecmwf_ifs'}
    url = API + '?' + urllib.parse.urlencode(q)
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            d = json.load(r)
    except Exception as ex:
        print('❌ Open-Meteo request failed: %s' % ex); sys.exit(1)
    h = d['hourly']
    days = (datetime.date.fromisoformat(a.d_to) - datetime.date.fromisoformat(a.d_from)).days + 1
    if len(h['time']) != days * 24:
        print('❌ hour count %d ≠ %d days × 24 (does the window cross a daylight-saving change?)' % (len(h['time']), days)); sys.exit(1)
    nulls = {v: sum(1 for x in h[v] if x is None) for v in VARS}
    out = {
        'version': 1,
        'window': [a.d_from, a.d_to],
        'source': 'Open-Meteo Historical Weather API, model ecmwf_ifs',
        'licence': 'CC BY 4.0',
        'attribution': 'Weather data by Open-Meteo.com (https://open-meteo.com/)',
        'request': {'latitude': LAT, 'longitude': LON, 'url': url},
        'grid': {'latitude': d['latitude'], 'longitude': d['longitude'], 'elevation_m': d.get('elevation')},
        'timezone': d['timezone'], 'utc_offset_s': d['utc_offset_seconds'],
        'units': {v: d['hourly_units'][v] for v in VARS},
        'notes': ['time is local time without a timezone offset', 'precipitation / rain at time T covers the hour before T (Open-Meteo documentation)',
                  'the grid point is about 3 km north-west of the CBD; model rain timing is unreliable, so check wet days against BoM daily rainfall'],
        'nulls': nulls,
        'traffic_days': {  # traffic data actually present in raw/ when the weather was fetched
            'scats': {'from': td['scats'][0] if td['scats'] else None, 'to': td['scats'][-1] if td['scats'] else None,
                      'n_days': len(td['scats']), 'missing': gaps(td['scats'])},
            'peds': {'from': td['peds'][0] if td['peds'] else None, 'to': td['peds'][-1] if td['peds'] else None,
                     'n_days': len(td['peds']), 'missing': gaps(td['peds'])},
            'not_covered_by_weather': [d for d in alld if not (a.d_from <= d <= a.d_to)],
        },
        'hourly': {'time': h['time'], **{v: h[v] for v in VARS}},
    }
    d_out = os.path.join(MOD, 'public', a.area)
    os.makedirs(d_out, exist_ok=True)
    p = os.path.join(d_out, 'weather_hourly.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    wet = sum(1 for x in h['precipitation'] if x is not None and x >= 0.1)
    rain = sum(1 for x in h['precipitation'] if x is not None and x >= 1)
    print('✅ weather_hourly.json: %d hours (%d days), grid point %.4f, %.4f; %d hours with precipitation ≥ 0.1 mm/h, %d hours ≥ 1 mm/h; missing values %s; %d KB'
          % (len(h['time']), days, d['latitude'], d['longitude'], wet, rain, {k: v for k, v in nulls.items() if v}, os.path.getsize(p) // 1024))


if __name__ == '__main__':
    main()
