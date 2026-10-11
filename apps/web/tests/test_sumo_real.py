"""SUMO replay on the real CBD network (interface spec v2): the shape of the pre-computed (baked) copy in apps/sumo/public/real/ + the pure functions of build_real.py.
A full hour 08:00–09:00 (clock0_s = 0); only original / ai are replayed (baseline has metrics only), only vehicles inside the page view, one frame every 2 s;
new metrics works_queue_end_m / works_queue_equiv_end_m / queue_series / works_throughput_vph / works_capacity_assumption_vph.
Options mode: options → baseline + opt-<id> (equal p runs once, metrics only by default); the old {p_original, p_ai, scenarios} output is unchanged.
SUMO is not required; with a SUMO venv (env var SUMO_PY, or /tmp/rippletwin-sumo-venv as in the README) a real re-run also checks reproducibility.
"""
import hashlib
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve()
REPO = HERE.parents[3]
TOOLS = HERE.parents[1]/'tools/sumo'
REAL = REPO/'apps/sumo/public/real'
sys.path.insert(0, str(TOOLS))
import build_real  # noqa: E402

IDS = ['baseline', 'original', 'ai']
PLAYED = ['original', 'ai']
# Interface spec A: at least these 16 junctions (La Trobe / Little Lonsdale / Lonsdale / Little Bourke × Elizabeth / Swanston / Russell / Exhibition)
SITES16 = ['2922', '2921', '2920', '2919', '2914', '2913', '2912', '2911', '2906', '2904', '2903', '2902', '4606', '4605', '4604', '4603']
MB15 = 1.5*1024*1024
SCENARIO_BYTES = 18e6  # total replay size per scenario (target about 15 MB; measured 15–17.5 MB, see README)
NEW_METRICS = {'works_queue_end_m', 'works_queue_equiv_end_m', 'queue_series', 'works_throughput_vph', 'works_capacity_assumption_vph'}


def load(p):
    return json.loads(pathlib.Path(p).read_text(encoding='utf-8'))


def metres(lon_e6, lat_e6, lon0_e6, lat0_e6):
    return ((lon_e6-lon0_e6)/1e6*build_real.KX, (lat_e6-lat0_e6)/1e6*build_real.KY)


def uv_of(lon_e6, lat_e6):
    return build_real.UV(*build_real.xy(lat_e6/1e6, lon_e6/1e6))


def sumo_python():
    for p in [os.environ.get('SUMO_PY'), '/tmp/rippletwin-sumo-venv/bin/python']:
        if p and pathlib.Path(p).exists():
            r = subprocess.run([p, '-c', 'import sumo, numpy, scipy'], capture_output=True)
            if r.returncode == 0:
                return p
    return None


class RealReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = load(REAL/'index.json')
        cls.man = {k: load(REAL/k/'manifest.json') for k in IDS}

    def frames(self, k):
        for c in self.man[k]['chunks']:
            for f in load(REAL/k/c['file'])['frames']:
                yield f

    def test_index_contract(self):
        i = self.index
        self.assertEqual((i['version'], i['network'], i['hour']), (2, 'real', 8))
        self.assertIn('Eclipse SUMO sumo 1.27.1', i['engine'])
        self.assertEqual(i['works'], {'link': 'l595594354_9756035316', 'lanes_closed': 1})
        self.assertRegex(i['generator_sha256'], '^[0-9a-f]{64}$')
        self.assertEqual(type(i['seed']), int)
        p = i['params']
        for k in ['seed', 'p_original', 'p_ai', 'scenarios', 'source', 'signal_2935_green', 'warmup_s', 'shown_s',
                  'hour_window', 'green_2935', 'network_extent', 'sim_s', 'sample_s']:
            self.assertIn(k, p)
        self.assertEqual(p['hour_window'], [8, 9])
        self.assertEqual((p['shown_s'], p['sim_s'], p['sample_s']), (3600, p['warmup_s']+3600, 2))
        self.assertEqual(p['green_2935'], p['signal_2935_green'])
        self.assertTrue(isinstance(p['network_extent'], str) and 'Spring' in p['network_extent'])
        # The baked copy is built with the same image as the cloud (linux/amd64): routeSampler picks different demand on macOS and Linux, so only the same platform matches the live cloud run
        self.assertEqual(p['source'], 'docker-linux-amd64')
        self.assertEqual((p['p_original'], p['p_ai']), (.14, .53))
        self.assertTrue(i['assumptions']['en'] and len(i['assumptions']['en']) == len(i['assumptions']['zh']))
        en = ' '.join(i['assumptions']['en'])
        self.assertIn('%d%%' % round(p['green_2935']*100), en)
        self.assertIn('810 veh/h', en)
        self.assertNotIn('{', en+' '.join(i['assumptions']['zh']))
        self.assertEqual([s['id'] for s in i['scenarios']], IDS)
        for s in i['scenarios']:
            self.assertEqual(s['manifest'], s['id']+'/manifest.json')
            self.assertTrue(s['label']['en'] and s['label']['zh'])
            self.assertEqual(s['metrics'], self.man[s['id']]['metrics'])
        self.assertEqual([s['diversion_share'] for s in i['scenarios']], [0, .14, .53])

    def test_baked_copy_is_from_this_generator(self):
        # Any change to build_real.py requires a re-bake (about 1 minute in the image; command in the README's real-network section)
        self.assertEqual(self.index['generator_sha256'], hashlib.sha256((TOOLS/'build_real.py').read_bytes()).hexdigest())

    def test_manifest_contract(self):
        keys = {'vehicles', 'completed', 'teleports', 'collisions', 'mean_timeloss_s', 'mean_extra_s', 'works_queue_max_m',
                'works_queue_mean_m', 'detour_vehicles'} | NEW_METRICS
        for k, m in self.man.items():
            with self.subTest(k=k):
                self.assertEqual((m['version'], m['network'], m['scenario']), (2, 'real', k))
                self.assertIn(m['sample_s'], (1, 2))
                self.assertEqual(m['agent_columns'], ['i', 'lon_e6', 'lat_e6', 'angle_deg', 'speed_cms'])
                # A full hour: t = 0 ↔ 08:00:00, shown until 09:00
                self.assertEqual((m['clock0_s'], m['duration_s']), (0, 3600))
                self.assertTrue(keys <= set(m['metrics']))
                self.assertEqual(m['metrics']['collisions'], 0)
                self.assertTrue(all(a['type'] in ('car', 'bus') and a['length_m'] > 0 and a['width_m'] > 0 for a in m['agents']))
                self.assertEqual(len({a['id'] for a in m['agents']}), len(m['agents']))
                self.assertEqual((len(m['per_minute']['halting']), len(m['per_minute']['harsh'])), (60, 60))
                if k in PLAYED:
                    self.assertEqual(m['metrics']['vehicles'], len(m['agents']))
                    # Chunks are contiguous and cover 0 … duration_s − sample_s
                    dt = m['sample_s']
                    self.assertEqual(m['chunks'][0]['start'], 0)
                    self.assertEqual(m['chunks'][-1]['end'], m['duration_s']-dt)
                    for a, b in zip(m['chunks'], m['chunks'][1:]):
                        self.assertEqual(b['start'], a['end']+dt)
                    self.assertEqual(sum(c['frames'] for c in m['chunks']), m['duration_s']//dt)
                else:
                    # The page does not play baseline: metrics only
                    self.assertEqual((m['chunks'], m['agents']), ([], []))
        self.assertIsNone(self.man['baseline']['metrics']['mean_extra_s'])
        self.assertEqual(self.man['baseline']['metrics']['detour_vehicles'], 0)
        for k in PLAYED:
            self.assertEqual(type(self.man[k]['metrics']['mean_extra_s']), float)
        # Same vehicles, same random draws: a scenario with a higher detour share never has fewer detouring vehicles
        self.assertGreaterEqual(self.man['ai']['metrics']['detour_vehicles'], self.man['original']['metrics']['detour_vehicles'])
        self.assertGreater(self.man['ai']['metrics']['detour_vehicles'], 0)

    def test_queue_metrics(self):
        for k, m in self.man.items():
            mt = m['metrics']
            with self.subTest(k=k):
                s = mt['queue_series']
                self.assertEqual([x[0] for x in s], list(range(61)))  # one entry per minute, 0 … 60
                self.assertTrue(all(len(x) == 3 and x[1] >= 0 and x[2] >= 0 for x in s))
                self.assertEqual((s[-1][1], s[-1][2]), (mt['works_queue_end_m'], mt['works_queue_equiv_end_m']))
                self.assertEqual(mt['works_queue_equiv_max_m'], max(x[2] for x in s))
                self.assertEqual(mt['works_capacity_assumption_vph'], 810)
                self.assertGreater(mt['works_throughput_vph'], 0)
                # The physical queue is only on the westbound Lonsdale / Albert chain and cannot exceed its length
                self.assertLessEqual(mt['works_queue_end_m'], self.index['params']['chain_m'])
                # The engine method is one vehicle per 7 m ÷ 2 lanes: metres = vehicles × 3.5; after cycle averaging it need not be a whole multiple, but is never negative
                self.assertGreaterEqual(mt['works_queue_equiv_end_m'], 0)
                self.assertGreaterEqual(mt['teleports'], mt['teleports_in_hour'])
                self.assertGreaterEqual(mt['teleports_in_hour'], mt['teleports_works_bound'])
        b, o, a = (self.man[k]['metrics'] for k in IDS)
        # Calibration: with one lane closed, actual throughput past the works must match the engine's 810 veh/h (the 2935 green split was chosen for this)
        self.assertLess(abs(o['works_throughput_vph']-810), 60, o['works_throughput_vph'])
        # Without works the works link is not a bottleneck: throughput ≈ demand, short queue
        self.assertGreater(b['works_throughput_vph'], 1000)
        self.assertLess(b['works_queue_equiv_end_m'], 100)
        # With works: the queue (engine method) keeps growing through the hour; the original plan has fewer detours, so its queue is longer than the AI plan's
        self.assertGreater(o['works_queue_equiv_end_m'], 500)
        self.assertGreater(o['works_queue_equiv_end_m'], a['works_queue_equiv_end_m'])
        s = o['queue_series']
        self.assertGreater(s[60][2], s[30][2]); self.assertGreater(s[30][2], s[10][2])
        # The control-group method (same vehicles: already past without works, not yet past with works) is within 25 % of the engine method
        self.assertLess(abs(o['works_queue_vs_baseline_end_m']-o['works_queue_equiv_end_m']), .25*o['works_queue_equiv_end_m'])
        self.assertIsNone(b['works_queue_vs_baseline_end_m'])
        # Vehicles in the works queue are never teleported (they move forward every cycle)
        for m in (o, a):
            self.assertEqual(m['teleports_works_bound'], 0)

    def test_files_small_and_chunks_hashed(self):
        files = [p for p in REAL.rglob('*') if p.is_file()]
        big = [(p.relative_to(REAL).as_posix(), p.stat().st_size) for p in files if p.stat().st_size >= MB15]
        self.assertEqual(big, [])
        listed = {'index.json'} | {k+'/manifest.json' for k in IDS}
        for k, m in self.man.items():
            total = (REAL/k/'manifest.json').stat().st_size
            for c in m['chunks']:
                data = (REAL/k/c['file']).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), c['sha256'], k+'/'+c['file'])
                self.assertEqual(len(data), c['bytes'])
                self.assertRegex(c['file'], r'^frames-\d{3}\.json$')
                listed.add(k+'/'+c['file']); total += len(data)
            self.assertLess(total, SCENARIO_BYTES, k)
        self.assertEqual({p.relative_to(REAL).as_posix() for p in files}, listed)  # no stray raw files mixed in

    def test_frames_inside_view(self):
        u0, u1, v0, v1 = build_real.VIEW_BOX
        for k in PLAYED:
            m = self.man[k]
            with self.subTest(k=k):
                tls = {h['tls'] for h in m['signal_heads']}
                n, qs, ts = len(m['agents']), [], []
                for f in self.frames(k):
                    ts.append(f['t']); qs.append(f['q'])
                    self.assertGreaterEqual(f['q'], 0)
                    self.assertEqual(set(f['tls']), tls)
                    self.assertTrue(all(set(s) <= set('GgyYrRuoOs') for s in f['tls'].values()))
                    for a in f['a']:
                        self.assertEqual(len(a), 5)
                        self.assertTrue(0 <= a[0] < n and all(type(x) is int for x in (a[0], a[1], a[2], a[4])))
                        # Only vehicles inside the page view (the 16 junctions plus a margin, 140 m further east); lon/lat rounded to 1e-6 degrees, so allow 0.5 m
                        u, v = uv_of(a[1], a[2])
                        self.assertTrue(u0-.5 <= u <= u1+.5 and v0-.5 <= v <= v1+.5, a)
                        self.assertTrue(0 <= a[3] < 360 and a[4] >= 0, a)
                    self.assertEqual(len({a[0] for a in f['a']}), len(f['a']))
                self.assertEqual(ts, list(range(0, m['duration_s'], m['sample_s'])))
                self.assertEqual(max(qs), m['metrics']['works_queue_max_m'])
                self.assertAlmostEqual(sum(qs)/len(qs), m['metrics']['works_queue_mean_m'], delta=.06)
                # Vehicles appearing in the replay = vehicles in the catalogue
                seen = set()
                for f in self.frames(k):
                    seen.update(a[0] for a in f['a'])
                self.assertEqual(seen, set(range(n)))

    def test_heading_matches_motion(self):
        # angle_deg follows the SUMO convention (0 = north, clockwise): in page coordinates (x east, y north) the heading = [sin a, cos a] and must point the way the vehicle actually moves
        prev, ok, bad = {}, 0, 0
        for f in self.frames('original'):
            cur = {a[0]: a for a in f['a']}
            for i, a in cur.items():
                p = prev.get(i)
                if p and a[4] > 800 and p[4] > 800 and abs(a[3]-p[3]) < 2:
                    dx, dy = metres(a[1], a[2], p[1], p[2])
                    r = math.radians(a[3])
                    cos = (dx*math.sin(r)+dy*math.cos(r))/max(1e-9, math.hypot(dx, dy))
                    ok += cos > .98; bad += cos <= .98
            prev = cur
        self.assertGreater(ok, 1000)
        self.assertLess(bad, ok*.01)

    def test_centre_not_front_bumper(self):
        # Eastbound (90°) vehicle: centre is half a length west of the front bumper; northbound (0°): south of it
        x, y = build_real.centre(100, 50, 90, 4.6)
        self.assertAlmostEqual(x, 97.7); self.assertAlmostEqual(y, 50)
        x, y = build_real.centre(0, 0, 0, 5)
        self.assertAlmostEqual(x, 0); self.assertAlmostEqual(y, -2.5)
        lon, lat = build_real.lonlat_e6(*build_real.xy(-37.8108, 144.9672))
        self.assertEqual((lon, lat), (144967200, -37810800))
        # Conversely: the centre of a stopped vehicle (speed 0) in the replay never sits right on a signal head at the stop line (front ≥ 0 behind the line, centre a further 2.3 m back)
        heads = [(h['lon_e6'], h['lat_e6']) for h in self.man['original']['signal_heads']]
        stopped = [a for f in self.frames('original') if f['t'] == 600 for a in f['a'] if a[4] == 0]
        near = [min(math.hypot(*metres(a[1], a[2], hx, hy)) for hx, hy in heads) for a in stopped]
        self.assertTrue(stopped and min(near) > 1.0, min(near) if near else None)

    def test_signal_heads_cover_16_junctions(self):
        sites = {s['site']: s for s in load(REPO/'apps/roads/public/cbd/signals.json')['sites']}
        for k in PLAYED:
            m = self.man[k]
            heads = m['signal_heads']
            self.assertTrue(all(h['idx'] and all(type(x) is int for x in h['idx']) for h in heads))
            self.assertTrue(all(build_real.in_box(build_real.VIEW_BOX, *uv_of(h['lon_e6'], h['lat_e6'])) for h in heads))
            f = next(self.frames(k))
            for h in heads:
                self.assertLess(max(h['idx']), len(f['tls'][h['tls']]))
            for sid in SITES16 + ['2935']:
                s = sites[sid]
                d = min(math.hypot(*metres(h['lon_e6'], h['lat_e6'], s['lon']*1e6, s['lat']*1e6)) for h in heads)
                self.assertLess(d, 60, (k, sid, s['name'], round(d)))

    def test_validate_real(self):
        v = build_real.validate_real({})
        self.assertEqual(v, {'seed': 42, 'p_original': .14, 'p_ai': .53, 'scenarios': IDS})
        self.assertEqual(build_real.validate_real({'network': 'real', 'scenarios': ['ai', 'baseline']})['scenarios'], ['baseline', 'ai'])
        for ok in [{'seed': 0}, {'seed': 2147483647}, {'p_original': 0}, {'p_ai': 1}, {'p_ai': .5}, {'scenarios': ['original']}]:
            with self.subTest(ok=ok):
                build_real.validate_real(ok)
        for bad in [None, [], 'x', {'network': 'synthetic'}, {'seed': -1}, {'seed': 2147483648}, {'seed': 1.0}, {'seed': True},
                    {'seed': '1'}, {'p_original': -.01}, {'p_ai': 1.01}, {'p_ai': float('nan')}, {'p_ai': float('inf')}, {'p_ai': '0.5'},
                    {'p_ai': True}, {'scenarios': []}, {'scenarios': ['closure']}, {'scenarios': 'ai'}, {'scenarios': ['ai', 'ai']},
                    {'green_2935': .5}, {'demand_scale': 2}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_real.validate_real(bad)

    def test_pure_helpers(self):
        p = {'offset': 0.0, 'phases': [(60.0, 'GG'), (3.0, 'yy'), (27.0, 'rr')], 'cycle': 90.0}
        self.assertEqual([build_real.tls_state(p, t) for t in [0, 59.5, 60, 62.9, 63, 89.9, 90, 150]], ['GG', 'GG', 'yy', 'yy', 'rr', 'rr', 'GG', 'yy'])
        self.assertEqual(build_real.queue_now([0, 30, 85, 200]), 85)
        self.assertEqual(build_real.queue_now([70, 90]), 0)
        # Vehicle counting uses the same 60 m gap rule
        self.assertEqual(build_real.queue_count([0, 7, 14, 60, 130]), 4)
        self.assertEqual(build_real.queue_count([61, 62]), 0)
        # Per minute: over the last 90 s cycle, the physical queue takes the maximum and the engine method takes the mean vehicle count × 3.5 m
        ts = list(range(0, 3601, 2)); qs = [float(t % 90) for t in ts]; es = [10]*len(ts)
        s = build_real.minute_series(ts, qs, es)
        self.assertEqual(len(s), 61)
        self.assertEqual(s[0], [0, 0.0, 35.0])
        self.assertEqual(s[60][1], 88.0)
        self.assertTrue(all(x[2] == 35.0 for x in s))
        # Control-group method: past before 09:00 without works but not with works → +1; the reverse → −1
        E = build_real.END
        self.assertEqual(build_real.delayed_vs_baseline({'a': E+5, 'b': 100, 'c': 50}, {'a': 200, 'b': 90, 'c': E+9}, ['a', 'b', 'c', 'd']), 0)
        self.assertEqual(build_real.delayed_vs_baseline({'b': 100}, {'a': 200, 'b': 90}, ['a', 'b']), 1)
        # View box: all 16 junctions inside, Spring St outside
        for lat, lon in [(-37.810317, 144.961359), (-37.808158, 144.968743), (-37.813269, 144.962708), (-37.811104, 144.970108)]:
            self.assertTrue(build_real.in_box(build_real.VIEW_BOX, *build_real.UV(*build_real.xy(lat, lon))))
        self.assertFalse(build_real.in_box(build_real.VIEW_BOX, *build_real.UV(*build_real.xy(*build_real.SPRING_LONSDALE))))

    def test_rebuild_is_deterministic(self):
        py = sumo_python()
        if not py:
            self.skipTest('no venv with SUMO installed (set SUMO_PY)')
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            env = {**os.environ, 'SUMO_REAL_CACHE': str(d/'cache')}
            def run(name, seed, sc):
                r = subprocess.run([py, str(TOOLS/'build_real.py'), '--seed', str(seed), '--scenarios', *sc, '--output', str(d/name),
                                    '--work-dir', str(d/(name+'-raw'))], capture_output=True, text=True, env=env, timeout=900)
                self.assertEqual(r.returncode, 0, r.stdout[-2000:]+r.stderr[-2000:])
                return load(d/name/'index.json')
            a = run('a', 42, IDS)
            self.assertLess(a['timing']['total_s'], 180)
            import platform
            if platform.system() == 'Linux' and platform.machine() in ('x86_64', 'AMD64'):
                for k in IDS:
                    # Same platform, same seed, same generator: byte-identical to the baked copy (source is only in the index)
                    self.assertEqual(load(d/'a'/k/'manifest.json'), self.man[k], k)
            else:
                # On other platforms routeSampler picks different demand (measured), so no comparison with the linux/amd64 baked copy; only local reproducibility is checked
                run('a2', 42, ['original'])
                self.assertEqual(load(d/'a2/original/manifest.json')['metrics'] | {'mean_extra_s': None, 'works_traffic_extra_s': None, 'works_queue_vs_baseline_end_m': None},
                                 load(d/'a/original/manifest.json')['metrics'] | {'mean_extra_s': None, 'works_traffic_extra_s': None, 'works_queue_vs_baseline_end_m': None})
                self.assertEqual([c['sha256'] for c in load(d/'a2/original/manifest.json')['chunks']],
                                 [c['sha256'] for c in load(d/'a/original/manifest.json')['chunks']])
            b = run('b', 43, ['baseline'])
            self.assertNotEqual(b['scenarios'][0]['metrics']['queue_series'], a['scenarios'][0]['metrics']['queue_series'])

    # ---- Options mode: options → baseline + opt-<id> (one lane closed + each option's p); the old form is unchanged ----
    def test_validate_options(self):
        v = build_real.validate_real({'network': 'real', 'options': [{'id': 'C', 'p': .607}, {'id': 'A', 'p': .14}, {'id': 'B', 'p': 0}]})
        self.assertEqual(v, {'seed': 42, 'options': [{'id': 'A', 'p': .14}, {'id': 'B', 'p': 0.0}, {'id': 'C', 'p': .607}], 'frames': False,
                             'scenarios': ['baseline', 'opt-A', 'opt-B', 'opt-C']})
        self.assertEqual(type(v['options'][1]['p']), float)
        v = build_real.validate_real({'seed': 9, 'options': [{'id': x, 'p': 1} for x in 'EDCBA'], 'frames': True})
        self.assertEqual((v['seed'], v['frames'], v['scenarios']), (9, True, ['baseline', 'opt-A', 'opt-B', 'opt-C', 'opt-D', 'opt-E']))
        # Not a single field of the old form has changed
        self.assertEqual(build_real.validate_real({'p_ai': .6}), {'seed': 42, 'p_original': .14, 'p_ai': .6, 'scenarios': IDS})
        for bad in [{'options': []}, {'options': [{'id': x, 'p': .1} for x in 'ABCDEA']}, {'options': [{'id': 'F', 'p': .1}]},
                    {'options': [{'id': 'A', 'p': .1}, {'id': 'A', 'p': .1}]}, {'options': [{'id': 'A', 'p': 1.01}]},
                    {'options': [{'id': 'A', 'p': float('inf')}]}, {'options': [{'id': 'A', 'p': None}]}, {'options': [{'id': 'A', 'p': False}]},
                    {'options': [{'id': 'A', 'p': .1, 'x': 1}]}, {'options': [{'id': ['A'], 'p': .1}]}, {'options': 'A'}, {'options': None},
                    {'options': [{'id': 'A', 'p': .1}], 'p_ai': .5}, {'options': [{'id': 'A', 'p': .1}], 'p_original': .5},
                    {'options': [{'id': 'A', 'p': .1}], 'scenarios': ['baseline']},
                    {'options': [{'id': 'A', 'p': .1}], 'frames': 0}, {'options': [{'id': 'A', 'p': .1}], 'seed': True},
                    {'options': [{'id': 'A', 'p': .1}], 'network': 'synthetic'}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_real.validate_real(bad)

    def test_scenario_plan_reuses_equal_p(self):
        from types import SimpleNamespace
        old = build_real.validate_real({'p_original': .2, 'scenarios': ['baseline', 'ai']})
        # The old three scenarios: frames written as before (original / ai only), no reuse
        self.assertEqual(build_real.scenario_plan(old), ({'baseline': 0.0, 'original': .2, 'ai': .53}, {'baseline': False, 'original': True, 'ai': True}, {}))
        opts = build_real.validate_real({'options': [{'id': 'A', 'p': .14}, {'id': 'B', 'p': .14}, {'id': 'C', 'p': .607}, {'id': 'D', 'p': .14}]})
        shares, frames, reuse = build_real.scenario_plan(opts)
        self.assertEqual(shares, {'baseline': 0.0, 'opt-A': .14, 'opt-B': .14, 'opt-C': .607, 'opt-D': .14})
        self.assertEqual(reuse, {'opt-B': 'opt-A', 'opt-D': 'opt-A'})
        self.assertEqual(set(frames.values()), {False})
        _, frames, _ = build_real.scenario_plan(build_real.validate_real({'options': [{'id': 'A', 'p': .3}], 'frames': True}))
        self.assertEqual(frames, {'baseline': False, 'opt-A': True})  # baseline always outputs metrics only
        self.assertEqual([build_real.closed(k) for k in ['baseline', 'original', 'ai', 'opt-A']], [False, True, True, True])
        self.assertEqual(build_real.label('opt-C'), {'en': 'Option C', 'zh': '方案 C'})
        self.assertEqual(build_real.label('ai'), {'en': build_real.SCENARIOS['ai']['en'], 'zh': build_real.SCENARIOS['ai']['zh']})
        # Arguments to build(args): both the config passed in by serve.py (with scenarios) and command-line args are accepted
        args = SimpleNamespace(**opts, output='x', work_dir='y')
        self.assertEqual(build_real.validate_real(build_real.run_config(args)), opts)
        args = SimpleNamespace(**old, output='x', work_dir='y')
        self.assertEqual(build_real.validate_real(build_real.run_config(args)), old)

    def test_copy_reused_keeps_chunk_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d)
            build_real.dump(out/'opt-A/frames-000.json', {'frames': [{'t': 0}]})
            sha = hashlib.sha256((out/'opt-A/frames-000.json').read_bytes()).hexdigest()
            m = {'scenario': 'opt-A', 'chunks': [{'file': 'frames-000.json', 'sha256': sha}], 'metrics': {'works_queue_max_m': 5.0}}
            results = {'opt-A': {'manifest': m, 'loss': {'v1': 1.0}, 'passed': {'v1': 200.0}, 'bound': ['v1'], 'wall': {}},
                       'opt-C': {'manifest': {'scenario': 'opt-C', 'chunks': [], 'metrics': {}}, 'loss': {}, 'passed': {}, 'bound': [], 'wall': {}}}
            build_real.copy_reused(out, {'opt-B': 'opt-A', 'opt-D': 'opt-C'}, results)
            b = results['opt-B']['manifest']
            self.assertEqual((b['scenario'], b['reused_from'], b['metrics']), ('opt-B', 'opt-A', {'works_queue_max_m': 5.0}))
            self.assertIsNot(b['metrics'], m['metrics'])  # deep copy: filling in mean_extra_s later does not leak across
            self.assertEqual(m['scenario'], 'opt-A'); self.assertNotIn('reused_from', m)
            self.assertEqual((results['opt-B']['loss'], results['opt-B']['passed'], results['opt-B']['bound']), ({'v1': 1.0}, {'v1': 200.0}, ['v1']))
            self.assertEqual(hashlib.sha256((out/'opt-B/frames-000.json').read_bytes()).hexdigest(), sha)
            self.assertFalse((out/'opt-D').exists())  # metrics-only scenarios get no directory (build writes the manifest later)
            self.assertEqual(results['opt-D']['manifest']['reused_from'], 'opt-C')

    def test_options_run_matches_original_and_reuses_equal_p(self):
        py = sumo_python()
        if not py:
            self.skipTest('no venv with SUMO installed (set SUMO_PY)')
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            env = {**os.environ, 'SUMO_REAL_CACHE': os.environ.get('SUMO_REAL_CACHE') or str(d/'cache')}
            for name, extra in [('o', ['--options', 'A=0.14', 'B=0.14', 'C=0.607']), ('c', ['--scenarios', 'baseline', 'original'])]:
                r = subprocess.run([py, str(TOOLS/'build_real.py'), '--seed', '42', *extra, '--output', str(d/name), '--work-dir', str(d/(name+'-raw'))],
                                   capture_output=True, text=True, env=env, timeout=900)
                self.assertEqual(r.returncode, 0, r.stdout[-2000:]+r.stderr[-2000:])
            o, c = load(d/'o/index.json'), load(d/'c/index.json')
            self.assertEqual([s['id'] for s in o['scenarios']], ['baseline', 'opt-A', 'opt-B', 'opt-C'])
            self.assertEqual([s['diversion_share'] for s in o['scenarios']], [0, .14, .14, .607])
            self.assertEqual([s['label']['en'] for s in o['scenarios']], ['No works', 'Option A', 'Option B', 'Option C'])
            self.assertEqual([s.get('reused_from') for s in o['scenarios']], [None, None, 'opt-A', None])
            self.assertEqual(set(o['timing']['sumo_s']), {'baseline', 'opt-A', 'opt-C'})  # B, with the same p, was not run again
            self.assertEqual(set(o['timing']['job_s']), {'baseline', 'opt-A', 'opt-C'})
            self.assertEqual(o['params']['options'], [{'id': 'A', 'p': .14}, {'id': 'B', 'p': .14}, {'id': 'C', 'p': .607}])
            self.assertEqual((o['params']['frames'], o['hour'], o['params']['shown_s']), (False, 8, 3600))
            man = {s['id']: load(d/'o'/s['manifest']) for s in o['scenarios']}
            cm = load(d/'c/original/manifest.json')
            # Option A (p = 0.14) is the original (p_original = 0.14): same vehicles, same random draws, so every hourly metric is identical
            self.assertEqual(man['opt-A']['metrics'], cm['metrics'])
            self.assertTrue(NEW_METRICS <= set(man['opt-A']['metrics']))
            self.assertEqual(man['opt-A']['per_minute'], cm['per_minute'])
            self.assertEqual(man['baseline']['metrics'], load(d/'c/baseline/manifest.json')['metrics'])
            self.assertEqual(man['opt-B']['metrics'], man['opt-A']['metrics'])
            self.assertEqual((man['opt-B']['scenario'], man['opt-B']['reused_from']), ('opt-B', 'opt-A'))
            for k, m in man.items():
                self.assertEqual((m['chunks'], m['agents']), ([], []), k)  # metrics only by default
                self.assertEqual(m['metrics'], next(s['metrics'] for s in o['scenarios'] if s['id'] == k))
                self.assertEqual(m['works']['closed_lane'], None if k == 'baseline' else build_real.WORKS_LANE)
                self.assertEqual(m['metrics']['collisions'], 0)
                self.assertEqual(m['diversion_share'], next(s['diversion_share'] for s in o['scenarios'] if s['id'] == k))
            self.assertEqual(sorted(p.relative_to(d/'o').as_posix() for p in (d/'o').rglob('*.json')),
                             sorted(['index.json']+[k+'/manifest.json' for k in man]))
            a, cc = man['opt-A']['metrics'], man['opt-C']['metrics']
            self.assertGreater(cc['detour_vehicles'], a['detour_vehicles'])
            # The option with more detours has a shorter works queue (engine method, 09:00)
            self.assertLess(cc['works_queue_equiv_end_m'], a['works_queue_equiv_end_m'])


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(RealReplay))
    failed = len(result.errors)+len(result.failures)
    skipped = len(result.skipped)
    if skipped:
        print(f'(skipped {skipped}: {"; ".join(r for _, r in result.skipped)})')
    print(f'{result.testsRun-failed-skipped} passed, {failed} failed')
    sys.exit(1 if failed else 0)
