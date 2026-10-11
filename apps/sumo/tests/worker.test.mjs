// Purpose: tests src/proxy.js + src/worker.js with a fake container (fake Durable Object stub) and a fake rate limiter: whitelist,
//          POST only on /runs, header stripping, path rewriting, cache headers, rate limit, busy gate, error codes (including
//          plain-text errors from the @cloudflare/containers wrapper and serve.py JSON errors)
// Usage: node tests/worker.test.mjs (test.sh runs it); no npm install, no Docker, no network; the last line is always "N passed, M failed"
import * as nodeModule from 'node:module';
import * as proxy from '../src/proxy.js';

const { handle, parseRoute, IMMUTABLE, MAX_BODY, CONTAINER_ENV } = proxy;

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };
const BASE = 'https://hackathon-site.example.workers.dev';
const req = (path, init) => new Request(BASE + path, init);
const ID = '0123456789abcdef0123456789abcdef';
const J = { 'content-type': 'application/json' };
const noCors = (res) => ![...res.headers.keys()].some((k) => k.startsWith('access-control-'));

// Fake container: simulates serve.py by path; records every request it receives (including the body text)
function fakeStub(opts = {}) {
  const seen = [];
  const stub = {
    seen,
    async fetch(r) {
      const text = r.body ? await r.text() : '';
      seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, text });
      const u = new URL(r.url);
      if (opts.throws) throw opts.throws;
      if (u.pathname === '/sumo/v1/health') {
        if (opts.health) return opts.health();
        return new Response(JSON.stringify({ version: 1, engine: 'Eclipse SUMO sumo 1.27.1', status: 'ready', active_jobs: opts.active ?? 0 }), { status: 200, headers: J });
      }
      if (opts.reply) return opts.reply(u, r);
      if (u.pathname === '/sumo/v1/runs') return new Response(JSON.stringify({ version: 1, id: ID, status: 'queued' }), { status: 202, headers: J });
      return new Response(JSON.stringify({ path: u.pathname, search: u.search }), { status: 200, headers: { ...J, server: 'BaseHTTP/0.6 Python/3.12' } });
    },
  };
  return stub;
}
const fakeRL = (success = true) => {
  const keys = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } };
};
const run = (path, init, stub, env = {}) => handle(req(path, init), env, () => stub);
const isErr = async (res, status, code) => {
  const b = await res.json().catch(() => null);
  return res.status === status && b && b.ok === false && b.error === code && typeof b.msg === 'string' && b.msg.length > 0
    && (res.headers.get('content-type') || '').startsWith('application/json') && res.headers.get('cache-control') === 'no-store';
};
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

