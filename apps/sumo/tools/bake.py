#!/usr/bin/env python3
"""Purpose: pre-compute SUMO results of the synthetic 2×2 grid and store them as static files (fallback C, D-0930-1700). The legacy
         run() / bakedFor() API of sumo-client.js reads them when the cloud is unreachable, rate-limited, busy, timed out or failed, and
         they must be labelled pre-computed. Only calls an existing HTTP API (a local serve.py or /api/sumo/v1); computes nothing itself.

         Preset: seed 42 defaults (diversion 0.45, demand 1.0), 4 scenarios; stores the index + every manifest + every frame chunk
         Grid: diversion {0, 0.15, 0.3, 0.45, 0.6} × demand {0.8, 1.0, 1.2}, seed 42, 4 scenarios; stores the index (metrics) only
         Submits one job at a time (the server runs them serially); waits and retries on 429 / 503; polls once a second, at most 180 s per run
         Every frame chunk is checked against the manifest's sha256 and byte count; every run must share one generator_sha256 / engine
         Writes to a sibling temporary directory first and swaps --out in only when everything succeeded; a failed preset writes nothing.
         Failed grid points are recorded as failed with the reason: never dropped, never invented

Usage (from the repo root; Python ≥ 3.9, standard library only):
  python3 apps/sumo/tools/bake.py --base http://127.0.0.1:8051/sumo/v1 --source local-macos-arm64
  python3 apps/sumo/tools/bake.py --base https://hackathon-site.zemmmeng.workers.dev/api/sumo/v1 --source cloudflare-container
    (the hosted endpoint was decommissioned after the hackathon; use a local serve.py or container)
  Other options: --out <dir> (default apps/sumo/public/baked); --header K:V (repeatable);
                 --only preset|grid re-runs one half and keeps the other half of the existing --out unchanged
                 (refuses to merge if the generator or engine differs);
                 --dry-run only checks /health and prints the plan, without submitting or writing anything
Exit codes: 0 written with no service failures; 1 nothing written (unreachable / preset failed / generator mismatch / bad arguments);
            2 written, but some grid points were recorded as failed because of service errors (timeout, unreachable, persistent 429);
              re-run with --only grid
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / 'public' / 'baked'
SCENARIOS = ['baseline', 'closure', 'guided', 'footpath']
# Matches DEFAULT_CONFIG in build_demo.py; everything is passed explicitly, so baked.json records exactly what was submitted
PRESET = {'seed': 42, 'scenarios': SCENARIOS, 'demand_duration_s': 600, 'clearance_s': 1200,
          'demand_scale': 1.0, 'diversion_share': 0.45}
GRID_DIVERSION = [0, 0.15, 0.3, 0.45, 0.6]
GRID_DEMAND = [0.8, 1.0, 1.2]
POLL_S = 1
RUN_TIMEOUT_S = 180
RETRY_WAIT_MAX_S = 300   # longest total wait per point on 429 / 503 / 502
MB = 1024 * 1024         # MiB, as in scripts/check.sh [6]
FILE_CAP, TOTAL_CAP = 2 * MB, 25 * MB


class Fatal(Exception):
    """The whole bake is void: nothing is written"""


class RunFailed(Exception):
    """A single point failed; kind = 'sumo' (SUMO itself judged the run a failure: a result) or 'service' (a service error: not a result)"""

    def __init__(self, kind, error):
        super().__init__(error)
        self.kind, self.error = kind, error


def grid_key(seed, diversion, demand):
    return 's%d-d%.2f-x%.1f' % (seed, diversion, demand)


def grid_points():
    return [dict(PRESET, diversion_share=d, demand_scale=x) for d in GRID_DIVERSION for x in GRID_DEMAND]


class Api:
    def __init__(self, base, headers):
        self.base = base.rstrip('/')
        self.headers = {'Accept': 'application/json', 'User-Agent': 'rippletwin-bake/1', **headers}

    def call(self, method, path, body=None, timeout=30):
        """→ (status, raw bytes, response headers); HTTP errors are returned too, an unreachable host raises OSError"""
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        headers = dict(self.headers, **({'Content-Type': 'application/json'} if data is not None else {}))
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def json(self, path, timeout=30):
        status, raw, _ = self.call('GET', path, timeout=timeout)
        if status != 200:
            raise RunFailed('service', 'GET %s → %d %s' % (path, status, describe(raw)))
        try:
            return json.loads(raw), raw
        except ValueError:
            raise RunFailed('service', 'GET %s is not JSON' % path)


def describe(raw):
    """The container answers {error: sentence}, the Worker {ok:false, error: code, msg}; both are understood"""
    try:
        v = json.loads(raw)
        if isinstance(v, dict):
            code, msg = v.get('error'), v.get('msg')
            return ' '.join(str(s) for s in (code, msg) if s) or raw[:200].decode('utf-8', 'replace')
    except ValueError:
        pass
    return raw[:200].decode('utf-8', 'replace')


def code_of(raw):
    try:
        v = json.loads(raw)
        return v.get('error') if isinstance(v, dict) else None
    except ValueError:
        return None


def health(api, log, wait_max=90):
    """While the container cold-starts the Worker answers 503 sumo_starting / 502: wait up to wait_max seconds; any other error is fatal"""
    waited = 0
    while True:
        try:
            status, raw, _ = api.call('GET', '/health', timeout=30)
        except OSError as e:
            raise Fatal('cannot reach %s/health: %s' % (api.base, e))
        if status in (502, 503) and code_of(raw) != 'sumo_off' and waited < wait_max:
            log('   … /health → %d %s, waiting 10 s (the container may be cold-starting)' % (status, code_of(raw) or ''))
            time.sleep(10)
            waited += 10
            continue
        break
    if status != 200:
        raise Fatal('%s/health → %d %s' % (api.base, status, describe(raw)))
    try:
        h = json.loads(raw)
    except ValueError:
        raise Fatal('%s/health did not return JSON (wrong URL?)' % api.base)
    if not isinstance(h, dict) or not h.get('engine'):
        raise Fatal('%s/health has no engine field: %s' % (api.base, raw[:200]))
    return h


def submit(api, params, log):
    """POST /runs, waiting and retrying on 429 / 503 / 502 / unreachable → job id"""
    waited = 0
    while True:
        try:
            status, raw, headers = api.call('POST', '/runs', params, timeout=30)
        except OSError as e:
            status, raw, headers = 0, str(e).encode(), {}
        if status == 202:
            job = json.loads(raw)
            return job['id']
        code = code_of(raw)
        if status == 503 and code == 'sumo_off':
            raise Fatal('service is off (503 sumo_off): the site has no SUMO binding')
        if status in (0, 429, 502, 503, 504):
            try:
                wait = int((headers or {}).get('Retry-After') or 0)
            except ValueError:
                wait = 0
            wait = max(wait, 15 if status == 429 else 10)
            if waited + wait > RETRY_WAIT_MAX_S:
                raise RunFailed('service', 'POST /runs kept failing (last %s %s) after waiting %d s' % (status or 'unreachable', describe(raw), waited))
            log('   … POST /runs → %s %s, retrying in %d s' % (status or 'unreachable', code or describe(raw)[:80], wait))
            time.sleep(wait)
            waited += wait
            continue
        # 400 / 413 etc.: a parameter problem, retrying will not help
        raise RunFailed('service', 'POST /runs → %d %s' % (status, describe(raw)))


def wait_done(api, run_id, log):
    start, previous, errors = time.monotonic(), None, 0
    while True:
        if time.monotonic() - start > RUN_TIMEOUT_S:
            raise RunFailed('service', 'timeout: did not finish within %d s (run %s)' % (RUN_TIMEOUT_S, run_id))
        try:
            status, raw, _ = api.call('GET', '/runs/' + run_id, timeout=15)
        except OSError as e:
            status, raw = 0, str(e).encode()
        if status == 404:
            raise RunFailed('service', 'run %s has disappeared (container restarted?): %s' % (run_id, describe(raw)))
        if status != 200:
            errors += 1
            if errors >= 5:
                raise RunFailed('service', 'status unavailable 5 times in a row (last %s %s)' % (status or 'unreachable', describe(raw)))
            time.sleep(POLL_S)
            continue
        errors = 0
        job = json.loads(raw)
        if job.get('status') != previous:
            previous = job.get('status')
            log('   … %s %s (%.1f s)' % (run_id[:8], previous, time.monotonic() - start))
        if previous == 'complete':
            return time.monotonic() - start
        if previous == 'failed':
            # record the server's own words verbatim (SUMO integrity checks, not cleared, collisions…); a run cut short by a restart counts as a service problem
            error = str(job.get('error') or 'failed (no reason given)')
            raise RunFailed('service' if 'restarted' in error else 'sumo', error)
        time.sleep(POLL_S)


def check_config(index, params):
    got = index.get('config') or {}
    for k in ('seed', 'demand_duration_s', 'clearance_s', 'demand_scale', 'diversion_share'):
        if got.get(k) != params[k]:
            raise Fatal('server recorded %s=%r, which differs from the submitted %r' % (k, got.get(k), params[k]))
    ids = [s.get('id') for s in index.get('scenarios') or []]
    if sorted(ids) != sorted(params['scenarios']):
        raise Fatal('index.json scenarios %s ≠ submitted %s' % (ids, params['scenarios']))


def fetch_run(api, run_id, params, dest, frames):
    """Download one completed run. frames=True: index + 4 manifests + every chunk into dest/; False: only the index, written to dest (a file path).
    → (raw index bytes, generator_sha256, engine)"""
    prefix = '/runs/' + run_id
    index, index_raw = api.json(prefix + '/index.json')
    check_config(index, params)
    generator = None
    files = {}
    for s in index['scenarios']:
        sid = s['id']
        if not frames and sid != 'baseline':
            continue   # grid points need only the index; one manifest is enough for the generator fingerprint
        m, m_raw = api.json('%s/%s/manifest.json' % (prefix, sid))
        if m.get('scenario') != sid or m.get('demand_hash') != index.get('demand_hash'):
            raise Fatal('%s manifest: scenario / demand_hash do not match the index' % sid)
        g = (m.get('provenance') or {}).get('generator_sha256')
        if not g or (generator and g != generator):
            raise Fatal('generator_sha256 inconsistent or missing within one run: %s' % g)
        generator = g
        if not frames:
            continue
        files['%s/manifest.json' % sid] = m_raw
        for c in m['chunks']:
            status, raw, _ = api.call('GET', '%s/%s/%s' % (prefix, sid, c['file']), timeout=60)
            if status != 200:
                raise Fatal('GET %s/%s → %d %s' % (sid, c['file'], status, describe(raw)))
            if hashlib.sha256(raw).hexdigest() != c['sha256']:
                raise Fatal('%s/%s sha256 does not match the manifest' % (sid, c['file']))
            if 'bytes' in c and len(raw) != c['bytes']:
                raise Fatal('%s/%s byte count %d ≠ manifest %d' % (sid, c['file'], len(raw), c['bytes']))
            if len(json.loads(raw)['frames']) != c['frames']:
                raise Fatal('%s/%s frame count does not match the manifest' % (sid, c['file']))
            files['%s/%s' % (sid, c['file'])] = raw
    if frames:
        files['index.json'] = index_raw
        for rel, raw in files.items():
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            (dest / rel).write_bytes(raw)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(index_raw)
    return index_raw, generator, index.get('engine')


def bake_one(api, params, dest, frames, log):
    run_id = submit(api, params, log)
    elapsed = wait_done(api, run_id, log)
    index_raw, generator, engine = fetch_run(api, run_id, params, dest, frames)
    return {'run_id': run_id, 'elapsed_s': round(elapsed, 1), 'generator': generator, 'engine': engine, 'index_raw': index_raw}


def size_table(root, log):
    rows, total, count, largest = [], 0, 0, (0, '')
    groups = {}
    for f in sorted(p for p in root.rglob('*') if p.is_file()):
        rel = f.relative_to(root).as_posix()
        sz = f.stat().st_size
        total += sz
        count += 1
        largest = max(largest, (sz, rel))
        parts = rel.split('/')
        group = rel if len(parts) == 1 or rel == 'preset/index.json' else '/'.join(parts[:-1]) + '/'
        n, s, big = groups.get(group, (0, 0, 0))
        groups[group] = (n + 1, s + sz, max(big, sz))
    log('\n%-24s %6s %12s %12s' % ('path', 'files', 'total', 'largest'))
    for g, (n, s, big) in groups.items():
        log('%-24s %6d %9.2f MB %9.2f MB' % (g, n, s / MB, big / MB))
    log('%-24s %6d %9.2f MB   largest: %s %.2f MB' % ('total', count, total / MB, largest[1], largest[0] / MB))
    warned = False
    for f in root.rglob('*'):
        if f.is_file() and f.stat().st_size > FILE_CAP:
            warned = True
            log('⚠️  %s %.2f MB > 2 MB (repo limit for .json, D-0929-1430; the pre-commit hook will block it)' % (f.relative_to(root), f.stat().st_size / MB))
    if total > TOTAL_CAP:
        warned = True
        log('⚠️  total %.1f MB > 25 MB: consider keeping frames for baseline / closure only' % (total / MB))
    return {'files': count, 'bytes': total, 'largest': largest[1], 'largest_bytes': largest[0], 'warned': warned}


def swap_in(tmp, out):
    """tmp is complete → replace out: two renames, never a half-written directory in between"""
    old = None
    if out.exists():
        old = out.parent / ('.%s.old-%d' % (out.name, os.getpid()))
        out.rename(old)
    tmp.rename(out)
    if old:
        shutil.rmtree(old, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Pre-compute SUMO results (fallback C)', formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--base', required=True, help='…/sumo/v1 or …/api/sumo/v1 (no trailing slash)')
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    ap.add_argument('--source', required=True, help='where it ran, recorded in baked.json: cloudflare-container / local-macos-arm64 …')
    ap.add_argument('--header', action='append', default=[], metavar='K:V')
    ap.add_argument('--only', choices=['preset', 'grid'])
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)
    log = lambda s='': print(s, flush=True)

    headers = {}
    for h in args.header:
        k, sep, v = h.partition(':')
        if not sep or not k.strip():
            log('❌ --header must be K:V: %s' % h)
            return 1
        headers[k.strip()] = v.strip()
    api = Api(args.base, headers)
    out = args.out.resolve()
    do_preset, do_grid = args.only in (None, 'preset'), args.only in (None, 'grid')
    points = grid_points() if do_grid else []

    try:
        h = health(api, log)
        log('✅ %s/health: %s · active_jobs=%s' % (api.base, h['engine'], h.get('active_jobs')))
        if args.dry_run:
            log('Plan (--dry-run: nothing submitted, nothing written) → %s' % out)
            if do_preset:
                log('  preset  %s  + 4 manifests + all frames' % json.dumps(PRESET))
            for p in points:
                log('  grid    %s  %s' % (grid_key(p['seed'], p['diversion_share'], p['demand_scale']), json.dumps(p)))
            log('%d runs in total (the grid point with the preset parameters reuses the preset run)' % (int(do_preset) + len(points) - (1 if do_preset and do_grid else 0)))
            return 0

        old = None
        if args.only and (out / 'baked.json').exists():
            old = json.loads((out / 'baked.json').read_text(encoding='utf-8'))
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix='.%s.tmp-' % out.name, dir=out.parent))
        try:
            return bake(api, args, out, tmp, old, do_preset, points, log)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
    except Fatal as e:
        log('❌ %s\nNothing written (%s left unchanged)' % (e, out))
        return 1
    except KeyboardInterrupt:
        log('\n❌ Interrupted: nothing written (%s left unchanged)' % out)
        return 1


def bake(api, args, out, tmp, old, do_preset, points, log):
    t0 = time.monotonic()
    generators, engines = set(), set()
    done = {}   # canonical parameter string → that run (a grid point equal to the preset reuses it)
    catalog = {'version': 1, 'generated_at': None, 'source': args.source, 'engine': None, 'generator_sha256': None,
               'preset': None, 'grid': []}
    service_failures = 0

    if do_preset:
        log('▶ preset %s' % json.dumps(PRESET))
        try:
            r = bake_one(api, PRESET, tmp / 'preset', True, log)
        except RunFailed as e:
            raise Fatal('preset run failed (%s): %s' % (e.kind, e.error))
        generators.add(r['generator']); engines.add(r['engine'])
        done[json.dumps(PRESET, sort_keys=True)] = r
        catalog['preset'] = {'params': PRESET, 'path': 'preset/index.json', 'run_id': r['run_id'], 'elapsed_s': r['elapsed_s']}
        log('✅ preset %.1f s (run %s)' % (r['elapsed_s'], r['run_id']))
    elif old is not None:
        if old.get('preset'):
            shutil.copytree(out / 'preset', tmp / 'preset')
            catalog['preset'] = old['preset']
            generators.add(old.get('generator_sha256')); engines.add(old.get('engine'))

    for i, p in enumerate(points, 1):
        key = grid_key(p['seed'], p['diversion_share'], p['demand_scale'])
        entry = {'key': key, 'params': p}
        dest = tmp / 'grid' / (key + '.json')
        same = done.get(json.dumps(p, sort_keys=True))
        log('▶ grid %d/%d %s' % (i, len(points), key))
        if same:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(same['index_raw'])
            entry.update(status='complete', path='grid/%s.json' % key, run_id=same['run_id'], elapsed_s=same['elapsed_s'])
            log('✅ %s has the preset parameters; reusing run %s' % (key, same['run_id']))
        else:
            try:
                r = bake_one(api, p, dest, False, log)
                generators.add(r['generator']); engines.add(r['engine'])
                done[json.dumps(p, sort_keys=True)] = r
                entry.update(status='complete', path='grid/%s.json' % key, run_id=r['run_id'], elapsed_s=r['elapsed_s'])
                log('✅ %s %.1f s' % (key, r['elapsed_s']))
            except RunFailed as e:
                service_failures += e.kind == 'service'
                entry.update(status='failed', error_kind=e.kind, error=e.error[-3000:])
                log('❌ %s failed (%s): %s' % (key, e.kind, e.error.strip().splitlines()[0][:200] if e.error.strip() else ''))
        catalog['grid'].append(entry)
    if not points and old is not None:
        if old.get('grid'):
            if (out / 'grid').exists():
                shutil.copytree(out / 'grid', tmp / 'grid')
            catalog['grid'] = old['grid']
            generators.add(old.get('generator_sha256')); engines.add(old.get('engine'))
            service_failures += sum(1 for g in old['grid'] if g.get('error_kind') == 'service')

    generators.discard(None); engines.discard(None)
    if len(generators) > 1 or len(engines) > 1:
        # generator_sha256 is the hash of build_demo.py on disk at run time: editing the file or switching container versions mid-bake lands here
        raise Fatal('generator_sha256 / engine differ and cannot be mixed in one bake: %s %s (did build_demo.py or the container version '
                    'change mid-bake? Once stable, re-run everything without --only)' % (sorted(generators), sorted(engines)))
    if not generators:
        raise Fatal('no run succeeded; nothing to write')
    catalog.update(generated_at=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   engine=engines.pop(), generator_sha256=generators.pop())
    (tmp / 'baked.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    sizes = size_table(tmp, log)
    tmp.chmod(0o755)   # mkdtemp creates 0700
    swap_in(tmp, out)
    failed = [g['key'] for g in catalog['grid'] if g['status'] != 'complete']
    log('\n✅ wrote %s: %d files, %.2f MB, took %.0f s; grid %d/%d complete%s'
        % (out, sizes['files'], sizes['bytes'] / MB, time.monotonic() - t0,
           len(catalog['grid']) - len(failed), len(catalog['grid']), ('; failed: ' + ', '.join(failed)) if failed else ''))
    if service_failures:
        log('⚠️  %d grid points failed on service errors (not SUMO results): re-run with --only grid' % service_failures)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
