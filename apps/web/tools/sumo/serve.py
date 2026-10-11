#!/usr/bin/env python3
"""SUMO job API. Native engine execution; no frontend files are written.
Local by default; in the cloud the same file runs in a Cloudflare Container behind Worker hackathon-sumo.
Two networks: POST {} (or network:'synthetic') = the 2×2 demo of build_demo.py, unchanged;
POST {network:'real', seed?, p_original?, p_ai?, scenarios?} = the real CBD network of build_real.py (contract v2);
POST {network:'real', seed?, options:[{id:'A'…'E', p}], frames?:false} = baseline + one scenario opt-<id> per plan option."""
import argparse
import importlib
import importlib.util
import collections
import functools
import hmac
import json
import math
import os
import re
import shutil
import signal
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import build_demo as model

PREFIX = '/sumo/v1'
MAX_BODY = 16384
RUN_ID = r'[0-9a-f]{32}'
# Output file whitelist: the four synthetic 2×2 scenarios + original / ai of the real network (contract v2) + opt-A … opt-E of options mode; any other path is a 404, so raw/ and job.json are never readable
OUTPUT_FILE = r'(index\.json|(?:baseline|closure|guided|footpath|original|ai|opt-[A-E])/(?:manifest|frames-\d{3})\.json)'
NETWORKS = ('synthetic', 'real')
# docs/reference/interfaces.md, error format: the Worker passes container errors through, so they carry the same short codes.
CODES = {400: 'bad_request', 401: 'bad_key', 403: 'bad_origin', 404: 'not_found', 409: 'not_ready',
         413: 'too_big', 415: 'bad_type', 429: 'sumo_busy', 500: 'sumo_error'}


class ApiError(Exception):
    def __init__(self, status, message, code=None):
        self.status, self.message, self.code = status, message, code or CODES.get(status, 'error')


def now():
    return datetime.now(timezone.utc).isoformat()


@functools.lru_cache(maxsize=8)
def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


class FileJson(dict):
    """Output files are sent as their original bytes (.raw): the chunk sha256 values in the manifest are computed over the file bytes, so re-serialising would break the browser's check; the dict itself is for tests and frame_at."""


@functools.lru_cache(maxsize=8)
def read_file(path):
    raw = path.read_bytes()
    value = FileJson(json.loads(raw))
    value.raw = raw
    return value


def frame_at(output, scenario, time):
    if scenario not in model.SCENARIOS or not math.isfinite(time) or time < 0:
        raise ApiError(400, 'Unknown scenario, or t is not a non-negative number')
    path = output / scenario / 'manifest.json'
    if not path.exists(): raise ApiError(404, 'This run has no such scenario')
    meta = read_json(path)
    frame = {'t': time, 'a': [], 'q': [], 'signals': {}, 'counts': {}}
    if time < meta['duration_s'] and meta['chunks']:
        chunk = next((c for c in reversed(meta['chunks']) if c['start'] <= time), meta['chunks'][0])
        frames = read_json(output / scenario / chunk['file'])['frames']
        frame = next((f for f in reversed(frames) if f['t'] <= time), frames[0])
    agents = []
    for row in frame['a']:
        item = meta['agents'][row[0]]
        agents.append({'id': item['id'], 'kind': item['kind'], 'length_m': item['length'], 'width_m': item['width'],
                       'x_m': row[1] / 100, 'y_m': row[2] / 100, 'angle_deg': row[3], 'speed_mps': row[4] / 100,
                       'lane_id': meta['geometry']['lanes'][row[5]]['id'] if row[5] >= 0 else None})
    return {'version': 1, 'scenario': scenario, 'requested_time_s': time, 'time_s': frame['t'],
            'done': time >= meta['duration_s'], 'position_reference': 'center', 'agents': agents,
            'signals': frame['signals'], 'counts': frame['counts'],
            'queues': [{'lane_id': meta['geometry']['lanes'][i]['id'], 'length_m': length} for i, length in frame['q']]}