try {
  // ---- 0. worker.js: exports only default and SumoContainer; container class fields; always the single 'main' instance ----
  {
    const FAKE = new URL('./fake-containers.mjs', import.meta.url).href;
    const hook = (specifier, context, next) => (specifier === '@cloudflare/containers' ? { url: FAKE, shortCircuit: true } : next(specifier, context));
    if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ resolve: hook });
    else nodeModule.register('data:text/javascript,' + encodeURIComponent(
      `export async function resolve(s, c, n) { return s === '@cloudflare/containers' ? { url: ${JSON.stringify(FAKE)}, shortCircuit: true } : n(s, c); }`));
    const mod = await import('../src/worker.js');
    const fake = await import('./fake-containers.mjs');
    ok(JSON.stringify(Object.keys(mod).sort()) === '["SumoContainer","default"]', `src/worker.js exports only default and SumoContainer (actual: ${Object.keys(mod).join(', ')}; workerd treats every named export as an entrypoint)`);
    const c = new mod.SumoContainer({}, {});
    ok(c instanceof fake.Container, 'SumoContainer extends Container from @cloudflare/containers');
    ok(c.defaultPort === 8080 && c.envVars.PORT === String(c.defaultPort), `defaultPort = 8080 = envVars.PORT (${c.defaultPort} / ${c.envVars.PORT})`);
    ok(c.sleepAfter === '12h', `sleepAfter = 12h (${c.sleepAfter})`);
    ok(JSON.stringify(c.envVars) === JSON.stringify({ HOST: '0.0.0.0', PORT: '8080', SUMO_DATA_DIR: '/data', SUMO_KEEP_RUNS: '20', SUMO_REAL_JOBS: '4' }), `container environment ${JSON.stringify(c.envVars)}`);
    ok(!('ALLOW_ORIGINS' in c.envVars) && !('SUMO_API_KEY' in c.envVars), 'reverse: no ALLOW_ORIGINS / SUMO_API_KEY (the Worker strips Origin; the container has no public entry point)');
    ok(/\/sumo\/v1\/health$/.test(c.pingEndpoint), `start-up probe hits serve.py health (${c.pingEndpoint})`);

    const stub = fakeStub();
    const env = { SUMO_CONTAINER: { stub } };
    const res = await mod.default.fetch(req('/api/sumo/v1/health'), env);
    ok(res.status === 200 && stub.seen.length === 1 && fake.calls.length === 1 && fake.calls[0].binding === env.SUMO_CONTAINER && fake.calls[0].name === 'main',
      `default.fetch gets the container with getContainer(env.SUMO_CONTAINER, 'main') (${JSON.stringify(fake.calls.map((x) => x.name))})`);
    const miss = await mod.default.fetch(req('/api/sumo/v1/nope'), env);
    ok(miss.status === 404 && fake.calls.length === 1, 'a non-whitelisted path is a 404 and the container is never fetched (random probes cannot wake it)');
    const nobind = await quiet(() => mod.default.fetch(req('/api/sumo/v1/health'), {}));
    ok(await isErr(nobind, 502, 'sumo_down'), 'no SUMO_CONTAINER binding → 502 sumo_down (no crash)');
  }

  // ---- 1. Whitelist: allowed paths are rewritten unchanged to the container's /sumo/v1/… ----
  {
    const cases = [
      ['GET', '/api/sumo/v1/health', '/sumo/v1/health'],
      ['GET', `/api/sumo/v1/runs/${ID}`, `/sumo/v1/runs/${ID}`],
      ['GET', `/api/sumo/v1/runs/${ID}/index.json`, `/sumo/v1/runs/${ID}/index.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/baseline/manifest.json`, `/sumo/v1/runs/${ID}/baseline/manifest.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/closure/frames-000.json`, `/sumo/v1/runs/${ID}/closure/frames-000.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/guided/frames-123.json`, `/sumo/v1/runs/${ID}/guided/frames-123.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/footpath/manifest.json`, `/sumo/v1/runs/${ID}/footpath/manifest.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/frame?scenario=closure&t=118.9`, `/sumo/v1/runs/${ID}/frame`],
      // real network (contract v2): scenarios original / ai
      ['GET', `/api/sumo/v1/runs/${ID}/original/manifest.json`, `/sumo/v1/runs/${ID}/original/manifest.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/original/frames-014.json`, `/sumo/v1/runs/${ID}/original/frames-014.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/ai/manifest.json`, `/sumo/v1/runs/${ID}/ai/manifest.json`],
      ['GET', `/api/sumo/v1/runs/${ID}/ai/frames-000.json`, `/sumo/v1/runs/${ID}/ai/frames-000.json`],
    ];
    for (const [method, path, up] of cases) {
      const stub = fakeStub();
      const res = await run(path, { method }, stub);
      ok(res.status === 200 && stub.seen.length === 1 && stub.seen[0].url.pathname === up && stub.seen[0].method === method, `${method} ${path} → container ${up}`);
    }
    // query strings: only frame keeps its own; others are dropped (serve.py matches the whole path, so keeping one would cause a 404)
    const s1 = fakeStub();
    await run(`/api/sumo/v1/runs/${ID}/frame?scenario=closure&t=118.9`, {}, s1);
    ok(s1.seen[0].url.search === '?scenario=closure&t=118.9', `frame query string forwarded unchanged: ${s1.seen[0].url.search}`);
    const s2 = fakeStub();
    await run('/api/sumo/v1/health?nocache=123', {}, s2);
    ok(s2.seen[0].url.search === '' && s2.seen[0].url.pathname === '/sumo/v1/health', 'the query string of health?nocache=… is dropped; the container gets a clean /sumo/v1/health');
  }

  // ---- 2. Whitelist: every other path is 404 not_found without touching the container ----
  {
    const bad = [
      '/api/sumo', '/api/sumo/', '/api/sumo/v1', '/api/sumo/v1/', '/api/sumo/v2/health', '/api/sumo/v1/health/', '/api/sumo/v1/runs/',
      '/api/sumo/v1/HEALTH', `/api/sumo/v1/runs/${ID.toUpperCase()}`, `/api/sumo/v1/runs/${ID.slice(1)}`, `/api/sumo/v1/runs/${ID}0`,
      `/api/sumo/v1/runs/${ID}/job.json`, `/api/sumo/v1/runs/${ID}/raw/sumo.log`, `/api/sumo/v1/runs/${ID}/closure/frames-1.json`,
      `/api/sumo/v1/runs/${ID}/closure/frames-0001.json`, `/api/sumo/v1/runs/${ID}/unknown/manifest.json`, `/api/sumo/v1/runs/${ID}/closure/other.json`,
      `/api/sumo/v1/runs/${ID}/index.json.bak`, `/api/sumo/v1/runs/${ID}/index.json/`, `/api/sumo/v1/runs/${ID}/../../../etc/passwd`,
      `/api/sumo/v1/runs/${ID}/%2e%2e/job.json`, `/api/sumo/v1/runs/${ID}/closure%2fmanifest.json`, '/api/sumo/v1/health%00', '/sumo/v1/health', '/api/sumox/v1/health',
      // real-network scenario names are accepted only as full lower-case names
      `/api/sumo/v1/runs/${ID}/AI/manifest.json`, `/api/sumo/v1/runs/${ID}/aix/manifest.json`, `/api/sumo/v1/runs/${ID}/originals/manifest.json`,
      `/api/sumo/v1/runs/${ID}/xai/frames-000.json`, `/api/sumo/v1/runs/${ID}/ai/frames-00.json`, `/api/sumo/v1/runs/${ID}/original/index.json`, `/api/sumo/v1/runs/${ID}/real/manifest.json`,
    ];
    for (const path of bad) {
      const stub = fakeStub();
      const res = await run(path, {}, stub);
      ok((await isErr(res, 404, 'not_found')) && stub.seen.length === 0, `GET ${path} → 404 not_found, container received nothing`);
    }
    ok(parseRoute(`/api/sumo/v1/runs/${ID}/closure/frames-007.json`).immutable === true && parseRoute('/api/sumo/v1/health').immutable === false, 'parseRoute: frames are cacheable, health is not');
  }

  // ---- 3. Methods: GET / HEAD are read-only; POST only on /runs; 405 carries Allow and does not touch the container ----
  {
    const cases = [
      ['POST', '/api/sumo/v1/health', 'GET, HEAD'], ['GET', '/api/sumo/v1/runs', 'POST'], ['HEAD', '/api/sumo/v1/runs', 'POST'],
      ['PUT', '/api/sumo/v1/runs', 'POST'], ['OPTIONS', '/api/sumo/v1/runs', 'POST'], ['POST', `/api/sumo/v1/runs/${ID}`, 'GET, HEAD'],
      ['DELETE', `/api/sumo/v1/runs/${ID}`, 'GET, HEAD'], ['PATCH', `/api/sumo/v1/runs/${ID}/index.json`, 'GET, HEAD'], ['OPTIONS', '/api/sumo/v1/health', 'GET, HEAD'],
      ['POST', `/api/sumo/v1/runs/${ID}/frame?scenario=closure&t=1`, 'GET, HEAD'],
    ];
    for (const [method, path, allow] of cases) {
      const stub = fakeStub();
      const init = method === 'POST' || method === 'PUT' || method === 'PATCH' ? { method, headers: J, body: '{}' } : { method };
      const res = await run(path, init, stub, { SUMO_RL: fakeRL() });
      ok(res.headers.get('allow') === allow && (await isErr(res, 405, 'method_not_allowed')) && stub.seen.length === 0, `${method} ${path} → 405 method_not_allowed, Allow: ${allow}`);
    }
    const stub = fakeStub();
    const h = await run(`/api/sumo/v1/runs/${ID}/index.json`, { method: 'HEAD' }, stub);
    ok(h.status === 200 && h.body === null && stub.seen[0].method === 'HEAD' && h.headers.get('cache-control') === IMMUTABLE, 'HEAD index.json: HEAD forwarded as-is, no body, same cache header as GET');
  }

  // ---- 4. Header stripping: Origin / Cookie / Authorization never reach the container, other headers pass unchanged; responses carry no stray container headers and no CORS ----
  {
    const stub = fakeStub();
    const res = await run(`/api/sumo/v1/runs/${ID}`, {
      headers: { origin: 'https://evil.example', cookie: 'sid=secret', authorization: 'Bearer xyz', 'x-trace': 'keep-me', 'accept-language': 'zh-CN' },
    }, stub);
    const hs = stub.seen[0].headers;
    ok(!hs.has('origin') && !hs.has('cookie') && !hs.has('authorization'), 'the request forwarded to the container has no Origin / Cookie / Authorization');
    ok(hs.get('x-trace') === 'keep-me' && hs.get('accept-language') === 'zh-CN', 'other request headers are forwarded unchanged');
    ok(res.headers.get('server') === null && noCors(res), 'the response has no container Server header and no Access-Control-* at all (same origin)');
    const h = proxy.stripHeaders(new Headers({ Origin: 'x', COOKIE: 'y', Authorization: 'z', 'Content-Type': 'application/json' }));
    ok([...h.keys()].join(',') === 'content-type', `stripHeaders is case-insensitive: left with ${[...h.keys()].join(',')}`);
  }

  // ---- 5. Cache headers: a 200 for a completed index / manifest / frames is cached for a day, everything else no-store ----
  {
    const immut = [`/api/sumo/v1/runs/${ID}/index.json`, `/api/sumo/v1/runs/${ID}/closure/manifest.json`, `/api/sumo/v1/runs/${ID}/guided/frames-002.json`,
      `/api/sumo/v1/runs/${ID}/original/manifest.json`, `/api/sumo/v1/runs/${ID}/ai/frames-009.json`];
    for (const p of immut) {
      const res = await run(p, {}, fakeStub());
      ok(res.status === 200 && res.headers.get('cache-control') === IMMUTABLE, `${p.replace(ID, '<id>')} → cache-control: ${res.headers.get('cache-control')}`);
    }
    const store = ['/api/sumo/v1/health', `/api/sumo/v1/runs/${ID}`, `/api/sumo/v1/runs/${ID}/frame?scenario=closure&t=1`];
    for (const p of store) {
      const res = await run(p, {}, fakeStub());
      ok(res.status === 200 && res.headers.get('cache-control') === 'no-store', `${p.replace(ID, '<id>')} → no-store`);
    }
    const post = await run('/api/sumo/v1/runs', { method: 'POST', headers: J, body: '{}' }, fakeStub());
    ok(post.status === 202 && post.headers.get('cache-control') === 'no-store', 'the 202 from POST /runs → no-store');
    const early = await run(`/api/sumo/v1/runs/${ID}/index.json`, {}, fakeStub({ reply: () => new Response('{"error":"Run is not complete; query its status first"}', { status: 409, headers: J }) }));
    ok(await isErr(early, 409, 'not_ready'), 'reading index.json before completion: container 409 → 409 not_ready, and no-store (the error is not cached for a day)');
  }

  // ---- 6. health passes through unchanged: not a single byte added ----
  {
    const raw = '{"version": 1, "engine": "Eclipse SUMO sumo 1.27.1", "status": "ready", "active_jobs": 1}';
    const stub = fakeStub({ health: () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }) });
    const res = await run('/api/sumo/v1/health', {}, stub);
    ok(res.status === 200 && (await res.text()) === raw && res.headers.get('content-type') === 'application/json', 'health: status, content-type and body are exactly what the container sent');
  }

  // ---- 7. POST /runs: body limit → per-IP rate limit → busy gate → forward ----
  {
    const body = JSON.stringify({ seed: 42, demand_scale: 1.2, clearance_s: 600, diversion_share: 0.3 });
    const post = (extra = {}) => ({ method: 'POST', headers: { ...J, 'cf-connecting-ip': '203.0.113.7', origin: BASE, ...(extra.headers || {}) }, body: extra.body ?? body });

    // normal: ask health first, then forward the POST unchanged
    {
      const stub = fakeStub({ active: 1 });
      const RL = fakeRL(true);
      const res = await run('/api/sumo/v1/runs', post(), stub, { SUMO_RL: RL });
      const b = await res.json();
      ok(res.status === 202 && b.id === ID, `normal POST → 202 (as returned by the container) ${JSON.stringify(b)}`);
      ok(stub.seen.length === 2 && stub.seen[0].url.pathname === '/sumo/v1/health' && stub.seen[0].method === 'GET' && stub.seen[1].url.pathname === '/sumo/v1/runs', 'order: GET health first (busy gate), then POST /sumo/v1/runs');
      ok(stub.seen[1].method === 'POST' && stub.seen[1].text === body && stub.seen[1].headers.get('content-type') === 'application/json' && !stub.seen[1].headers.has('origin'),
        'the POST body and content-type reach the container unchanged, Origin removed');
      ok(RL.keys.length === 1 && RL.keys[0] === '203.0.113.7', `rate-limit key = CF-Connecting-IP (${RL.keys[0]})`);
    }
    // real network (contract v2): new fields reach the container unchanged; the Worker neither filters nor rewrites them
    {
      const real = JSON.stringify({ network: 'real', seed: 7, p_original: 0.14, p_ai: 0.53, scenarios: ['baseline', 'original', 'ai'] });
      const stub = fakeStub({ active: 0 });
      const res = await run('/api/sumo/v1/runs', post({ body: real }), stub, { SUMO_RL: fakeRL(true) });
      ok(res.status === 202 && stub.seen.length === 2 && stub.seen[1].url.pathname === '/sumo/v1/runs' && stub.seen[1].text === real,
        `real-network POST: {network:'real', seed, p_original, p_ai, scenarios} reaches the container byte for byte (${stub.seen[1] && stub.seen[1].text.length} bytes)`);
      const busy = fakeStub({ active: 2 });
      ok((await isErr(await run('/api/sumo/v1/runs', post({ body: real }), busy, {}), 429, 'sumo_busy')) && busy.seen.length === 1, 'real-network POST also goes through the busy gate: active_jobs = 2 → 429 sumo_busy');
      const limited = fakeStub();
      ok((await isErr(await run('/api/sumo/v1/runs', post({ body: real }), limited, { SUMO_RL: fakeRL(false) }), 429, 'sumo_rate')) && limited.seen.length === 0, 'real-network POST is rate-limited too: hit → 429 sumo_rate, container received nothing');
      const bigReal = JSON.stringify({ network: 'real', seed: 1, p_original: 0.1, p_ai: 0.5, scenarios: Array(400).fill('ai') });
      ok(bigReal.length > MAX_BODY && (await isErr(await run('/api/sumo/v1/runs', post({ body: bigReal }), fakeStub(), {}), 413, 'too_big')), `real-network POST is subject to the ${MAX_BODY}-byte limit too (${bigReal.length} bytes → 413)`);
      const bad = fakeStub({ reply: () => new Response(JSON.stringify({ error: 'p_ai must be a number in [0, 1]' }), { status: 400, headers: J }) });
      const rb = await run('/api/sumo/v1/runs', post({ body: JSON.stringify({ network: 'real', p_ai: 2 }) }), bad, {});
      const bb = await rb.clone().json();
      ok((await isErr(rb, 400, 'bad_request')) && bb.msg.includes('p_ai must be a number in [0, 1]'), `serve.py rejects real-network parameters → 400 bad_request, reason kept in msg: ${bb.msg}`);
    }
    // body too large: no rate-limit count, container untouched
    {
      const stub = fakeStub(); const RL = fakeRL(true);
      const big = JSON.stringify({ seed: 42, pad: 'x'.repeat(MAX_BODY) });
      const res = await run('/api/sumo/v1/runs', post({ body: big }), stub, { SUMO_RL: RL });
      ok((await isErr(res, 413, 'too_big')) && stub.seen.length === 0 && RL.keys.length === 0, `body ${big.length} bytes > ${MAX_BODY} → 413 too_big, container untouched and no rate-limit quota used`);
      const exact = JSON.stringify({ seed: 42, pad: 'x'.repeat(MAX_BODY - JSON.stringify({ seed: 42, pad: '' }).length) });
      const res2 = await run('/api/sumo/v1/runs', post({ body: exact }), fakeStub(), {});
      ok(exact.length === MAX_BODY && res2.status === 202, `exactly ${MAX_BODY} bytes is allowed`);
      // chunked upload without content-length: counted while streaming
      const chunks = [new TextEncoder().encode('{"a":"'), new Uint8Array(MAX_BODY).fill(120), new TextEncoder().encode('"}')];
      const stream = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
      const s3 = fakeStub();
      const res3 = await run('/api/sumo/v1/runs', { method: 'POST', headers: J, body: stream, duplex: 'half' }, s3, {});
      ok((await isErr(res3, 413, 'too_big')) && s3.seen.length === 0, 'chunked upload (no content-length) over the limit is also 413');
      const res4 = await run('/api/sumo/v1/runs', { method: 'POST', headers: { ...J, 'content-length': String(MAX_BODY + 1) }, body: '{}' }, fakeStub(), {});
      ok(await isErr(res4, 413, 'too_big'), 'a declared content-length over the limit is an immediate 413');
    }
    // rate limit hit
    {
      const stub = fakeStub(); const RL = fakeRL(false);
      const res = await run('/api/sumo/v1/runs', post(), stub, { SUMO_RL: RL });
      ok(res.headers.get('retry-after') === '60' && (await isErr(res, 429, 'sumo_rate')) && stub.seen.length === 0, 'rate limit hit → 429 sumo_rate, Retry-After 60, container received no request at all');
      const noip = fakeRL(true);
      await run('/api/sumo/v1/runs', { method: 'POST', headers: J, body }, fakeStub(), { SUMO_RL: noip });
      ok(noip.keys[0] === 'unknown', 'without CF-Connecting-IP (local) the rate-limit key is unknown, no crash');
    }
    // no limiter bound → skipped; limiter throws → let through (the busy gate still backs it up)
    {
      const res = await run('/api/sumo/v1/runs', post(), fakeStub(), {});
      ok(res.status === 202, 'no SUMO_RL binding: rate limit skipped, 202 as usual');
      const broken = { limit: async () => { throw new Error('rl down'); } };
      const res2 = await quiet(() => run('/api/sumo/v1/runs', post(), fakeStub(), { SUMO_RL: broken }));
      ok(res2.status === 202, 'SUMO_RL.limit throws: let through, 202 as usual');
    }
    // busy gate
    {
      const stub = fakeStub({ active: 2 });
      const res = await run('/api/sumo/v1/runs', post(), stub, { SUMO_RL: fakeRL(true) });
      ok((await isErr(res, 429, 'sumo_busy')) && stub.seen.length === 1 && stub.seen[0].url.pathname === '/sumo/v1/health', 'active_jobs = 2 → 429 sumo_busy, POST not forwarded to the container');
      const s5 = fakeStub({ active: 5 });
      ok(await isErr(await run('/api/sumo/v1/runs', post(), s5, {}), 429, 'sumo_busy'), 'active_jobs = 5 → 429 sumo_busy');
      const starting = fakeStub({ health: () => new Response('There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count (set in wrangler config) or are you currently provisioning the Container.', { status: 503 }) });
      const r2 = await run('/api/sumo/v1/runs', post(), starting, {});
      ok(r2.headers.get('retry-after') === '10' && (await isErr(r2, 503, 'sumo_starting')) && starting.seen.length === 1, 'container still provisioning when the busy gate asks health (503 text) → 503 sumo_starting, POST not forwarded');
      const weird = fakeStub({ health: () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
      ok(await isErr(await run('/api/sumo/v1/runs', post(), weird, {}), 502, 'sumo_down'), 'busy gate gets a non-JSON health → 502 sumo_down');
      const thrown = fakeStub({ throws: new Error('Network connection lost.') });
      ok(await isErr(await quiet(() => run('/api/sumo/v1/runs', post(), thrown, {})), 502, 'sumo_down'), 'container throws during the busy gate → 502 sumo_down');
    }
  }

  // ---- 8. Error codes: wrapper text errors and serve.py JSON errors both become { ok:false, error, msg } ----
  {
    const text = (status, t) => fakeStub({ reply: () => new Response(t, { status }) });
    const js = (status, obj) => fakeStub({ reply: () => new Response(JSON.stringify(obj), { status, headers: J }) });
    const P1 = `/api/sumo/v1/runs/${ID}`;
    const cases = [
      [text(503, 'There is no Container instance available at this time.'), 503, 'sumo_starting', 'wrapper 503 (still provisioning / no instance)'],
      [text(500, 'Failed to start container: Container did not start after 8000ms'), 503, 'sumo_starting', 'wrapper 500 "did not start"'],
      [text(500, 'Failed to start container: the container is not listening on port 8080'), 503, 'sumo_starting', 'wrapper 500 "not listening"'],
      [text(429, 'you are requesting too many containers per second'), 503, 'sumo_starting', 'wrapper 429 (platform start-up rate limit)'],
      [text(500, 'Container suddenly disconnected, try again'), 502, 'sumo_down', 'wrapper 500 "suddenly disconnected"'],
      [text(500, 'Error proxying request to container: INTERNAL-xyz'), 502, 'sumo_down', 'wrapper 500 "Error proxying"'],
      [text(502, 'Bad Gateway'), 502, 'sumo_down', 'other non-JSON 5xx'],
      [js(404, { error: 'Run not found' }), 404, 'not_found', 'serve.py 404 Run not found (old id after a container restart)'],
      [js(409, { error: 'Run is not complete; query its status first' }), 409, 'not_ready', 'serve.py 409'],
      [js(400, { error: 'demand_scale must be a number in [0.1, 1.2]' }), 400, 'bad_request', 'serve.py 400 parameter out of range'],
      [js(415, { error: 'Use application/json' }), 415, 'bad_request', 'serve.py 415'],
      [js(413, { error: 'JSON body must be between 1 and 16384 bytes' }), 413, 'too_big', 'serve.py 413'],
      [js(429, { error: 'Queue full; retry when an active run completes' }), 429, 'sumo_busy', 'serve.py 429 Queue full'],
      [js(429, { error: 'Too many new runs from this address; wait a minute' }), 429, 'sumo_rate', 'serve.py 429 Too many new runs'],
      [js(500, { error: 'boom' }), 502, 'sumo_down', 'serve.py 500 JSON'],
    ];
    for (const [stub, status, code, what] of cases) {
      const res = await quiet(() => run(P1, {}, stub));
      ok(await isErr(res, status, code), `${what} → ${status} ${code}`);
    }
    const detail = await (await run(P1, {}, js(400, { error: 'demand_scale must be a number in [0.1, 1.2]' }))).json();
    ok(detail.msg.includes('demand_scale must be a number in [0.1, 1.2]'), `serve.py's English reason stays in msg: ${detail.msg}`);
    const leak = await (await quiet(() => run(P1, {}, text(500, 'Error proxying request to container: INTERNAL-xyz')))).text();
    ok(!leak.includes('INTERNAL-xyz'), 'reverse: internal wrapper error details never reach the browser');
    const already = await run(P1, {}, js(418, { ok: false, error: 'teapot', msg: 'already in the repo format' }));
    ok(already.status === 418 && (await already.json()).error === 'teapot', 'an error already in the repo format is passed through unchanged (keeps working if serve.py changes format)');
    const thrown = await quiet(() => run(P1, {}, fakeStub({ throws: new Error('INTERNAL-abc Network connection lost.') })));
    const tb = await thrown.text();
    ok(thrown.status === 502 && JSON.parse(tb).error === 'sumo_down' && !tb.includes('INTERNAL-abc'), 'stub.fetch throws → 502 sumo_down, no details leaked');
    const thrown2 = await quiet(() => run(P1, {}, fakeStub({ throws: new Error('there is no container instance that can be provided to this durable object') })));
    ok(await isErr(thrown2, 503, 'sumo_starting'), 'stub.fetch throws "no container instance" → 503 sumo_starting');
    const getThrows = await quiet(() => handle(req(P1), {}, () => { throw new Error('no binding'); }));
    ok(await isErr(getThrows, 502, 'sumo_down'), 'getting the container stub throws → 502 sumo_down');
  }

  // ---- 9. Constants match the interface spec ----
  ok(MAX_BODY === 2048 && proxy.BUSY_JOBS === 2 && IMMUTABLE === 'public, max-age=86400, immutable', `constants: body ≤ ${MAX_BODY}, busy gate ${proxy.BUSY_JOBS}, ${IMMUTABLE}`);
  ok(CONTAINER_ENV.HOST === '0.0.0.0' && CONTAINER_ENV.PORT === '8080' && CONTAINER_ENV.SUMO_DATA_DIR === '/data' && CONTAINER_ENV.SUMO_KEEP_RUNS === '20' && Object.isFrozen(CONTAINER_ENV), 'CONTAINER_ENV has the expected HOST / PORT / SUMO_DATA_DIR / SUMO_KEEP_RUNS values and is frozen');

  // ---- 10. Options mode: manifest / frames of opt-A … opt-E are allowed and cacheable; other spellings are 404; the options body reaches the container unchanged ----
  {
    for (const sc of ['opt-A', 'opt-C', 'opt-E']) {
      for (const file of ['manifest.json', 'frames-000.json', 'frames-042.json']) {
        const path = `/api/sumo/v1/runs/${ID}/${sc}/${file}`;
        const stub = fakeStub();
        const res = await run(path, {}, stub);
        ok(res.status === 200 && stub.seen.length === 1 && stub.seen[0].url.pathname === `/sumo/v1/runs/${ID}/${sc}/${file}` && res.headers.get('cache-control') === IMMUTABLE,
          `GET <id>/${sc}/${file} → container, cache-control one day`);
      }
    }
    const bad = ['opt-F', 'opt-a', 'opt-AB', 'opt-', 'OPT-A', 'opt_A', 'optA', 'opt-A-', 'xopt-A', 'opt-Z'].map((sc) => `/api/sumo/v1/runs/${ID}/${sc}/manifest.json`)
      .concat([`/api/sumo/v1/runs/${ID}/opt-A/frames-1.json`, `/api/sumo/v1/runs/${ID}/opt-A/index.json`, `/api/sumo/v1/runs/${ID}/opt-A/../job.json`, `/api/sumo/v1/runs/${ID}/opt-A/manifest.json/`]);
    for (const path of bad) {
      const stub = fakeStub();
      const res = await run(path, {}, stub);
      ok((await isErr(res, 404, 'not_found')) && stub.seen.length === 0, `GET ${path.replace(ID, '<id>')} → 404 not_found, container received nothing`);
    }
    const five = JSON.stringify({ network: 'real', seed: 2147483647, options: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, p: 0.123456789012 })), frames: false });
    const stub = fakeStub({ active: 0 });
    const res = await run('/api/sumo/v1/runs', { method: 'POST', headers: { ...J, 'cf-connecting-ip': '203.0.113.9' }, body: five }, stub, { SUMO_RL: fakeRL(true) });
    ok(res.status === 202 && stub.seen.length === 2 && stub.seen[1].url.pathname === '/sumo/v1/runs' && stub.seen[1].text === five && five.length < MAX_BODY / 4,
      `options-mode POST {network, seed, options×5, frames} reaches the container byte for byte (${five.length} bytes, well under ${MAX_BODY})`);
    const busy = fakeStub({ active: 2 });
    ok((await isErr(await run('/api/sumo/v1/runs', { method: 'POST', headers: J, body: five }, busy, {}), 429, 'sumo_busy')) && busy.seen.length === 1, 'options-mode POST also goes through the busy gate: active_jobs = 2 → 429 sumo_busy');
  }
} catch (e) {
  F++;
  console.log('❌ the test itself crashed: ' + (e && e.stack));
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
