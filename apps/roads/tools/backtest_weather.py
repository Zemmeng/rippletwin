#!/usr/bin/env python3
"""Purpose: real-weather back-test. When it rains in the Melbourne CBD, how much do car, bike and pedestrian volumes actually drop, and how much
does peak capacity fall? The results are compared with the WXP multipliers invented for the page's micro-simulation (apps/web/src/js/4-sim.js:14-20).
Spec: docs/hackathon/specs/T31-weather-backtest-PRD.md.

Usage: python3 apps/roads/tools/backtest_weather.py [--area cbd]
Prerequisites: public/<area>/weather_hourly.json (tools/fetch_weather.py)
      raw/cbd_VSDATA_*.csv (tools/fetch_scats.py --range 2026-08-01..2026-09-27)
      raw/peds.csv (pedestrian counts, the curl command in the README)
      raw/IDCJDW3033.202608.csv, raw/IDCJDW3033.202609.csv (BoM daily observations, **downloaded by hand in a browser**, not scraped and not committed)
Output: public/<area>/weather_backtest.json
Exit code: 0 success; 1 input files missing
Dependencies: Python standard library only.

Definitions (written to the output's classes / method):
  - Time alignment: Open-Meteo precipitation at time T covers the hour before T, so traffic hour h (h:00-h+1:00) uses T = h+1
  - dry: model precipitation 0 in this hour and the previous 2, BoM 24 h rainfall covering this hour < 1 mm, and not fog
  - wet: model precipitation >= 0.1 mm/h; rain: >= 1 mm/h. If the BoM 24 h rainfall covering the hour is < 0.2 mm it is a model false alarm and excluded from wet / rain
  - fog: visibility < 1000 m and no rain (model only; there is no measured visibility to check against)
  - BoM "Rainfall (mm)" runs from 9 am the previous day to 9 am that day: hours before 9 am use that day's row, from 9 am the next day's row
  - Baseline: per detector / counter x **day of week** x hour, the median of dry hours only (>= 3)
    (splitting only by weekday / weekend at first put the placebo test 4-11% low: fully dry days included more Sundays, which are lower than Saturdays; Mondays are also about 6% lower than Tuesday to Thursday)
  - Effect: per day, the baseline-weighted median of log((flow+1)/(baseline+1)), then the mean over days, exponentiated; 95% CI by resampling days (hours within a day are correlated)
  - cells with n_days < 3 get ratio / ci95 = null
"""
import argparse, collections, csv, datetime, glob, json, math, os, random, statistics, sys

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHOOL_HOL = 'Victorian school holidays 21 Sep – 2 Oct 2026 (vic.gov.au)'
EXCLUDED = {
    '2026-09-21': SCHOOL_HOL, '2026-09-22': SCHOOL_HOL, '2026-09-23': SCHOOL_HOL, '2026-09-24': SCHOOL_HOL,
    '2026-09-25': 'public holiday (Friday before AFL Grand Final); ' + SCHOOL_HOL,
    '2026-09-26': 'AFL Grand Final; ' + SCHOOL_HOL,
    '2026-09-27': SCHOOL_HOL,
}
CAR_2921 = {('2921', 3), ('2921', 5), ('2921', 7)}            # checked against the configuration sheet (DET in apps/sim/tools/build_demand.py)
BIKE_2921 = {('2921', 1), ('2921', 2), ('2921', 4), ('2921', 8)}  # bike detectors; detector 6 reads 0 for all 8 weeks (broken)
NOT_CAR_2921 = {1, 2, 4, 6, 8, 11, 13, 22} | set(range(24, 32))   # 2921 bike, tram and pedestrian-button detectors
PED_SENSORS = ['Swa295_T', 'Lat224_T', 'Swa330_T', 'Lon364_T', 'Lon189_T']
LANE_SHARE, MIN_DAILY = 0.5, 300          # lane detector: daily count >= 50% of the junction's busiest detector and >= 300 (as in build_flows.py)
DAY_HOURS = list(range(7, 19))            # daytime 07:00-19:00
PEAK = {'am': [7, 8, 9], 'pm': [16, 17, 18]}
MIN_BASE = {'car': 20, 'car_2921': 20, 'bike': 5, 'ped': 20}   # hours with a baseline below this are skipped (per hour)
N_BOOT, SEED = 2000, 31
N_PLACEBO = 25                 # number of extra random placebo draws
WXP = {  # apps/web/src/js/4-sim.js:14-20 (read only; this tool does not change the page)
    'storm': {'rate': .9, 'T': 1.4}, 'flood': {'rate': .75, 'T': 1.5}, 'fog': {'rate': .85, 'T': 1.7},
    'heat': {'rate': .8, 'T': 1.1}, 'wind': {'rate': .85, 'T': 1.25}}
