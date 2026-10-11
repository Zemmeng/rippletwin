// Purpose: test src/worker.js with fake ASSETS / API / SUMO bindings: static pass-through, /api/sumo/* to SUMO or 503 / 502,
//          /api/* forwarded or 503, /api/health self-report, no CORS
// Usage: node tests/worker.test.mjs (test.sh runs it); no wrangler, no network; the last line is always "N passed, M failed"
import * as mod from '../src/worker.js';

const worker = mod.default;
const VERSION = 'site-0.1';

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };
const BASE = 'https://hackathon-site.example.workers.dev';
const req = (path, init) => new Request(BASE + path, init);

// Fake binding: records each request it receives and returns a recognisable response
const fake = (tag) => {
  const seen = [];
  return { seen, fetch: async (r) => { seen.push(r); return new Response(`${tag}:${new URL(r.url).pathname}`, { status: 200, headers: { 'x-from': tag } }); } };
};
const noCors = (res) => ![...res.headers.keys()].some((k) => k.startsWith('access-control-'));

try {
  // ---- 0. workerd treats every named export as an entrypoint: exporting a string or plain function stops the Worker from starting (tested: Incorrect type for map entry) ----
  ok(JSON.stringify(Object.keys(mod)) === '["default"]', `src/worker.js exports only default (actual: ${Object.keys(mod).join(', ')})`);

  // ---- 1. No API binding (API Worker not deployed yet) ----
  {
    const ASSETS = fake('assets');
    const env = { ASSETS };

    const h = await worker.fetch(req('/api/health'), env);
    const hb = await h.json();
    ok(h.status === 200 && hb.ok === true && hb.v === VERSION && hb.mock === true && hb.api === false, `no API binding: /api/health 200 ${JSON.stringify(hb)}`);
    ok((h.headers.get('content-type') || '').startsWith('application/json') && h.headers.get('cache-control') === 'no-store', '/api/health is JSON and no-store');

    const r = await worker.fetch(req('/api/read', { method: 'POST', body: '{"persona":"commuter"}' }), env);
    const rb = await r.json();
    ok(r.status === 503 && rb.ok === false && rb.error === 'api_not_deployed' && typeof rb.msg === 'string' && rb.msg.length > 0, `no API binding: POST /api/read → 503 ${rb.error} (interfaces, error format)`);
    const bare = await worker.fetch(req('/api'), env);
    ok(bare.status === 503, 'no API binding: /api (no trailing slash) also returns 503 JSON and does not fall through to static files');
    ok(ASSETS.seen.length === 0, 'negative: no /api/* request reached ASSETS (an HTML page is never served as an API response)');
    ok(noCors(h) && noCors(r), 'negative: /api responses carry no Access-Control-* header (same origin, CORS off on purpose)');
  }

  // ---- 2. Static files pass straight through to ASSETS ----
  {
    const ASSETS = fake('assets');
    const env = { ASSETS };
    for (const p of ['/', '/sim/public/', '/roads/public/cbd/network.json', '/engine/public/js/index.js', '/apiary', '/api/public/js/reader.js']) {
      const q = req(p);
      const res = await worker.fetch(q, env);
      ok(res.status === 200 && (await res.text()) === `assets:${p}` && ASSETS.seen.at(-1) === q, `${p} → ASSETS receives the same request unchanged`);
    }
    const none = await worker.fetch(req('/sim/public/'), {});
    ok(none.status === 500 && (await none.json()).error === 'no_assets', 'no ASSETS binding → 500 JSON no_assets (a lost config is obvious at a glance)');
  }

  // ---- 3. API bound: /api/* forwarded unchanged, /api/public/* still static ----
  {
    const ASSETS = fake('assets'), API = fake('api');
    const env = { ASSETS, API };
    const q = req('/api/read?x=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"persona":"local"}' });
    const res = await worker.fetch(q, env);
    const got = API.seen[0];
    ok(res.status === 200 && (await res.text()) === 'api:/api/read' && res.headers.get('x-from') === 'api', 'API bound: the POST /api/read response comes unchanged from the API Worker');
    ok(got === q && got.method === 'POST' && new URL(got.url).search === '?x=1' && (await got.text()) === '{"persona":"local"}', 'the original request is forwarded: method, query string and body unchanged');
    const h = await worker.fetch(req('/api/health'), env);
    ok((await h.text()) === 'api:/api/health', 'API bound: /api/health goes to the API Worker (no more api:false self-report)');
    const s = await worker.fetch(req('/api/public/js/reader.js'), env);
    ok((await s.text()) === 'assets:/api/public/js/reader.js' && API.seen.length === 2, 'API bound: /api/public/* (static files from apps/api/public/) still goes to ASSETS, not forwarded');
    ok(ASSETS.seen.length === 1, 'negative: with API bound, neither /api/read nor /api/health reached ASSETS');
  }

  // ---- 4. API Worker error: 502 JSON, internal error text never reaches the browser ----
  {
    const API = { fetch: async () => { throw new Error('INTERNAL-DETAIL-xyz'); } };
    const origErr = console.error; console.error = () => {};
    const res = await worker.fetch(req('/api/read', { method: 'POST', body: '{}' }), { ASSETS: fake('assets'), API });
    console.error = origErr;
    const text = await res.text();
    const body = JSON.parse(text);
    ok(res.status === 502 && body.ok === false && body.error === 'api_unreachable', 'API Worker throws → 502 JSON api_unreachable');
    ok(!text.includes('INTERNAL-DETAIL-xyz') && !text.includes('at '), 'negative: the 502 response has no internal error text or stack trace');
  }

  // ---- 5. /api/sumo and /api/sumo/* go to SUMO (hackathon-sumo), ahead of /api/* → API ----
  {
    const ASSETS = fake('assets'), API = fake('api'), SUMO = fake('sumo');
    const env = { ASSETS, API, SUMO };
    const q = req('/api/sumo/v1/health');
    const res = await worker.fetch(q, env);
    ok(res.status === 200 && (await res.text()) === 'sumo:/api/sumo/v1/health' && res.headers.get('x-from') === 'sumo', 'SUMO bound: the /api/sumo/v1/health response comes unchanged from the SUMO Worker');
    ok(SUMO.seen[0] === q && API.seen.length === 0 && ASSETS.seen.length === 0, 'negative: /api/sumo/v1/health reached neither API nor ASSETS; SUMO received the same request');

    // POST with Origin / Cookie: site strips no headers and keeps the path (header stripping and the allowlist live in hackathon-sumo)
    const p = req('/api/sumo/v1/runs?x=1', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: 'a=1' }, body: '{"seed":42}' });
    await worker.fetch(p, env);
    const got = SUMO.seen[1];
    ok(got === p && got.method === 'POST' && new URL(got.url).pathname === '/api/sumo/v1/runs' && new URL(got.url).search === '?x=1' && (await got.text()) === '{"seed":42}', 'POST /api/sumo/v1/runs: the original request is forwarded, /api/sumo prefix kept, query string and body unchanged');

    const bare = await worker.fetch(req('/api/sumo'), env);
    ok((await bare.text()) === 'sumo:/api/sumo' && SUMO.seen.length === 3, '/api/sumo (no trailing slash) also goes to SUMO');

    for (const x of ['/api/sumoX', '/api/sumo-v1/health', '/api/sumo.json']) {
      const r = await worker.fetch(req(x), env);
      ok((await r.text()) === `api:${x}`, `negative: ${x} is not /api/sumo/*, so it goes to the API as usual`);
    }
    ok(SUMO.seen.length === 3, 'negative: none of the three /api/sumoX-style paths above reached SUMO');

    const h = await worker.fetch(req('/api/health'), env);
    const rd = await worker.fetch(req('/api/read', { method: 'POST', body: '{}' }), env);
    ok((await h.text()) === 'api:/api/health' && (await rd.text()) === 'api:/api/read', 'with SUMO bound, /api/health and /api/read still go to the API (existing forwarding unchanged)');
    const s = await worker.fetch(req('/api/public/js/reader.js'), env);
    const b = await worker.fetch(req('/sumo/public/baked/baked.json'), env);
    ok((await s.text()) === 'assets:/api/public/js/reader.js' && (await b.text()) === 'assets:/sumo/public/baked/baked.json' && SUMO.seen.length === 3,
      '/api/public/* and the pre-computed /sumo/public/baked/* stay static and never reach SUMO');
  }

  // ---- 6. No SUMO binding (hackathon-sumo not deployed / binding removed): 503 sumo_off, the page uses the pre-computed results; never falls through to the API ----
  {
    const ASSETS = fake('assets'), API = fake('api');
    for (const [label, env] of [['API bound, SUMO not bound', { ASSETS, API }], ['neither bound', { ASSETS }], ['SUMO is not a binding', { ASSETS, API, SUMO: {} }]]) {
      const res = await worker.fetch(req('/api/sumo/v1/runs', { method: 'POST', body: '{}' }), env);
      const body = await res.json();
      ok(res.status === 503 && body.ok === false && body.error === 'sumo_off' && /pre-computed/.test(body.msg || '') && res.headers.get('cache-control') === 'no-store',
        `${label}: POST /api/sumo/v1/runs → 503 sumo_off, msg points to the pre-computed results (${body.msg})`);
    }
    const h = await worker.fetch(req('/api/sumo/v1/health'), { ASSETS, API });
    ok(h.status === 503 && (await h.json()).error === 'sumo_off', 'no SUMO binding: /api/sumo/v1/health is also 503 sumo_off (never turned into a 404 or similar by the API)');
    ok(API.seen.length === 0 && ASSETS.seen.length === 0, 'negative: without a SUMO binding, /api/sumo/* reached neither API nor ASSETS');
  }

  // ---- 7. SUMO Worker throws: 502 sumo_down, internal error text never reaches the browser ----
  {
    const API = fake('api');
    const SUMO = { fetch: async () => { throw new Error('INTERNAL-SUMO-detail'); } };
    const origErr = console.error; console.error = () => {};
    const res = await worker.fetch(req('/api/sumo/v1/runs', { method: 'POST', body: '{}' }), { ASSETS: fake('assets'), API, SUMO });
    console.error = origErr;
    const text = await res.text();
    const body = JSON.parse(text);
    ok(res.status === 502 && body.ok === false && body.error === 'sumo_down' && /pre-computed/.test(body.msg || ''), 'SUMO Worker throws → 502 JSON sumo_down, msg points to the pre-computed results');
    ok(!text.includes('INTERNAL-SUMO-detail') && !text.includes('at ') && noCors(res), 'negative: the 502 response has no internal error text, stack trace or CORS header');
    ok(API.seen.length === 0, 'negative: after SUMO throws, the request does not fall back to the API');
  }
} catch (e) {
  F++;
  console.log('❌ the test itself crashed: ' + (e && e.stack));
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
