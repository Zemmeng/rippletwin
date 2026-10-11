// Routing and forwarding for hackathon-sumo (D-0930-1700): whitelist, header stripping, rate limit, busy gate, error codes and cache headers all live here.
// Imports no Cloudflare module, so Node can test it directly; worker.js hands the container in as getStub() (the tests pass a fake).
// Public path /api/sumo/v1/X (forwarded unchanged by the site Worker) → container path /sumo/v1/X (apps/web/tools/sumo/serve.py).
// Every error is { ok:false, error, msg } (docs/reference/interfaces.md, error format); the container's own {error:'<English sentence>'} is converted to this format here too.

export const PUBLIC_PREFIX = '/api/sumo/v1';
export const UPSTREAM_PREFIX = '/sumo/v1';
export const UPSTREAM_ORIGIN = 'http://sumo-container'; // any host name works: the Container class forwards by port only and serve.py ignores Host
export const MAX_BODY = 2048; // request body limit for POST /runs (bytes); serve.py allows 16 KB, this is tighter. Real-network {network,seed,p_original,p_ai,scenarios} and options-mode {network,seed,options,frames} bodies (5 options ≈ 150 bytes) pass through unchanged; fields are not filtered here (serve.py's validate_real does that)
export const BUSY_JOBS = 2; // this many jobs in the container at once (queued + running) → 429 sumo_busy
export const IMMUTABLE = 'public, max-age=86400, immutable'; // run ids are random 32-hex strings and outputs never change once complete
export const STRIP_HEADERS = ['origin', 'cookie', 'authorization']; // if Origin were kept, serve.py would answer 403 (ALLOW_ORIGINS is empty)

// Container environment at start-up (SumoContainer.envVars in worker.js; the Dockerfile ENV sets the same values, so change both together)
export const CONTAINER_ENV = Object.freeze({ HOST: '0.0.0.0', PORT: '8080', SUMO_DATA_DIR: '/data', SUMO_KEEP_RUNS: '20', SUMO_REAL_JOBS: '4' }); // 4 = vCPUs of a standard-4 instance

const GET = Object.freeze(['GET', 'HEAD']); // HEAD is a GET without the body; serve.py supports it
const ID = '[0-9a-f]{32}';
// The four synthetic 2×2 scenarios + original / ai of the real network (contract v2, network:'real') + opt-A … opt-E of options mode; baseline is shared
const SCENARIO = '(?:baseline|closure|guided|footpath|original|ai|opt-[A-E])';
// Whitelist: only these paths ever reach the container; anything else is a 404 and never wakes it
const ROUTES = [
  { kind: 'health', re: /^health$/, methods: GET },
  { kind: 'runs', re: /^runs$/, methods: Object.freeze(['POST']) },
  { kind: 'run', re: new RegExp(`^runs/(${ID})$`), methods: GET },
  { kind: 'index', re: new RegExp(`^runs/(${ID})/index\\.json$`), methods: GET, immutable: true },
  { kind: 'output', re: new RegExp(`^runs/(${ID})/${SCENARIO}/(?:manifest|frames-\\d{3})\\.json$`), methods: GET, immutable: true },
  { kind: 'frame', re: new RegExp(`^runs/(${ID})/frame$`), methods: GET, query: true },
];

// Path → route (null if not whitelisted). Only frame keeps its query string (scenario, t); others drop it because serve.py matches the whole path
export function parseRoute(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PUBLIC_PREFIX + '/')) return null;
  const rest = pathname.slice(PUBLIC_PREFIX.length + 1);
  for (const r of ROUTES) {
    const m = r.re.exec(rest);
    if (m) return { kind: r.kind, id: m[1] || null, methods: r.methods, immutable: !!r.immutable, keepQuery: !!r.query, upstream: `${UPSTREAM_PREFIX}/${rest}` };
  }
  return null;
}

// Request headers for the container: copied as-is, minus Origin / Cookie / Authorization
export function stripHeaders(headers) {
  const out = new Headers(headers);
  for (const h of STRIP_HEADERS) out.delete(h);
  return out;
}

// Cache header for successful responses: only a 200 for a completed index / manifest / frames-NNN is cacheable (one day); everything else is no-store
export const cacheControlFor = (route, status) => (route && route.immutable && status === 200 ? IMMUTABLE : 'no-store');

export function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// docs/reference/interfaces.md, error format
export const fail = (status, error, msg, extra) => json({ ok: false, error, msg }, status, extra);

const MSG = {
  not_found: 'No such endpoint',
  method_not_allowed: 'This endpoint does not support this request method',
  too_big: `Request body too large (limit ${MAX_BODY} bytes)`,
  sumo_rate: 'At most 3 live SUMO runs per minute from the same network; try again later or use the pre-computed results',
  sumo_busy: 'Live SUMO is busy (2 jobs already running); try again later or use the pre-computed results',
  sumo_down: 'The live SUMO container is not responding; use the pre-computed results instead',
  sumo_starting: 'The live SUMO container is starting (a few minutes after a fresh deploy); try again later or use the pre-computed results',
};
const RETRY = { sumo_rate: '60', sumo_busy: '15', sumo_starting: '10' };
const failCode = (status, code, msg = MSG[code]) => fail(status, code, msg, RETRY[code] ? { 'retry-after': RETRY[code] } : undefined);