LIT = {
    'car': 'Melbourne wet-day traffic -1.35%..-3.43% (Keay & Simmonds 2005, AAP 37(1):109-124)',
    'bike': 'Melbourne cyclists: light rain -8..-19%, heavy -13..-25% (Phung & Rose 2007); light rain ~-13%, heavy ~-40% (Ahmed, Rose & Jacob 2010)',
    'ped': 'cold/precipitation < -20% walking (Aultman-Hall, Lane & Lambert 2009, TRR 2140; small US towns, no Melbourne study found)',
    'T': 'signalised saturation flow in rain -2..-21% (FHWA Road Weather Management); heavy rain freeway capacity -10..-17%, low visibility -12% (Agarwal, Maze & Souleyrette 2005)',
    'heat': 'heat raised traffic volumes (Cools, Moons & Wets 2010, Belgium)',
}


def day_of(d, delta):
    return (datetime.date.fromisoformat(d) + datetime.timedelta(days=delta)).isoformat()


def kind(d):
    return 'we' if datetime.date.fromisoformat(d).weekday() >= 5 else 'wd'


# ---------------------------------------------------------------- weather
def load_weather(p):
    w = json.load(open(p, encoding='utf-8'))
    h = w['hourly']
    idx = {t: i for i, t in enumerate(h['time'])}

    def at(var, d, hh):  # value at d hh:00 (hh may be 24 -> midnight the next day, or negative -> the previous day)
        dd, hh2 = d, hh
        while hh2 >= 24:
            dd, hh2 = day_of(dd, 1), hh2 - 24
        while hh2 < 0:
            dd, hh2 = day_of(dd, -1), hh2 + 24
        i = idx.get('%sT%02d:00' % (dd, hh2))
        return None if i is None else h[var][i]
    return w, at


def load_bom(raw):
    """raw/IDCJDW3033.*.csv -> {date: rainfall mm}, {date: maximum gust km/h}, {date: maximum temperature °C}. latin-1; dates are not zero-padded."""
    rain, gust, tmax = {}, {}, {}
    # Accept only the standard file names: repeated browser downloads create copies such as "IDCJDW3033.202608 (1).csv"
    for p in sorted(glob.glob(os.path.join(raw, 'IDCJDW3033.[0-9][0-9][0-9][0-9][0-9][0-9].csv'))):
        rows = list(csv.reader(open(p, encoding='latin-1')))
        hi = next((i for i, r in enumerate(rows) if any('Rainfall (mm)' in c for c in r)), None)
        if hi is None:
            continue
        hdr = rows[hi]
        c_date = next(i for i, c in enumerate(hdr) if c.strip() == 'Date')
        c_rain = next(i for i, c in enumerate(hdr) if 'Rainfall (mm)' in c)
        c_gust = next((i for i, c in enumerate(hdr) if 'Speed of maximum wind gust' in c), None)
        c_tmax = next((i for i, c in enumerate(hdr) if 'Maximum temperature' in c), None)
        for r in rows[hi + 1:]:
            if len(r) <= c_rain or not r[c_date].strip():
                continue
            try:
                y, m, dd = (int(x) for x in r[c_date].strip().split('-'))
            except ValueError:
                continue
            d = datetime.date(y, m, dd).isoformat()
            for store, c in ((rain, c_rain), (gust, c_gust), (tmax, c_tmax)):
                if c is not None and c < len(r):
                    try:
                        store[d] = float(r[c].strip())
                    except ValueError:
                        pass
    return rain, gust, tmax