def load_real():
    # Lazy: build_real is imported only on the first network:'real' request (it needs the apps/roads data; if that is missing only the real network is affected, not the 2×2)
    return importlib.import_module('build_real')


class Jobs:
    def __init__(self, root, engine, runner=None, limit=4, keep=20, real=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.engine, self.runner, self.limit, self.keep = engine, runner or model.build, limit, max(int(keep), 1)
        self._real = real  # fake build_real injected by tests (must have validate_real / build); None = import on first use
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='sumo')
        self.active = 0
        # Interrupted jobs never pretend to still be progressing after a restart.
        for file in self.root.glob('*/job.json'):
            value = json.loads(file.read_text())
            if value.get('status') in ('queued', 'running'):
                self.update(value, status='failed', error='Service restarted before the run finished')
        self.prune()

    def update(self, job, **fields):
        with self.lock:
            job.update(fields, updated_at=now())
            folder = self.root / job['id']; folder.mkdir(exist_ok=True)
            temp = folder / 'job.tmp'
            model.dump(temp, job)
            temp.replace(folder / 'job.json')

    def get(self, run_id):
        if not re.fullmatch(RUN_ID, run_id): raise ApiError(404, 'No such run')
        file = self.root / run_id / 'job.json'
        with self.lock:
            if not file.exists(): raise ApiError(404, 'No such run (it may have been pruned, or the service restarted)')
            return json.loads(file.read_text())

    def real(self):
        if self._real is None:
            try: self._real = load_real()
            except Exception as e: raise ApiError(500, 'This service has no real-network model (build_real.py or the apps/roads data is missing): ' + str(e)[-300:]) from e
        return self._real

    def networks(self):
        # Report only what can actually run: without build_real.py in the image there is only synthetic (so the page falls back straight away instead of waiting 90 s for nothing)
        real = self._real is not None or importlib.util.find_spec('build_real') is not None
        return list(NETWORKS) if real else ['synthetic']

    def configure(self, payload):
        """The synthetic config is exactly as before (no network field); the real-network config = {'network':'real', **validate_real(remaining fields)}."""
        network = payload.get('network', 'synthetic') if isinstance(payload, dict) else 'synthetic'
        if network not in NETWORKS: raise ValueError('network must be synthetic or real')
        rest = {k: v for k, v in payload.items() if k != 'network'} if isinstance(payload, dict) and 'network' in payload else payload
        if network == 'synthetic': return model.validate_config(rest)
        return {'network': 'real', **self.real().validate_real(rest)}

    def create(self, payload):
        try: config = self.configure(payload)
        except (ValueError, TypeError) as e: raise ApiError(400, 'Invalid parameters: ' + str(e), 'bad_config') from e
        with self.lock:
            if self.active >= self.limit: raise ApiError(429, 'Queue full; retry when an active run completes', 'sumo_busy')
            self.active += 1
            job = {'version': 1, 'id': uuid.uuid4().hex, 'status': 'queued', 'created_at': now(), 'config': config}
            self.update(job)
            snapshot = dict(job)
            self.pool.submit(self.execute, job)
        return snapshot

    def execute(self, job):
        root = self.root / job['id']
        try:
            self.update(job, status='running')
            config = dict(job['config'])
            runner = self.real().build if config.pop('network', 'synthetic') == 'real' else self.runner
            args = SimpleNamespace(**config, output=root / 'output', work_dir=root / 'raw')
            runner(args)
            if not (root / 'output/index.json').exists(): raise RuntimeError('No complete result index was produced')
            self.update(job, status='complete', result=f"{PREFIX}/runs/{job['id']}/index.json")
            shutil.rmtree(root / 'raw', ignore_errors=True)  # ~300 MB of SUMO XML per default run; output/ keeps the replay
        except Exception as e:
            # Never mistaken for a successful run: partial output goes; logs, command and demand stay in raw/ for diagnosis.
            self.update(job, status='failed', error=str(e)[-3000:])
            shutil.rmtree(root / 'output', ignore_errors=True)
            for f in (root / 'raw').rglob('*.xml'):
                try:
                    if f.stat().st_size > 1_000_000: f.unlink()
                except OSError: pass
        finally:
            with self.lock: self.active -= 1
            self.prune()

    def prune(self):
        # Keep only the newest `keep` finished runs (complete or failed); older run ids then answer 404.
        with self.lock:
            done = []
            for file in self.root.glob('*/job.json'):
                try: job = json.loads(file.read_text())
                except (OSError, ValueError): continue
                if job.get('status') in ('complete', 'failed'): done.append((job.get('updated_at', ''), file.parent))
            for _, folder in sorted(done)[:-self.keep]:
                shutil.rmtree(folder, ignore_errors=True)

    def output(self, run_id, job=None):
        job = job or self.get(run_id)
        if job['status'] != 'complete': raise ApiError(409, 'Run is not complete; query its status first')
        return self.root / run_id / 'output'

    def route(self, method, target, payload=None):
        parsed = urlsplit(target)
        path = parsed.path
        if method == 'GET' and path == PREFIX + '/health':
            return 200, {'version': 1, 'engine': self.engine, 'status': 'ready', 'active_jobs': self.active, 'networks': self.networks()}
        if path == PREFIX + '/runs' and method == 'POST': return 202, self.create(payload)
        match = re.fullmatch(PREFIX + '/runs/(' + RUN_ID + r')(?:/(.*))?', path)
        if method != 'GET' or not match: raise ApiError(404, 'No such endpoint')
        run_id, resource = match.groups()
        job = self.get(run_id)
        if not resource: return 200, job
        output = self.output(run_id, job)
        if resource == 'frame':
            # The single-frame endpoint understands only the 2×2 manifest format; for the real network read manifest.json + the frames-NNN.json chunks (contract v2)
            if job['config'].get('network') == 'real': raise ApiError(404, 'Real-network runs have no frame endpoint; read <scenario>/manifest.json and frames-NNN.json')
            query = parse_qs(parsed.query)
            if set(query) != {'scenario', 't'} or any(len(v) != 1 for v in query.values()):
                raise ApiError(400, 'Only the query parameters scenario and t are accepted, once each')
            try: time = float(query['t'][0])
            except ValueError as e: raise ApiError(400, 't must be a non-negative number') from e
            return 200, frame_at(output, query['scenario'][0], time)
        if not re.fullmatch(OUTPUT_FILE, resource):
            raise ApiError(404, 'No such output file')
        file = output / resource
        if not file.exists(): raise ApiError(404, 'No such output file')
        return 200, read_file(file)

    def close(self, wait=True):
        # wait=False (SIGTERM): queued runs are dropped, the running one still finishes before the process exits.
        self.pool.shutdown(wait=wait, cancel_futures=not wait)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value):
        data = getattr(value, 'raw', None) or (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))+'\n').encode()
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin and origin in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if self.command == 'OPTIONS':
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(data)

    def handle_request(self):
        try:
            origin = self.headers.get('Origin')
            if origin and origin not in self.server.origins: raise ApiError(403, 'Origin not allowed')
            if self.command == 'OPTIONS': return self.reply(200, {'ok': True})
            key = getattr(self.server, 'api_key', '')
            # Bytes compare: a non-ASCII header must not crash hmac.compare_digest.
            if key and urlsplit(self.path).path != PREFIX + '/health' and \
                    not hmac.compare_digest(self.headers.get('X-Sumo-Key', '').encode(), key.encode()):
                raise ApiError(401, 'Missing or wrong X-Sumo-Key')
            payload = None
            if self.command == 'POST':
                if self.headers.get_content_type() != 'application/json': raise ApiError(415, 'Use application/json')
                try: size = int(self.headers.get('Content-Length', '0'))
                except ValueError as e: raise ApiError(400, 'Invalid Content-Length') from e
                if size <= 0 or size > MAX_BODY: raise ApiError(413, f'JSON body must be between 1 and {MAX_BODY} bytes')
                try: payload = json.loads(self.rfile.read(size))
                except (ValueError, UnicodeError) as e: raise ApiError(400, 'Request body is not valid JSON', 'bad_json') from e
                self.rate_limit()
            try: status, value = self.server.jobs.route('GET' if self.command == 'HEAD' else self.command, self.path, payload)
            except ApiError: raise
            except Exception as e:  # e.g. a run pruned mid-read: answer instead of dropping the connection
                self.log_error('%s %s failed: %r', self.command, self.path, e)
                raise ApiError(500, 'Error while reading the result; try again later') from e
            self.reply(status, value)
        except ApiError as e:
            self.reply(e.status, {'ok': False, 'error': e.code, 'msg': e.message})

    def rate_limit(self):
        per_min = getattr(self.server, 'posts_per_min', 0)
        if per_min <= 0: return
        # Behind a proxy the socket peer is the proxy; X-Client-IP is trusted only from a caller holding the key.
        ip = (self.headers.get('X-Client-IP') if getattr(self.server, 'api_key', '') else None) or self.client_address[0]
        posts = self.server.posts
        with self.server.posts_lock:
            now_s = time.monotonic()
            if len(posts) > 1024:
                for stale in [k for k, v in posts.items() if not v or now_s - v[-1] > 60]: del posts[stale]
            hits = posts.setdefault(ip, collections.deque())
            while hits and now_s - hits[0] > 60: hits.popleft()
            if len(hits) >= per_min: raise ApiError(429, 'Too many new runs from this address; wait a minute', 'sumo_rate')
            hits.append(now_s)

    do_GET = do_POST = do_OPTIONS = do_HEAD = handle_request