// Plain-text errors from the @cloudflare/containers wrapper (not serve.py JSON): not provisioned yet / not started / port not ready → starting; anything else → down
const STARTING_RE = /no container instance|provisioning|did not start|not listening|failed to verify port|too many containers/i;
export function wrapperError(status, text) {
  if (status === 503 || status === 429 || STARTING_RE.test(text || '')) return failCode(503, 'sumo_starting');
  return failCode(502, 'sumo_down');
}

// serve.py JSON error {error:'<English sentence>'} → repo format; the original text goes in brackets in msg for diagnosis
export function containerError(status, detail) {
  const d = String(detail || '').slice(0, 300);
  const tail = d ? ` (${d})` : '';
  if (status >= 500) return failCode(502, 'sumo_down', MSG.sumo_down + tail);
  if (status === 404) return failCode(404, 'not_found', 'No such run or file (old run ids stop working after a container restart)' + tail);
  if (status === 409) return failCode(409, 'not_ready', 'This run has not finished yet; check its status first' + tail);
  if (status === 413) return failCode(413, 'too_big', MSG.too_big + tail);
  if (status === 429) return /too many/i.test(d) ? failCode(429, 'sumo_rate', MSG.sumo_rate + tail) : failCode(429, 'sumo_busy', MSG.sumo_busy + tail);
  return failCode(status, 'bad_request', 'Invalid parameters' + tail);
}

// Container response with status ≥ 400 → error in the repo format
export async function upstreamError(res) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text().catch(() => '');
  if (!type.includes('application/json')) return wrapperError(res.status, text);
  let body = null;
  try { body = JSON.parse(text); } catch { return wrapperError(res.status, text); }
  // already in the repo format (keeps working if serve.py changes): pass it through unchanged
  if (body && body.ok === false && typeof body.error === 'string' && typeof body.msg === 'string') return json(body, res.status);
  return containerError(res.status, body && (body.error || body.msg));
}

// stub.fetch threw (Durable Object unreachable, container class failed to construct, etc.)
export function thrownError(e) {
  const text = e && e.message ? e.message : String(e);
  console.error('SUMO container request threw', text);
  return STARTING_RE.test(text) ? failCode(503, 'sumo_starting') : failCode(502, 'sumo_down');
}

// Read the request body; returns null above max bytes (counts while streaming, never buffers a large body whole)
export async function readCapped(request, max = MAX_BODY) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// 3 per IP per minute (ratelimits SUMO_RL in wrangler.jsonc); skipped when unbound (local / tests), and fails open if the limiter itself errors (the busy gate still follows)
export async function overRateLimit(env, request) {
  const rl = env && env.SUMO_RL;
  if (!rl || typeof rl.limit !== 'function') return false;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await rl.limit({ key });
    return success === false;
  } catch (e) {
    console.error('SUMO_RL rate limiter failed; letting the request through', e && e.message);
    return false;
  }
}

// Busy gate: ask the container's health first; active_jobs ≥ BUSY_JOBS → 429; container not up / erroring → the matching error. null = let through
export async function busyGate(stub) {
  let res;
  try {
    res = await stub.fetch(new Request(`${UPSTREAM_ORIGIN}${UPSTREAM_PREFIX}/health`, { method: 'GET' }));
  } catch (e) {
    return thrownError(e);
  }
  if (res.status >= 400) return upstreamError(res);
  let h = null;
  try { h = await res.json(); } catch { /* handled below as a bad response */ }
  if (!h || typeof h.active_jobs !== 'number') return failCode(502, 'sumo_down', MSG.sumo_down + ' (bad health response)');
  if (h.active_jobs >= BUSY_JOBS) return failCode(429, 'sumo_busy');
  return null;
}

// Entry point: request = the request forwarded unchanged by the site Worker; getStub() returns the container's Durable Object stub (called only after the whitelist passes, so random paths never wake the container)
export async function handle(request, env = {}, getStub) {
  const url = new URL(request.url);
  const route = parseRoute(url.pathname);
  if (!route) return failCode(404, 'not_found');
  const method = request.method.toUpperCase();
  if (!route.methods.includes(method)) return fail(405, 'method_not_allowed', MSG.method_not_allowed, { allow: route.methods.join(', ') });

  let stub;
  try {
    stub = getStub();
  } catch (e) {
    return thrownError(e);
  }

  let body;
  if (method === 'POST') {
    body = await readCapped(request, MAX_BODY);
    if (body === null) return failCode(413, 'too_big');
    if (await overRateLimit(env, request)) return failCode(429, 'sumo_rate');
    const gate = await busyGate(stub);
    if (gate) return gate;
  }

  const target = `${UPSTREAM_ORIGIN}${route.upstream}${route.keepQuery ? url.search : ''}`;
  let res;
  try {
    res = await stub.fetch(new Request(target, { method, headers: stripHeaders(request.headers), body }));
  } catch (e) {
    return thrownError(e);
  }
  if (res.status >= 400) return upstreamError(res);

  // Success: status, content-type and body unchanged; the container's other response headers (Server etc.) are not passed on
  const headers = new Headers({ 'cache-control': cacheControlFor(route, res.status) });
  const type = res.headers.get('content-type');
  if (type) headers.set('content-type', type);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
}