def classify(at, bom, d, h):
    """-> (set of classes, model precipitation this hour, BoM 24 h rainfall covering this hour, whether it is a model false alarm)"""
    p0, p1, p2 = at('precipitation', d, h + 1), at('precipitation', d, h), at('precipitation', d, h - 1)
    v0, v1 = at('visibility', d, h), at('visibility', d, h + 1)
    b = bom.get(d if h < 9 else day_of(d, 1)) if bom else None
    cls = set()
    if None in (p0, p1, p2):
        return cls, p0, b, False
    fog = v0 is not None and v1 is not None and min(v0, v1) < 1000
    false_alarm = p0 >= 0.1 and b is not None and b < 0.2
    if p0 == p1 == p2 == 0 and (b is None or b < 1) and not fog:
        cls.add('dry')
    if p0 >= 0.1 and not false_alarm:
        cls.add('wet')
        if p0 >= 1:
            cls.add('rain')
    if fog and p0 < 0.1:
        cls.add('fog')
    return cls, p0, b, false_alarm


# ---------------------------------------------------------------- traffic
def load_scats(raw):
    """-> hourly[(site, detector)][(date, hour)] = vehicles; q15[(site, detector)][(date, hour)] = the hour's busiest 15 minutes x 4;
    daily mean[(site, detector)] (weekdays)"""
    hourly, q15 = collections.defaultdict(dict), collections.defaultdict(dict)
    daily = collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(raw, 'cbd_VSDATA_*.csv'))):
        for r in csv.reader(open(p, encoding='utf-8-sig')):
            if not r or not r[2].isdigit():
                continue
            d = r[1][:10]
            key = (r[0], int(r[2]))
            v = [int(x) for x in r[3:99]]
            if kind(d) == 'wd' and d not in EXCLUDED:
                daily[key].append(sum(x for x in v if x >= 0))
            for h in range(24):
                q = v[4 * h:4 * h + 4]
                if min(q) >= 0:  # negative = fault or missing; drop the whole hour
                    hourly[key][(d, h)] = sum(q)
                    q15[key][(d, h)] = max(q) * 4
    return hourly, q15, {k: statistics.mean(x) for k, x in daily.items() if x}


def lane_detectors(daily):
    by_site = collections.defaultdict(dict)
    for (s, det), v in daily.items():
        by_site[s][det] = v
    out = set()
    for s, dets in by_site.items():
        top = max(dets.values())
        for det, v in dets.items():
            if v >= max(MIN_DAILY, LANE_SHARE * top) and not (s == '2921' and det in NOT_CAR_2921):
                out.add((s, det))
    return out


def load_peds(p):
    out = collections.defaultdict(dict)
    for r in csv.DictReader(open(p, encoding='utf-8-sig'), delimiter=';'):
        if r['sensor_name'] in PED_SENSORS:
            out[r['sensor_name']][(r['sensing_date'][:10], int(r['hourday']))] = int(r['pedestriancount'])
    return out


# ---------------------------------------------------------------- statistics
def dow(d):
    return datetime.date.fromisoformat(d).weekday()


def baseline(series, dry_hours, skip_days=()):
    """Per sensor x day of week x hour: median of dry hours (only when there are >= 3)."""
    acc = collections.defaultdict(list)
    for sid, obs in series.items():
        for (d, h), v in obs.items():
            if (d, h) in dry_hours and d not in skip_days:
                acc[(sid, dow(d), h)].append(v)
    return {k: statistics.median(v) for k, v in acc.items() if len(v) >= 3}


def baseline_lists(series, dry_hours):
    acc = collections.defaultdict(list)
    for sid, obs in series.items():
        for (d, h), v in obs.items():
            if (d, h) in dry_hours:
                acc[(sid, dow(d), h)].append((d, v))
    return acc


class LeaveOneDayOut:
    """Serves baselines like a dict, but leaves day d out while day d is being evaluated (for the placebo: as with a real wet day, only that day is missing from the baseline)."""

    def __init__(self, lists):
        self.lists, self.day = lists, None

    def get(self, key):
        xs = [v for dd, v in self.lists.get(key, ()) if dd != self.day]
        return statistics.median(xs) if len(xs) >= 3 else None


