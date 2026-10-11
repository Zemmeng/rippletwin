#!/usr/bin/env python3
"""Purpose: validate public/cbd/weather_hourly.json and weather_backtest.json (acceptance criteria: docs/hackathon/specs/T31-weather-backtest-PRD.md section 6).
Before the files exist only the skeleton is checked. Reverse assertions recompute independently where possible instead of trusting the back-test script's own classification.
Usage: python3 tests/test_weather.py (test.sh runs it); the last line is always "N passed, M failed"
"""
import datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CBD = os.path.join(os.path.dirname(HERE), 'public', 'cbd')
P = F = 0
VERDICTS = {'ok', 'too_strong', 'too_weak', 'wrong_direction', 'untestable', 'no_sample'}


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
    return json.load(open(p, encoding='utf-8')), p


wx, p = load('weather_hourly.json')
precip_at = {}
if wx is not None:
    ok(isinstance(wx.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'weather_hourly.json: version is an integer, under 2 MB')
    t = wx['hourly']['time']
    d0, d1 = (datetime.date.fromisoformat(x) for x in wx['window'])
    ndays = (d1 - d0).days + 1
    ok(len(t) == ndays * 24, 'hour count = days × 24 (%d = %d × 24)' % (len(t), ndays))
    ok(all(re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:00$', x) for x in t), 'times are local (YYYY-MM-DDTHH:00, no timezone offset)')
    ok(wx.get('timezone') == 'Australia/Melbourne' and wx.get('utc_offset_s') == 36000, 'timezone Australia/Melbourne, UTC+10 (the window is before daylight saving)')
    ok(all(len(wx['hourly'][v]) == len(t) for v in wx['hourly']), 'every variable is as long as time')
    ok('Open-Meteo' in wx.get('attribution', '') and wx.get('licence') == 'CC BY 4.0', 'carries the Open-Meteo attribution and CC BY 4.0')
    precip_at = dict(zip(t, wx['hourly']['precipitation']))
    td = wx.get('traffic_days')
    ok(td is not None and not td['not_covered_by_weather']
       and td['scats']['from'] >= wx['window'][0] and td['scats']['to'] <= wx['window'][1]
       and td['peds']['from'] >= wx['window'][0] and td['peds']['to'] <= wx['window'][1],
       'the weather window covers every day with traffic data (SCATS %s..%s, pedestrians %s..%s)' % (
           (td or {}).get('scats', {}).get('from'), (td or {}).get('scats', {}).get('to'),
           (td or {}).get('peds', {}).get('from'), (td or {}).get('peds', {}).get('to')))

bt, p = load('weather_backtest.json')
if bt is not None:
    ok(isinstance(bt.get('version'), int) and os.path.getsize(p) < 2 * 1024 * 1024, 'weather_backtest.json: version is an integer, under 2 MB (%d KB)' % (os.path.getsize(p) // 1024))
    au = bt['audit']
    base = set(au['baseline_hours'])
    wetset = set(au['class_hours']['wet']) | set(au['class_hours']['rain']) | set(au['class_hours']['fog'])
    ok(not (base & wetset), 'reverse: the baseline contains no wet / rain / fog hours (%d baseline hours)' % len(base))
    if precip_at:
        # Independent recomputation: traffic hour h uses precipitation at T = h+1 (likewise for the 2 hours before h); all three must be 0 for a baseline hour
        def p_at(d, h):
            dt = datetime.datetime.fromisoformat(d) + datetime.timedelta(hours=h)
            return precip_at.get(dt.strftime('%Y-%m-%dT%H:00'))
        bad = [x for x in base for d, h in [(x[:10], int(x[11:]))] if any((p_at(d, h + k) or 0) > 0 for k in (1, 0, -1))]
        ok(not bad, 'reverse: recomputed independently from weather_hourly.json, model precipitation is 0 in every baseline hour and the 2 hours before it%s' % (' (bad: %s)' % bad[:3] if bad else ''))
    excl = {x['date'] for x in bt['excluded_days']}
    ok({'2026-09-25', '2026-09-26'} <= excl, 'the exclusion list includes the 25 Sep public holiday and the 26 Sep AFL Grand Final')
    leak = [d for r in bt['results'] + bt['capacity_proxy'] for d in r.get('days', []) if d in excl]
    leak += [c['date'] for c in bt['cases'] if c['date'] in excl]
    leak += [d for d in bt['placebo']['days'] if d in excl]
    leak += [x for x in base | wetset if x[:10] in excl]
    ok(not leak, 'reverse: days in excluded_days appear in no results, capacity proxy, cases, placebo or baseline%s' % (' (leaked: %s)' % sorted(set(leak))[:3] if leak else ''))
    small = [r for r in bt['results'] + bt['capacity_proxy'] if r['n_days'] < 3 and (r['ratio'] is not None or r['ci95'] is not None)]
    ok(not small, 'reverse: cells with n_days < 3 have ratio and ci95 null (no sample, no number)')
    inside = [r for r in bt['results'] + bt['capacity_proxy'] if r['ratio'] is not None and not (r['ci95'][0] <= r['ratio'] <= r['ci95'][1])]
    ok(not inside, 'every point estimate lies inside its own 95% interval')
    pl = bt['placebo']
    ok(pl['ci95'] is not None and pl['ci95'][0] <= 1.0 <= pl['ci95'][1], 'the placebo (car) ci95 contains 1.0: %s' % pl['ci95'])
    bad = [x['mode'] for x in pl['by_mode'] if x['ci95'] is None or not (x['ci95'][0] <= 1.0 <= x['ci95'][1])]
    ok(not bad, 'the placebo ci95 contains 1.0 for every mode%s' % (' (not containing it: %s)' % bad if bad else ''))
    ok(all(x['share_ci_contains_1'] >= 0.8 for x in pl.get('repeated', [])) and pl.get('repeated'),
       'in %s repeated placebo draws, the share of intervals containing 1.0 is ≥ 80%% for every mode (%s)' % (pl['repeated'][0]['draws'] if pl.get('repeated') else 0,
                                                    {x['mode']: x['share_ci_contains_1'] for x in pl.get('repeated', [])}))
    ok(bt.get('bom_loaded') is True, 'wet days were checked against BoM daily rainfall (IDCJDW3033 CSVs were in raw/)')
    rainy = [c for c in bt['cases'] if any((x or 0) >= 0.1 for x in c['rain_mm_h'])]
    ok(rainy and all(c.get('bom_daily_mm') is not None for c in rainy), 'every wet day in the case studies has bom_daily_mm')
    c19 = [c for c in bt['cases'] if c['date'] == '2026-08-19']
    ok(c19 and 'model_false_alarm' in c19[0].get('flag', ''), 'the morning of 19 Aug is flagged as a model false alarm')
    # BoM rainfall runs from 9 am the previous day to 9 am that day: the 19 Aug row is 0 mm and covers only up to 9 am on 19 Aug; from 9 am it belongs to the 20 Aug row (2.6 mm)
    ok(not [x for x in au['class_hours']['wet'] if x.startswith('2026-08-19 ') and int(x[11:]) < 9],
       'reverse: hours before 9 am on 19 Aug (the BoM 0 mm period) are not wet hours (model false alarm, not used as a wet day)')
    ok(all(w['verdict'] in VERDICTS for w in bt['wxp_compare']), 'every wxp_compare verdict takes an agreed value')
    have = {w['wxp'] for w in bt['wxp_compare']}
    ok({'storm.rate', 'storm.T', 'flood.rate', 'fog.rate', 'heat.rate', 'wind.rate'} <= have, 'WXP storm / flood / fog / heat / wind all have a comparison')

print('%d passed, %d failed' % (P, F))
sys.exit(1 if F else 0)