def make_server(port, jobs, origins=(), host='127.0.0.1', api_key='', posts_per_min=0):
    # A stalled client cannot pin a handler thread forever (set here, not on Handler: the tests' fake socket has no timeout).
    server = ThreadingHTTPServer((host, port), type('TimedHandler', (Handler,), {'timeout': 30}))
    server.jobs, server.origins, server.api_key = jobs, set(origins), api_key
    server.posts_per_min, server.posts, server.posts_lock = posts_per_min, {}, threading.Lock()
    return server


def settings(argv=None, env=None):
    """Flags win over environment variables; the container image only sets the environment."""
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default=env.get('HOST') or '127.0.0.1')
    parser.add_argument('--port', type=int, default=env.get('PORT') or '8021')
    parser.add_argument('--data-dir', type=Path, default=env.get('SUMO_DATA_DIR') or None, required=not env.get('SUMO_DATA_DIR'))
    parser.add_argument('--allow-origin', action='append',
                        default=[o.strip() for o in env.get('ALLOW_ORIGINS', '').split(',') if o.strip()])
    parser.add_argument('--keep-runs', type=int, default=env.get('SUMO_KEEP_RUNS') or '20')
    # Off by default: behind the Worker every request comes from the same proxy address, and the Worker limits per viewer IP.
    parser.add_argument('--posts-per-min', type=int, default=env.get('SUMO_POSTS_PER_MIN') or '0')
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535 or args.keep_runs < 1 or args.posts_per_min < 0:
        parser.error('need 0 <= port <= 65535, keep-runs >= 1, posts-per-min >= 0')
    args.api_key = env.get('SUMO_API_KEY', '')  # secrets only via the environment, never argv
    return args


if __name__ == '__main__':
    args = settings()
    _, engine = model.binaries()
    jobs = Jobs(args.data_dir, engine, keep=args.keep_runs)
    server = make_server(args.port, jobs, args.allow_origin, args.host, args.api_key, args.posts_per_min)
    # Platforms stop containers with SIGTERM; as PID 1, Python would otherwise ignore it until SIGKILL.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(f'SUMO API ready: http://{args.host}:{server.server_port}{PREFIX}/health origins={sorted(server.origins)} '
          f'key={"set" if args.api_key else "none"} keep={jobs.keep} posts_per_min={args.posts_per_min or "off"}', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        server.server_close()
        jobs.close(wait=False)  # leftovers stay queued on disk and are marked failed on the next start