def wmedian(xs):
    """Weighted median of [(weight, value)]"""
    xs = sorted(xs, key=lambda t: t[1])
    half, c = sum(w for w, _ in xs) / 2, 0.0
    for w, v in xs:
        c += w
        if c >= half:
            return v
    return xs[-1][1]


def day_effects(series, base, hours, min_base):
    """-> {date: that day's weighted median log ratio}, hours used, sensors used"""
    per_day = collections.defaultdict(list)
    used_h, used_s = set(), set()
    for sid, obs in series.items():
        for (d, h) in sorted(hours):
            if isinstance(base, LeaveOneDayOut):
                base.day = d
            v = obs.get((d, h))
            b = base.get((sid, dow(d), h))
            if v is None or b is None or b < min_base:
                continue
            per_day[d].append((b, math.log((v + 1) / (b + 1))))
            used_h.add((d, h)); used_s.add(sid)
    return {d: wmedian(xs) for d, xs in per_day.items()}, used_h, used_s


def effect(series, base, hours, min_base, rng):
    """hours: the set of (date, hour) to evaluate -> dict (ratio, ci95, n_days, n_hours, n_sensors, note)"""
    per_day, used_h, used_s = day_effects(series, base, hours, min_base)
    days = sorted(per_day)
    out = {'n_days': len(days), 'n_hours': len(used_h), 'n_sensors': len(used_s), 'days': days}
    if len(days) < 3:
        out.update(ratio=None, ci95=None, note='n_days < 3: sample too small')
        return out
    est = lambda ds: math.exp(statistics.mean(per_day[x] for x in ds))
    boots = sorted(est([rng.choice(days) for _ in days]) for _ in range(N_BOOT))
    out.update(ratio=round(est(days), 3), ci95=[round(boots[int(0.025 * N_BOOT)], 3), round(boots[int(0.975 * N_BOOT) - 1], 3)])
    return out


def verdict(current, r):
    if r is None or r.get('ratio') is None:
        return 'no_sample'
    lo, hi = r['ci95']
    if lo <= current <= hi:
        return 'ok'
    if current < lo:
        return 'wrong_direction' if lo > 1 and current < 1 else 'too_strong'
    return 'too_weak'


def fmt(r):
    if r is None or r.get('ratio') is None:
        return 'no sample (n_days %s)' % (r or {}).get('n_days', 0)
    return '%.3f [%.3f, %.3f], %d days' % (r['ratio'], r['ci95'][0], r['ci95'][1], r['n_days'])


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--area', default='cbd')
    ap.add_argument('--raw', default=os.path.join(MOD, 'raw'))
    a = ap.parse_args()
    out_dir = os.path.join(MOD, 'public', a.area)
    wp = os.path.join(out_dir, 'weather_hourly.json')
    need = [wp, os.path.join(a.raw, 'peds.csv')]
    miss = [p for p in need if not os.path.exists(p)] + ([] if glob.glob(os.path.join(a.raw, 'cbd_VSDATA_*.csv')) else ['raw/cbd_VSDATA_*.csv'])
    if miss:
        print('❌ missing %s' % miss); sys.exit(1)
    rng = random.Random(SEED)
    wx, at = load_weather(wp)
    bom, bom_gust, bom_tmax = load_bom(a.raw)
    if not bom:
        print('⚠️  no BoM IDCJDW3033.*.csv in raw/: classifying by model only, wet days cannot be checked (manual download: see the README)')
    d0, d1 = wx['window']
    all_days = [day_of(d0, i) for i in range((datetime.date.fromisoformat(d1) - datetime.date.fromisoformat(d0)).days + 1)]

    # classify every hour
    cls_hours = collections.defaultdict(set)
    false_alarms, info = [], {}
    for d in all_days:
        for h in range(24):
            c, p0, b, fa = classify(at, bom, d, h)
            info[(d, h)] = (p0, b)
            if d in EXCLUDED:
                continue
            for k in c:
                cls_hours[k].add((d, h))
            if fa:
                false_alarms.append('%s %02d' % (d, h))

    hourly, q15, daily = load_scats(a.raw)
    lanes = lane_detectors(daily)
    peds = load_peds(os.path.join(a.raw, 'peds.csv'))
    series = {
        'car': {k: hourly[k] for k in sorted(lanes)},
        'car_2921': {k: hourly[k] for k in sorted(CAR_2921) if k in hourly},
        'bike': {k: hourly[k] for k in sorted(BIKE_2921) if k in hourly},
        'ped': dict(peds),
    }
    dry = cls_hours['dry']
    bases = {m: baseline(s, dry) for m, s in series.items()}

    # effects: class x mode x period
    results = []
    for c in ('wet', 'rain', 'fog'):
        for period in ('day', 'peak'):
            hrs = {(d, h) for (d, h) in cls_hours[c] if h in DAY_HOURS} if period == 'day' else \
                  {(d, h) for (d, h) in cls_hours[c] if kind(d) == 'wd' and h in PEAK['am'] + PEAK['pm']}
            for m, s in series.items():
                r = effect(s, bases[m], hrs, MIN_BASE[m], rng)
                row = {'cls': c, 'mode': m, 'period': period, 'ratio': r['ratio'], 'ci95': r['ci95'],
                       'n_days': r['n_days'], 'n_hours': r['n_hours'], 'n_sensors': r['n_sensors'], 'days': r['days']}
                if c == 'fog':
                    row['model_only'] = True
                if r.get('note'):
                    row['note'] = r['note']
                results.append(row)
    res = {(r['cls'], r['mode'], r['period']): r for r in results}

    # time alignment check: shift precipitation one hour earlier / later and see which gives the strongest wet-day bike effect
    align = {}
    for name, shift in (('T=h (same hour)', 0), ('T=h+1 (used)', 1), ('T=h+2', 2)):
        hrs = set()
        for d in all_days:
            if d in EXCLUDED:
                continue
            for h in DAY_HOURS:
                p = at('precipitation', d, h + shift)
                b = info[(d, h)][1]
                if p is not None and p >= 0.1 and not (b is not None and b < 0.2):
                    hrs.add((d, h))
        r = effect(series['bike'], bases['bike'], hrs, MIN_BASE['bike'], rng)
        align[name] = {'bike_wet_day_ratio': r['ratio'], 'ci95': r['ci95'], 'n_hours': r['n_hours']}

    # capacity proxy (matches WXP.T): busiest 15-minute lane flow in the peak, wet vs dry; an upper bound only (fewer cars and slower driving are mixed together)
    capacity = []
    for period, hrs in PEAK.items():
        wet_days, dry_days = [], []
        for d in all_days:
            if d in EXCLUDED or kind(d) != 'wd':
                continue
            if any((d, h) in cls_hours['wet'] for h in hrs):
                wet_days.append(d)
            elif all((d, h) in dry for h in hrs):
                dry_days.append(d)
        peak_max = lambda k, d: max((q15[k].get((d, h)) for h in hrs if (d, h) in q15[k]), default=None)
        dry_med, dry_med_dow = {}, {}
        for k in sorted(lanes):  # fixed order: set order changes with PYTHONHASHSEED, which would pick different detectors on ties
            vals = [(d, peak_max(k, d)) for d in dry_days]
            vals = [(d, x) for d, x in vals if x is not None]
            if len(vals) >= 3:
                dry_med[k] = statistics.median(x for _, x in vals)
                for wdn in range(5):
                    xs = [x for d, x in vals if dow(d) == wdn]
                    if len(xs) >= 3:
                        dry_med_dow[(k, wdn)] = statistics.median(xs)
        ref = lambda k, d: dry_med_dow.get((k, dow(d)), dry_med[k])
        top = sorted(dry_med, key=lambda k: (-dry_med[k], k))[:max(1, len(dry_med) // 10)]
        groups = [('cbd_top10pct', top), ('2921', [k for k in sorted(CAR_2921) if k in dry_med]),
                  ('2935', [k for k in dry_med if k[0] == '2935'])]
        for site, dets in groups:
            per_day = collections.defaultdict(list)
            for k in dets:
                for d in wet_days:
                    v = peak_max(k, d)
                    if v:
                        per_day[d].append(math.log(v / ref(k, d)))
            days = sorted(per_day)
            row = {'site': site, 'period': period, 'n_detectors': len(dets), 'n_days': len(days), 'days': days}
            if len(days) < 3:
                row.update(ratio=None, ci95=None, note='n_days < 3: sample too small')
            else:
                est = lambda ds: math.exp(statistics.mean(x for dd in ds for x in per_day[dd]))
                boots = sorted(est([rng.choice(days) for _ in days]) for _ in range(N_BOOT))
                row.update(ratio=round(est(days), 3), ci95=[round(boots[int(0.025 * N_BOOT)], 3), round(boots[int(0.975 * N_BOOT) - 1], 3)])
            row['note'] = (row.get('note', '') + '; ' if row.get('note') else '') + 'upper bound: mixes fewer cars with slower driving'
            capacity.append(row)

    # case studies
    def case(date, hours, flag=None):
        # single-day point estimate (effect gives no number when n_days < 3, but a case study needs the point estimate)
        point = {}
        for m, s in series.items():
            de, _, _ = day_effects(s, bases[m], {(date, h) for h in hours}, MIN_BASE[m])
            point[m] = round(math.exp(de[date]), 3) if date in de else None
        b_day = bom.get(date if hours[0] < 9 else day_of(date, 1)) if bom else None
        c = {'date': date, 'weekday': datetime.date.fromisoformat(date).strftime('%a'), 'hours': '%02d-%02d' % (hours[0], hours[-1] + 1),
             'rain_mm_h': [info[(date, h)][0] for h in hours],
             'visibility_m': [at('visibility', date, h) for h in hours],
             'bom_daily_mm': b_day,
             # one BoM row = 9 am the previous day to 9 am that day; give both halves so heavy rain before 9 am is not mistaken for rain in the case window
             'bom_to_9am_mm': bom.get(date) if bom else None, 'bom_from_9am_mm': bom.get(day_of(date, 1)) if bom else None,
             **point}
        if flag:
            c['flag'] = flag
        return c
    wet_day_hours = lambda d: [h for h in DAY_HOURS if (d, h) in cls_hours['wet']]
    cases = [case('2026-08-10', [7, 8, 9])]
    h25 = wet_day_hours('2026-08-25') or [7, 8, 9]
    cases.append(case('2026-08-25', h25))
    cases.append(case('2026-08-19', [7, 8, 9], 'model_false_alarm: model rain but BoM ~0 mm; not used as a wet day'))
    cases.append(case('2026-08-17', [7, 8], 'fog_model_only: no measured visibility to check'))

    # placebo: pick fully dry, fog-free days at random as "fake wet days", leave them out of the baseline and run the same method
    bad_days = {d for c in ('wet', 'rain', 'fog') for (d, _) in cls_hours[c]} | {d for d in false_alarms}
    clean = [d for d in all_days if d not in EXCLUDED and d not in bad_days
             and all((d, h) in dry for h in DAY_HOURS)]
    k = max(5, len(res[('wet', 'car', 'day')]['days']))
    prng = random.Random(SEED + 1)
    fake = sorted(prng.sample(clean, min(k, len(clean))))
    placebo_by_mode = []
    loo = {m: LeaveOneDayOut(baseline_lists(s, dry)) for m, s in series.items()}
    for m, s in series.items():
        r = effect(s, loo[m], {(d, h) for d in fake for h in DAY_HOURS}, MIN_BASE[m], rng)
        placebo_by_mode.append({'mode': m, 'ratio': r['ratio'], 'ci95': r['ci95'], 'n_days': r['n_days']})
    draws = collections.defaultdict(list)
    for _ in range(N_PLACEBO):
        f2 = sorted(prng.sample(clean, min(k, len(clean))))
        for m, s in series.items():
            r = effect(s, loo[m], {(d, h) for d in f2 for h in DAY_HOURS}, MIN_BASE[m], rng)
            if r['ratio'] is not None:
                draws[m].append(r)
    draws_sum = [{'mode': m, 'draws': len(v), 'mean_ratio': round(statistics.mean(x['ratio'] for x in v), 3),
                  'share_ci_contains_1': round(sum(1 for x in v if x['ci95'][0] <= 1 <= x['ci95'][1]) / len(v), 2)}
                 for m, v in draws.items()]
    pc = next(x for x in placebo_by_mode if x['mode'] == 'car')
    placebo = {'ratio': pc['ratio'], 'ci95': pc['ci95'], 'n_days': pc['n_days'], 'days': fake, 'by_mode': placebo_by_mode,
               'repeated': draws_sum,
               'note': 'fully dry days picked at random (seed %d), each day left out of its own baseline (leave-one-day-out, like a real wet day), same method; '
                       'repeated: %d more random draws' % (SEED + 1, N_PLACEBO)}

    # compare with WXP: storm uses rain (>= 1 mm/h) if it has a sample, otherwise wet
    storm_cls = 'rain' if res[('rain', 'car', 'day')]['ratio'] is not None else 'wet'
    wxp = []
    for m in ('car', 'bike', 'ped'):
        r = res[(storm_cls, m, 'day')]
        wxp.append({'wxp': 'storm.rate', 'mode': m, 'current': WXP['storm']['rate'], 'measured': '%s (%s, day)' % (fmt(r), storm_cls),
                    'literature': LIT[m], 'verdict': verdict(WXP['storm']['rate'], r)})
    cap = [c for c in capacity if c['site'] == 'cbd_top10pct' and c['ratio'] is not None]
    cap_r = cap[0] if cap else None
    wxp.append({'wxp': 'storm.T', 'mode': 'car', 'current': WXP['storm']['T'],
                'measured': 'peak capacity proxy %s → implied T %s' % (fmt(cap_r), '%.2f' % (1 / cap_r['ratio']) if cap_r else 'n/a'),
                'literature': LIT['T'], 'verdict': verdict(round(1 / WXP['storm']['T'], 3), cap_r),
                'note': 'compares 1/T = %.3f with the capacity ratio; proxy is an upper bound' % (1 / WXP['storm']['T'])})
    for m in ('car', 'bike', 'ped'):
        r = res[('fog', m, 'day')]
        wxp.append({'wxp': 'fog.rate', 'mode': m, 'current': WXP['fog']['rate'], 'measured': '%s (fog, model only)' % fmt(r),
                    'literature': LIT['T'].split(';')[1].strip(), 'verdict': verdict(WXP['fog']['rate'], r)})
    heavy = sum(1 for d in all_days for h in range(24) if (info[(d, h)][0] or 0) >= 4)
    tmax_model = max(x for x in wx['hourly']['temperature_2m'] if x is not None)
    gmax_model = max(x for x in wx['hourly']['wind_gusts_10m'] if x is not None)
    why = {
        'flood': 'only %d hours >= 4 mm/h in the window, none in daytime' % heavy,
        'heat': 'no hour >= 30 C (model max %.1f C; BoM max %s C)' % (tmax_model, max(bom_tmax.values()) if bom_tmax else 'n/a'),
        'wind': 'no BoM day with gust >= 60 km/h (BoM max %s km/h; model max %.0f km/h, not trusted)' % (max(bom_gust.values()) if bom_gust else 'n/a', gmax_model),
    }
    for w in ('flood', 'heat', 'wind'):
        for f in ('rate', 'T'):
            wxp.append({'wxp': '%s.%s' % (w, f), 'current': WXP[w][f], 'measured': None,
                        'literature': LIT['heat'] if w == 'heat' and f == 'rate' else (LIT['car'] if f == 'rate' else LIT['T']),
                        'verdict': 'no_sample', 'note': why[w] + '; needs stage 2 (longer window)'})
    wxp.append({'wxp': 'fog.T', 'current': WXP['fog']['T'], 'measured': None, 'literature': LIT['T'], 'verdict': 'no_sample',
                'note': 'fog hours in weekday peaks too few for a capacity proxy'})
    wxp.append({'wxp': '*.v, *.ped, *.bike, *.b, *.wob', 'current': None, 'measured': None, 'literature': None,
                'verdict': 'untestable', 'note': 'speeds / deceleration / wobble: SCATS has counts only, no speed or occupancy'})

    out = {
        'version': 1, 'window': [d0, d1],
        'generated': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=10))).isoformat(timespec='seconds'),
        'sources': {'weather': wx['source'] + ' (' + wx['attribution'] + ', ' + wx['licence'] + ')',
                    'check': 'BoM Daily Weather Observations Melbourne (Olympic Park) IDCJDW3033, downloaded by hand, not redistributed',
                    'traffic': 'DataVic Traffic Signal Volume Data (SCATS), CC BY 4.0',
                    'peds': 'City of Melbourne Pedestrian Counting System, CC BY'},
        'bom_loaded': bool(bom),
        'excluded_days': [{'date': d, 'why': w} for d, w in sorted(EXCLUDED.items())],
        'classes': {'dry': 'model precip 0 in this and previous 2 hours, BoM 24 h rain < 1 mm, not fog',
                    'wet': 'model precip >= 0.1 mm/h and BoM 24 h rain >= 0.2 mm',
                    'rain': 'model precip >= 1 mm/h and BoM 24 h rain >= 0.2 mm',
                    'fog': 'visibility < 1000 m, no rain (model only)'},
        'method': {'alignment': 'traffic hour h (h:00-h+1:00) uses Open-Meteo precipitation at T = h+1 (accumulated over the previous hour)',
                   'baseline': 'per sensor x day of week x hour: median of dry hours (>= 3); weekday/weekend-only baselines failed the placebo (Sundays are lower than Saturdays, Mondays ~6% lower than Tue-Thu)',
                   'effect': 'per day: baseline-weighted median of log((flow+1)/(baseline+1)); mean over days, exp; 95%% CI by resampling days (%d draws)' % N_BOOT,
                   'periods': {'day': '07:00-19:00, all days', 'peak': 'weekdays 07-10 and 16-19'},
                   'modes': {'car': 'lane detectors at all CBD SCATS sites (>= 50%% of site max and >= %d/day; 2921 bike/tram/ped detectors removed) — heuristic' % MIN_DAILY,
                             'car_2921': '2921 Swanston/La Trobe detectors 3, 5, 7 (checked against the configuration sheet)',
                             'bike': '2921 bike detectors 1, 2, 4, 8 (6 is broken)',
                             'ped': 'City of Melbourne counters ' + ', '.join(PED_SENSORS)},
                   'min_baseline_per_hour': MIN_BASE},
        'alignment_check': align,
        'results': results,
        'capacity_proxy': capacity,
        'cases': cases,
        'placebo': placebo,
        'wxp_compare': wxp,
        'audit': {'baseline_hours': sorted('%s %02d' % x for x in dry),
                  'class_hours': {c: sorted('%s %02d' % x for x in cls_hours[c]) for c in ('wet', 'rain', 'fog')},
                  'model_false_alarm_hours': sorted(false_alarms),
                  'n_car_lane_detectors': len(lanes)},
    }
    p = os.path.join(out_dir, 'weather_backtest.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('✅ weather_backtest.json (%d KB); BoM %s; dry %d h, wet %d h, rain %d h, fog %d h; model false alarms %d h; %d lane detectors'
          % (os.path.getsize(p) // 1024, 'checked' if bom else 'missing', len(dry), len(cls_hours['wet']), len(cls_hours['rain']),
             len(cls_hours['fog']), len(false_alarms), len(lanes)))
    for r in results:
        if r['period'] == 'day':
            print('   %-4s %-8s ratio %s  ci95 %s  days %d  hours %d  sensors %d' % (r['cls'], r['mode'], r['ratio'], r['ci95'], r['n_days'], r['n_hours'], r['n_sensors']))
    print('   placebo', [(x['mode'], x['ratio'], x['ci95']) for x in placebo_by_mode])
    print('   placebo x%d' % N_PLACEBO, [(x['mode'], x['mean_ratio'], x['share_ci_contains_1']) for x in draws_sum])
    print('   capacity', [(c['site'], c['period'], c['ratio'], c['ci95'], c['n_days']) for c in capacity])
    print('   alignment', {k: (v['bike_wet_day_ratio'], v['n_hours']) for k, v in align.items()})


if __name__ == '__main__':
    main()
