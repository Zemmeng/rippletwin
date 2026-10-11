// Purpose: tests public/js/sumo-client.js with a fake fetch. A healthy cloud goes live; health failures, rate limits, busy, failed runs,
//          timeouts, cancellations and 404s all fall back to pre-computed results with the reason recorded; nearest grid point;
//          manifest / chunk URLs and sha256; a pre-computed result is never labelled live under any circumstances;
//          real CBD network (contract v2): loadReal / runReal / realManifest / realChunk with both sources, fallback reasons and copy (§11–§15);
//          runOptions (§16)
// Usage: node apps/sumo/tests/client.test.mjs (test.sh runs it); no network, no wrangler; the last line is always "N passed, M failed"
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSumoClient, labels, sourceLabel, reasonLabel, SCENARIOS, DEFAULT_PARAMS, realLabels, realSourceLabel, REAL_SCENARIOS, REAL_DEFAULTS, REAL_TIMEOUT_MS, OPTION_IDS } from '../public/js/sumo-client.js';

let P = 0, F = 0;
const ok = (cond, msg) => { if (cond) { P++; console.log('✅ ' + msg); } else { F++; console.log('❌ ' + msg); } };

const RID = 'a'.repeat(32);
const ENGINE = 'Eclipse SUMO sumo 1.27.1';
const FAIL_TEXT = 'Simulation integrity failure footpath: {"collisions": 1} [\'collision\']';
const PRESET = { seed: 42, scenarios: [...SCENARIOS], demand_duration_s: 600, clearance_s: 1200, demand_scale: 1.0, diversion_share: 0.45 };
const idx = (tag, extra = {}) => ({ version: 1, engine: ENGINE, tag, scenarios: SCENARIOS.map((id) => ({ id, manifest: `${id}/manifest.json`, metrics: {} })), ...extra });
const keyOf = (d, x) => `s42-d${d.toFixed(2)}-x${x.toFixed(1)}`;

// ---- Pre-computed files (bake.py layout; s42-d0.60-x1.2 deliberately recorded as failed) ----
const grid = [];
const files = {};
for (const d of [0, 0.15, 0.3, 0.45, 0.6]) for (const x of [0.8, 1.0, 1.2]) {
  const key = keyOf(d, x), params = { ...PRESET, diversion_share: d, demand_scale: x };
  if (d === 0.6 && x === 1.2) { grid.push({ key, params, status: 'failed', error_kind: 'sumo', error: FAIL_TEXT }); continue; }
  grid.push({ key, params, status: 'complete', path: `grid/${key}.json` });
  files[`grid/${key}.json`] = idx(key, { source: 'live' }); // even if the file says live, it must not override baked
}
files['baked.json'] = { version: 1, generated_at: '2026-09-30T08:00:00+00:00', source: 'cloudflare-container', engine: ENGINE, generator_sha256: 'f'.repeat(64), preset: { params: PRESET, path: 'preset/index.json' }, grid };
files['preset/index.json'] = idx('preset');
const CHUNK = { frames: [{ t: 0, a: [], q: [], signals: {}, counts: {} }] };
const CHUNK_SHA = createHash('sha256').update(JSON.stringify(CHUNK)).digest('hex');
files['preset/closure/manifest.json'] = { scenario: 'closure', chunks: [{ file: 'frames-000.json', sha256: CHUNK_SHA, frames: 1 }] };
files['preset/closure/frames-000.json'] = CHUNK;

// ---- Pre-computed real-network files (contract v2): /sumo/public/real/ ----
const WORKS = { link: 'l595594354_9756035316', lanes_closed: 1 };
const realIdx = (tag, extra = {}) => ({
  version: 2, network: 'real', engine: ENGINE, generator_sha256: 'e'.repeat(64), seed: 42, hour: 8, works: WORKS, tag,
  params: { seed: 42, p_original: 0.14, p_ai: 0.53 }, assumptions: { en: ['a'], zh: ['甲'] },
  scenarios: REAL_SCENARIOS.map((id) => ({ id, label: { en: id, zh: id }, diversion_share: id === 'ai' ? 0.53 : id === 'original' ? 0.14 : 0, manifest: `${id}/manifest.json`, metrics: {} })), ...extra,
});
const RCHUNK = { frames: [{ t: 0, a: [[0, 144963000, -37812000, 90, 850]], tls: { J1: 'GGrr' }, q: 12.5 }] };
const RCHUNK_TEXT = JSON.stringify(RCHUNK);
const RCHUNK_SHA = createHash('sha256').update(RCHUNK_TEXT).digest('hex');
const rman = (sc) => ({ version: 2, network: 'real', scenario: sc, duration_s: 60, sample_s: 1, clock0_s: 180, agent_columns: ['i', 'lon_e6', 'lat_e6', 'angle_deg', 'speed_cms'], agents: [{ id: 'v0', type: 'car', length_m: 4.5, width_m: 1.8 }], signal_heads: [], chunks: [{ file: 'frames-000.json', start: 0, end: 59, sha256: RCHUNK_SHA }], metrics: {}, per_minute: { halting: [], harsh: [] } });
const realFiles = { 'index.json': realIdx('baked', { source: 'live' }) }; // even if the file says live, it must not override baked
for (const sc of REAL_SCENARIOS) { realFiles[`${sc}/manifest.json`] = rman(sc); realFiles[`${sc}/frames-000.json`] = RCHUNK; }

const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// never answers until aborted (simulates a hung container)
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

// Fake server: o.health / o.post / o.poll can be replaced; o.polls are the statuses returned in turn; o.bakedDown makes the static files unreachable too
function fake(o = {}) {
  const calls = [];
  const polls = [...(o.polls || ['running', 'complete'])];
  const fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body });
    if (init.signal && init.signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (u.startsWith('/sumo/public/real/')) {
      if (o.realDown) throw new TypeError('fetch failed');
      const f = o.realFiles ? o.realFiles[u.slice('/sumo/public/real/'.length)] : realFiles[u.slice('/sumo/public/real/'.length)];
      return f === undefined ? new Response('Not found', { status: 404 }) : json(200, f);
    }
    if (u.startsWith('/sumo/public/baked/')) {
      if (o.bakedDown) throw new TypeError('fetch failed');
      const f = files[u.slice('/sumo/public/baked/'.length)];
      return f === undefined ? new Response('Not found', { status: 404 }) : json(200, f);
    }
    if (u === '/api/sumo/v1/health') return o.health ? o.health(init) : json(200, { version: 1, engine: ENGINE, status: 'ready', active_jobs: 0 });
    if (u === '/api/sumo/v1/runs' && method === 'POST') return o.post ? o.post(init) : json(202, { version: 1, id: RID, status: 'queued' });
    if (u === `/api/sumo/v1/runs/${RID}`) {
      if (o.poll) return o.poll(init);
      const st = polls.length > 1 ? polls.shift() : polls[0];
      return json(200, { id: RID, status: st, ...(st === 'failed' ? { error: FAIL_TEXT } : {}) });
    }
    if (u === `/api/sumo/v1/runs/${RID}/index.json`) return o.index ? o.index(init) : json(200, idx('live', { config: { ...PRESET, diversion_share: 0.3 } }));
    if (u === `/api/sumo/v1/runs/${RID}/closure/manifest.json`) return json(200, { scenario: 'closure', chunks: [] });
    if (u.startsWith(`/api/sumo/v1/runs/${RID}/`)) {
      const f = realFiles[u.slice(`/api/sumo/v1/runs/${RID}/`.length)];
      if (f !== undefined) return u.endsWith('.json') && f.frames ? new Response(RCHUNK_TEXT, { status: 200, headers: { 'content-type': 'application/json' } }) : json(200, f);
    }
    return json(404, { ok: false, error: 'not_found', msg: 'no route ' + u });
  };
  return { fetch, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}
const client = (f, extra = {}) => createSumoClient({ fetch: f.fetch, pollMs: 5, timeoutMs: 2000, ...extra });
const neverLive = (r, msg) => ok(r.source === 'baked' && sourceLabel(r, 'zh') === labels.zh.baked && sourceLabel(r, 'en') === labels.en.baked
  && !/实时|Live/.test(sourceLabel(r, 'zh') + sourceLabel(r, 'en')) && r.runId === undefined, `${msg}: source=baked, copy says pre-computed, no runId`);

try {
  // ---- 1. Healthy cloud: health → POST → queued/running/complete → index ----
  {
    const f = fake({ polls: ['queued', 'running', 'running', 'complete'] });
    const phases = [];
    const r = await client(f).run({ diversion_share: 0.3, evil: 1, scenarios: undefined }, { onStatus: (s) => phases.push(s.phase) });
    ok(r.source === 'live' && r.runId === RID && r.index.tag === 'live' && r.index.scenarios.length === 4 && r.hasReplay === true, `live: source=live, runId and index correct (${r.source} ${r.reason || ''})`);
    ok(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 && r.reason === undefined, `live: elapsedMs=${Math.round(r.elapsedMs)}, no reason`);
    ok(/^云端实时运行 · 用时 \d+\.\d s$/.test(sourceLabel(r, 'zh')) && /^Live cloud run · \d+\.\d s$/.test(sourceLabel(r, 'en')), `live copy: ${sourceLabel(r, 'zh')} / ${sourceLabel(r, 'en')}`);
    const body = JSON.parse(f.posts()[0].body);
    ok(JSON.stringify(body) === '{"diversion_share":0.3}', `POST carries only whitelisted fields, no undefined: ${JSON.stringify(body)}`);
    ok(['health', 'submit', 'queued', 'running', 'complete', 'done'].every((p) => phases.includes(p)) && phases.every((p, i) => p !== phases[i - 1]), `onStatus phases: ${phases.join(' → ')} (each status reported once)`);
    ok(f.calls.every((c) => !c.url.startsWith('/sumo/public/baked/')), 'a successful live run does not fetch pre-computed files');
    const m = await client(f).manifest(r, 'closure');
    ok(f.calls.at(-1).url === `/api/sumo/v1/runs/${RID}/closure/manifest.json` && Array.isArray(m.chunks), 'live manifest comes from /api/sumo/v1/runs/<id>/<scenario>/manifest.json');
    const h = await client(f).health();
    ok(h.ok === true && h.engine === ENGINE && h.activeJobs === 0, 'health() → ok, engine, activeJobs');
  }

  // ---- 2. Health check fails → pre-computed result, no POST ----
  for (const [name, health, reason] of [
    ['unreachable (fetch throws)', () => { throw new TypeError('fetch failed'); }, 'network'],
    ['503 sumo_off', () => json(503, { ok: false, error: 'sumo_off', msg: 'live SUMO service not bound' }), 'sumo_off'],
    ['502 sumo_down', () => json(502, { ok: false, error: 'sumo_down', msg: 'not responding' }), 'sumo_down'],
    ['503 sumo_starting', () => json(503, { ok: false, error: 'sumo_starting', msg: 'starting' }), 'sumo_starting'],
    ['200 but HTML', () => new Response('<!doctype html>', { status: 200 }), 'bad_response'],
    ['hangs (health check times out)', hang, 'timeout'],
  ]) {
    const f = fake({ health });
    const t0 = Date.now();
    const r = await client(f, { timeoutMs: 150 }).run({ diversion_share: 0.3, demand_scale: 0.8 });
    ok(r.reason === reason && r.key === 's42-d0.30-x0.8' && r.exact === true && f.posts().length === 0, `health ${name} → baked, reason=${r.reason}, nearest grid point ${r.key}, no POST`);
    neverLive(r, `health ${name}`);
    if (reason === 'timeout') ok(Date.now() - t0 < 1500, `health timeout honours timeoutMs (${Date.now() - t0} ms)`);
  }

  // ---- 3. POST rejected: 429 rate limit / busy, 400 parameters ----
  for (const [name, post, reason, text] of [
    ['429 sumo_rate', () => json(429, { ok: false, error: 'sumo_rate', msg: 'at most 3 per minute' }), 'sumo_rate', 'at most 3 per minute'],
    ['429 sumo_busy', () => json(429, { ok: false, error: 'sumo_busy', msg: 'busy' }), 'sumo_busy', 'busy'],
    ['container 429 Queue full', () => json(429, { error: 'Queue full; retry when an active run completes' }), 'sumo_busy', 'Queue full'],
    ['400 parameter out of range', () => json(400, { error: 'demand_scale must be a number in [0.1, 1.2]' }), 'bad_params', 'demand_scale'],
    ['POST hangs', hang, 'timeout', ''],
  ]) {
    const f = fake({ post });
    const r = await client(f, { timeoutMs: 300 }).run({ diversion_share: 0.15, demand_scale: 1.2 });
    ok(r.reason === reason && r.key === 's42-d0.15-x1.2' && (!text || String(r.error).includes(text)), `POST ${name} → baked, reason=${r.reason}, error "${String(r.error).slice(0, 40)}"`);
    neverLive(r, `POST ${name}`);
  }

  // ---- 4. Run fails → pre-computed result + the server's own words ----
  {
    const f = fake({ polls: ['running', 'failed'] });
    const r = await client(f).run({ diversion_share: 0, demand_scale: 1.0 });
    ok(r.reason === 'sumo_failed' && r.error === FAIL_TEXT && r.liveRunId === RID && r.key === 's42-d0.00-x1.0', `run failed → baked, reason=sumo_failed, error verbatim: ${r.error.slice(0, 50)}…`);
    neverLive(r, 'run failed');
  }

  // ---- 5. Timeout: stuck in running → pre-computed after 45 s (120 ms here) ----
  {
    const f = fake({ polls: ['running'] });
    const t0 = Date.now();
    const r = await client(f, { timeoutMs: 120, pollMs: 10 }).run({});
    ok(r.reason === 'timeout' && r.key === 'preset' && r.hasReplay === true && r.liveRunId === RID, `stuck in running → baked, reason=timeout, falls back to the preset (${Date.now() - t0} ms)`);
    ok(Date.now() - t0 < 1500, 'timeout honours timeoutMs instead of spinning forever');
    neverLive(r, 'timeout');
    const g = fake({ poll: hang });
    const r2 = await client(g, { timeoutMs: 150 }).run({});
    ok(r2.reason === 'timeout' && r2.source === 'baked', `a hung poll request also falls back at the overall limit (reason=${r2.reason})`);
  }

  // ---- 6. Poll 404 (a container restart lost the run) / user cancels ----
  {
    const f = fake({ poll: () => json(404, { error: 'Run not found' }) });
    const r = await client(f).run({});
    ok(r.reason === 'not_found' && r.source === 'baked', `poll 404 → baked, reason=${r.reason}`);
    const ctl = new AbortController();
    const g = fake({ polls: ['running'] });
    const r2 = await client(g, { pollMs: 20 }).run({}, { signal: ctl.signal, onStatus: (s) => { if (s.phase === 'running') ctl.abort(); } });
    ok(r2.reason === 'cancelled' && r2.source === 'baked', `user cancels → baked, reason=${r2.reason}`);
    const pre = new AbortController(); pre.abort();
    const h = fake();
    const r3 = await client(h).run({}, { signal: pre.signal });
    ok(r3.reason === 'cancelled' && h.calls.every((c) => !c.url.startsWith('/api/')), 'already-aborted signal: not a single cloud request is sent');
  }

  // ---- 7. Pick the nearest pre-computed point ----
  {
    const f = fake();
    const s = client(f);
    const a = await s.bakedFor({});
    ok(a.key === 'preset' && a.exact === true && a.hasReplay === true && a.index.tag === 'preset', 'default parameters → preset (exact, with trajectories)');
    const b = await s.bakedFor({ diversion_share: 0.45, demand_scale: 1 });
    ok(b.key === 'preset' && b.hasReplay === true, 'grid point equal to the preset → uses the preset (same results, plus trajectories)');
    const c = await s.bakedFor({ diversion_share: 0.2, demand_scale: 1.15 });
    ok(c.key === 's42-d0.15-x1.2' && c.exact === false && c.hasReplay === false && c.index.tag === c.key, `(0.2, 1.15) → ${c.key}, exact=false, metrics only`);
    const d = await s.bakedFor({ diversion_share: 0.3, demand_scale: 0.8 });
    ok(d.key === 's42-d0.30-x0.8' && d.exact === true, `exactly on a grid point → ${d.key}, exact=true`);
    const e = await s.bakedFor({ diversion_share: 0.6, demand_scale: 1.2 });
    ok(e.key === 's42-d0.45-x1.2' && e.exact === false && e.failedExact && e.failedExact.key === 's42-d0.60-x1.2' && e.failedExact.error === FAIL_TEXT,
      `requested grid point failed when baked → neither skipped nor invented: nearest ${e.key} plus failedExact (${e.failedExact && e.failedExact.key})`);
    const g = await s.bakedFor({ seed: 7, diversion_share: 0.3, demand_scale: 1 });
    ok(g.key === 's42-d0.30-x1.0' && g.exact === false && g.requested.seed === 7, 'different seed → same-parameter grid point but exact=false (pre-computed results exist only for seed 42)');
    const h = await s.bakedFor({ diversion_share: 'x', demand_scale: null });
    ok(h.key === 'preset', 'non-numeric parameters → chosen by the defaults (preset)');
    ok(f.calls.filter((x) => x.url.endsWith('/baked.json')).length === 1 && f.calls.filter((x) => x.url.endsWith('/preset/index.json')).length === 1, 'baked.json and each index are downloaded once');
    ok(a.bakedOn === 'cloudflare-container' && a.source === 'baked' && a.engine === ENGINE && a.generatedAt === files['baked.json'].generated_at, "the catalogue's source (where it ran) goes into bakedOn and does not replace source=baked");
    ok(c.source === 'baked', 'a grid index file claiming source=live is still baked');
  }

  // ---- 8. Neither available → source=none; pre-computed failures are not cached ----
  {
    const f = fake({ health: () => { throw new TypeError('fetch failed'); }, bakedDown: true });
    const r = await client(f).run({});
    ok(r.source === 'none' && r.reason === 'network' && typeof r.bakedError === 'string' && r.index === null && sourceLabel(r) === labels.zh.none, `cloud and pre-computed both unreachable → source=none, copy "${sourceLabel(r)}"`);
    let down = true;
    const g = fake();
    const flaky = { fetch: (u, i) => (down && String(u).includes('/baked/') ? Promise.reject(new TypeError('fetch failed')) : g.fetch(u, i)) };
    const s = client(flaky);
    let threw = false;
    try { await s.bakedFor({}); } catch { threw = true; }
    down = false;
    const again = await s.bakedFor({});
    ok(threw && again.key === 'preset', 'pre-computed catalogue fails the first time → throws; loads after recovery (failures not cached)');
  }

  // ---- 9. manifest / chunk: URLs, only the preset has trajectories, sha256 ----
  {
    const f = fake();
    const s = client(f);
    const pre = await s.bakedFor({});
    const m = await s.manifest(pre, 'closure');
    ok(f.calls.at(-1).url === '/sumo/public/baked/preset/closure/manifest.json', 'preset manifest comes from /sumo/public/baked/preset/<scenario>/manifest.json');
    const c = await s.chunk(pre, 'closure', m.chunks[0]);
    ok(c.frames.length === 1 && f.calls.at(-1).url === '/sumo/public/baked/preset/closure/frames-000.json', 'passing manifest.chunks[i] → downloads and the sha256 check passes');
    const codeOf = async (p) => { try { await p; return 'no-throw'; } catch (e) { return e.code; } };
    ok(await codeOf(s.chunk(pre, 'closure', { file: 'frames-000.json', sha256: '0'.repeat(64) })) === 'bad_chunk', 'sha256 mismatch → throws bad_chunk');
    ok(await codeOf(s.chunk(pre, 'closure', '../baked.json')) === 'bad_params', 'invalid chunk file name → throws bad_params, no request sent');
    ok(await codeOf(s.manifest(pre, 'nope')) === 'bad_params', 'unknown scenario → throws bad_params');
    const gridPoint = await s.bakedFor({ diversion_share: 0, demand_scale: 0.8 });
    ok(await codeOf(s.manifest(gridPoint, 'closure')) === 'no_replay', "manifest for a grid result (metrics only) → throws no_replay instead of passing off the preset's trajectories");
    ok(await codeOf(s.manifest({ source: 'live', runId: '../../x' }, 'closure')) === 'no_replay', 'forged runId → no_replay');
    ok(await codeOf(s.manifest({ source: 'none' }, 'closure')) === 'no_replay', 'source=none → no_replay');
  }

  // ---- 10. Copy: three states + required caveats, in both zh and en; pre-computed is never live ----
  {
    ok(labels.zh.live.includes('云端实时运行 · 用时 {s} s') && labels.zh.baked === '预先跑好的 SUMO 结果' && labels.zh.sketch === '示意', 'zh has the three states (live / pre-computed / illustrative)');
    ok(labels.en.live.includes('{s}') && labels.en.baked && labels.en.sketch, `en has the three states: ${labels.en.live} / ${labels.en.baked} / ${labels.en.sketch}`);
    const need = ['合成 2×2 路口，不是墨尔本真实几何', '车流、配时、行人需求为模型假设', '零碰撞只说明本次模型检查通过'];
    ok(need.every((s) => labels.zh.caveats.includes(s)) && labels.en.caveats.length === 3, 'zh and en both have the 3 required caveats');
    ok(Object.isFrozen(labels) && Object.isFrozen(labels.zh.caveats), 'labels are frozen; the page cannot change them');
    const codes = ['sumo_off', 'sumo_down', 'sumo_starting', 'sumo_rate', 'sumo_busy', 'sumo_failed', 'not_found', 'bad_params', 'bad_response', 'timeout', 'network', 'cancelled'];
    ok(codes.every((c) => labels.zh.reasons[c] && labels.en.reasons[c] && reasonLabel(c, 'en') === labels.en.reasons[c]), 'every reason the client can return has zh and en copy');
    ok(sourceLabel({ source: 'baked', elapsedMs: 1234, runId: RID }) === labels.zh.baked, 'reverse: a baked result is still labelled pre-computed even with elapsedMs / runId');
    ok(sourceLabel({ source: 'live' }) === labels.zh.none && sourceLabel(undefined) === labels.zh.none, 'reverse: live without an elapsed time / empty value → no live label');
    ok(DEFAULT_PARAMS.seed === 42 && DEFAULT_PARAMS.diversion_share === 0.45 && Object.isFrozen(DEFAULT_PARAMS), 'DEFAULT_PARAMS match the build_demo.py defaults (seed 42, diversion 0.45)');
  }

  // ================= Real CBD network (contract v2) =================
  const realLive = () => json(200, realIdx('live'));
  const neverLiveReal = (r, msg) => {
    const both = realSourceLabel(r, 'zh') + realSourceLabel(r, 'en') + sourceLabel(r, 'zh') + sourceLabel(r, 'en');
    ok(r.source === 'baked' && r.network === 'real' && sourceLabel(r, 'zh') === realLabels.zh.baked && sourceLabel(r, 'en') === realLabels.en.baked
      && !/live|Live|现场|实时/.test(both) && r.runId === undefined && r.index && r.index.tag === 'baked',
      `${msg}: source=baked, copy "${sourceLabel(r, 'en')}", no runId, pre-computed index`);
  };

  // ---- 11. runReal, healthy cloud: POST {network:'real', seed, p_original, p_ai} → poll → index (v2) ----
  {
    const f = fake({ polls: ['queued', 'running', 'running', 'complete'], index: realLive });
    const phases = [];
    const r = await client(f).runReal({ seed: 7, p_original: 0.14, p_ai: 0.61, evil: 1, diversion_share: 0.3 }, { onStatus: (s) => phases.push(s.phase), timeoutMs: 2000 });
    ok(r.source === 'live' && r.network === 'real' && r.runId === RID && r.index.version === 2 && r.index.tag === 'live' && r.index.scenarios.length === 3, `runReal live: source=live, network=real, runId, index v2 (${r.source} ${r.reason || ''})`);
    ok(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 && r.reason === undefined && r.engine === ENGINE, `runReal live: elapsedMs=${Math.round(r.elapsedMs)}, engine, no reason`);
    ok(/^Cloud · live · \d+\.\d s$/.test(sourceLabel(r, 'en')) && /^云端现场 · 用时 \d+\.\d s$/.test(sourceLabel(r, 'zh')) && realSourceLabel(r, 'en') === sourceLabel(r, 'en'), `runReal live copy: ${sourceLabel(r, 'en')} / ${sourceLabel(r, 'zh')}`);
    const body = f.posts()[0].body;
    ok(body === '{"network":"real","seed":7,"p_original":0.14,"p_ai":0.61}', `POST body has only network + seed + p_original + p_ai: ${body}`);
    ok(['health', 'submit', 'queued', 'running', 'complete', 'done'].every((p) => phases.includes(p)), `runReal onStatus: ${phases.join(' → ')}`);
    ok(f.calls.every((c) => !c.url.startsWith('/sumo/public/')), 'a successful runReal does not fetch pre-computed files');
    const g = fake({ index: realLive });
    await client(g).runReal({ p_ai: NaN, seed: 'x', scenarios: ['ai', 'closure', 'baseline'] }, { timeoutMs: 2000 });
    ok(g.posts()[0].body === '{"network":"real","scenarios":["ai","baseline"]}', `non-finite fields are not sent; scenarios keeps only baseline/original/ai: ${g.posts()[0].body}`);
    const h = fake({ index: realLive });
    await client(h).runReal({}, { timeoutMs: 2000 });
    ok(h.posts()[0].body === '{"network":"real"}', 'no parameters → sends only {network:\'real\'} (serve.py sets the defaults)');
  }

  // ---- 12. runReal fails → pre-computed result + reason code ----
  for (const [name, o, reason, extra] of [
    ['health unreachable', { health: () => { throw new TypeError('fetch failed'); } }, 'health_down', { detail: 'network', noPost: true }],
    ['health 503 sumo_starting', { health: () => json(503, { ok: false, error: 'sumo_starting', msg: 'starting' }) }, 'health_down', { detail: 'sumo_starting', noPost: true }],
    ['health 502 sumo_down', { health: () => json(502, { ok: false, error: 'sumo_down', msg: 'not responding' }) }, 'health_down', { detail: 'sumo_down', noPost: true }],
    ['health hangs', { health: hang }, 'health_down', { detail: 'timeout', noPost: true, ms: 150 }],
    ['POST 429 sumo_rate', { post: () => json(429, { ok: false, error: 'sumo_rate', msg: 'at most 3 per minute' }) }, 'sumo_rate', { text: 'at most 3 per minute' }],
    ['POST 429 sumo_busy', { post: () => json(429, { ok: false, error: 'sumo_busy', msg: 'busy' }) }, 'sumo_busy', { text: 'busy' }],
    ['POST 400 parameter out of range', { post: () => json(400, { ok: false, error: 'bad_request', msg: 'Invalid parameters (p_ai must be a number in [0, 1])' }) }, 'bad_params', { text: 'p_ai' }],
    ['POST hangs', { post: hang }, 'timeout', { ms: 300 }],
    ['run failed', { polls: ['running', 'failed'] }, 'sumo_failed', { text: FAIL_TEXT, liveRunId: true }],
    ['stuck in running', { polls: ['running'] }, 'timeout', { ms: 120, liveRunId: true }],
    ['poll hangs', { poll: hang }, 'timeout', { ms: 150, liveRunId: true }],
    ['poll 404 (container restarted)', { poll: () => json(404, { ok: false, error: 'not_found', msg: 'no such run' }) }, 'not_found', { liveRunId: true }],
    ['poll unreachable 3 times', { poll: () => { throw new TypeError('fetch failed'); } }, 'network', { liveRunId: true }],
    ['cloud index is not a v2 real network', { index: () => json(200, idx('live')) }, 'bad_response', { liveRunId: true }],
  ]) {
    const f = fake({ index: realLive, ...o });
    const t0 = Date.now();
    const r = await client(f).runReal({ p_ai: 0.53 }, { timeoutMs: extra.ms || 2000 });
    ok(r.reason === reason && (!extra.detail || r.detail === extra.detail) && (!extra.noPost || f.posts().length === 0)
      && (!extra.text || String(r.error).includes(extra.text)) && (!extra.liveRunId || r.liveRunId === RID),
      `runReal ${name} → baked, reason=${r.reason}${r.detail ? ` (detail ${r.detail})` : ''}${r.error ? `, error "${String(r.error).slice(0, 36)}"` : ''}`);
    neverLiveReal(r, `runReal ${name}`);
    if (extra.ms) ok(Date.now() - t0 < 1500, `runReal ${name}: honours timeoutMs (${Date.now() - t0} ms)`);
  }
  {
    const ctl = new AbortController();
    const f = fake({ polls: ['running'], index: realLive });
    const r = await client(f, { pollMs: 20 }).runReal({}, { signal: ctl.signal, timeoutMs: 2000, onStatus: (s) => { if (s.phase === 'running') ctl.abort(); } });
    ok(r.reason === 'cancelled' && r.liveRunId === RID, `runReal user cancels → baked, reason=${r.reason}`);
    neverLiveReal(r, 'runReal cancel');
    const pre = new AbortController(); pre.abort();
    const g = fake({ index: realLive });
    const r2 = await client(g).runReal({}, { signal: pre.signal });
    ok(r2.reason === 'cancelled' && g.calls.every((c) => !c.url.startsWith('/api/')), 'runReal with an already-aborted signal: not a single cloud request is sent');
    const h = fake({ health: hang, index: realLive });
    const hc = new AbortController();
    setTimeout(() => hc.abort(), 30);
    const r3 = await client(h).runReal({}, { signal: hc.signal, timeoutMs: 2000 });
    ok(r3.reason === 'cancelled' && r3.source === 'baked', `cancel during the health check → reason=cancelled (not health_down): ${r3.reason}`);
  }
  {
    const f = fake({ health: () => { throw new TypeError('fetch failed'); }, realDown: true });
    const r = await client(f).runReal({});
    ok(r.source === 'none' && r.network === 'real' && r.reason === 'health_down' && r.index === null && typeof r.bakedError === 'string'
      && sourceLabel(r, 'en') === realLabels.en.none && sourceLabel(r, 'zh') === realLabels.zh.none, `neither the cloud nor the pre-computed real network available → source=none, copy "${sourceLabel(r, 'en')}"`);
  }

  // ---- 13. loadReal: /sumo/public/real/index.json, downloaded once, failures not cached, throws on a bad format ----
  {
    const f = fake();
    const s = client(f);
    const a = await s.loadReal();
    const b = await s.loadReal();
    ok(a.source === 'baked' && a.network === 'real' && a.index.version === 2 && a.index.works.link === WORKS.link && a.engine === ENGINE && a === b,
      'loadReal → {source:baked, network:real, index v2}; source=live in the file does not override baked');
    ok(f.calls.filter((c) => c.url === '/sumo/public/real/index.json').length === 1 && f.calls.every((c) => !c.url.startsWith('/api/')), 'loadReal downloads index.json once and never touches the cloud');
    ok(sourceLabel(a, 'en') === 'SUMO · pre-computed' && sourceLabel(a, 'zh') === 'SUMO · 预先跑好', `loadReal copy: ${sourceLabel(a, 'en')} / ${sourceLabel(a, 'zh')}`);
    let down = true;
    const g = fake();
    const flaky = { fetch: (u, i) => (down && String(u).includes('/real/') ? Promise.reject(new TypeError('fetch failed')) : g.fetch(u, i)) };
    const s2 = client(flaky);
    let threw = null;
    try { await s2.loadReal(); } catch (e) { threw = e.code; }
    down = false;
    const again = await s2.loadReal();
    ok(threw === 'network' && again.index.version === 2, `pre-computed real network unreachable the first time → throws ${threw}; loads after recovery (failures not cached)`);
    const h = fake({ realFiles: { 'index.json': idx('v1') } });
    let bad = null;
    try { await client(h).loadReal(); } catch (e) { bad = e.code; }
    ok(bad === 'baked_missing', 'pre-computed index not version 2 / network real → throws baked_missing instead of passing off the synthetic 2×2');
  }

  // ---- 14. realManifest / realChunk: URLs for both sources, sha256, invalid input ----
  {
    const f = fake({ index: realLive });
    const s = client(f);
    const codeOf = async (p) => { try { await p; return 'no-throw'; } catch (e) { return e.code; } };
    const baked = await s.loadReal();
    const m = await s.realManifest(baked, 'original');
    ok(f.calls.at(-1).url === '/sumo/public/real/original/manifest.json' && m.scenario === 'original' && m.chunks.length === 1, 'pre-computed manifest → /sumo/public/real/original/manifest.json');
    const c = await s.realChunk(baked, 'original', m.chunks[0]);
    ok(f.calls.at(-1).url === '/sumo/public/real/original/frames-000.json' && c.frames[0].q === 12.5, 'pre-computed chunk → /sumo/public/real/original/frames-000.json (sha256 checked against the JSON text)');
    const ref = { source: 'baked', reason: 'sumo_rate' }; // a runReal fallback result can itself serve as ref
    await s.realManifest(ref, 'ai');
    ok(f.calls.at(-1).url === '/sumo/public/real/ai/manifest.json', 'a runReal fallback result {source:baked} works directly as ref');
    const live = await s.runReal({}, { timeoutMs: 2000 });
    const lm = await s.realManifest(live, 'ai');
    ok(f.calls.at(-1).url === `/api/sumo/v1/runs/${RID}/ai/manifest.json` && lm.scenario === 'ai', 'cloud manifest → /api/sumo/v1/runs/<id>/ai/manifest.json');
    const lc = await s.realChunk({ source: 'live', runId: RID }, 'baseline', { file: 'frames-000.json', sha256: RCHUNK_SHA });
    ok(f.calls.at(-1).url === `/api/sumo/v1/runs/${RID}/baseline/frames-000.json` && lc.frames.length === 1, 'cloud chunk → /api/sumo/v1/runs/<id>/baseline/frames-000.json, sha256 check passes');
    ok(await codeOf(s.realChunk(live, 'baseline', { file: 'frames-000.json', sha256: '0'.repeat(64) })) === 'bad_chunk', 'sha256 mismatch → throws bad_chunk');
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    let noCrypto = 'skip';
    if (desc && desc.configurable) {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
      try { noCrypto = await codeOf(s.realChunk(live, 'baseline', { file: 'frames-000.json', sha256: '0'.repeat(64) })); } finally { Object.defineProperty(globalThis, 'crypto', desc); }
    }
    ok(noCrypto === 'no-throw' || noCrypto === 'skip', `no WebCrypto (plain-http page) → check skipped rather than breaking the page (${noCrypto})`);
    ok(await codeOf(s.realManifest(baked, 'closure')) === 'bad_params' && await codeOf(s.realManifest(baked, 'guided')) === 'bad_params', 'synthetic 2×2 scenario names (closure / guided) → throw bad_params');
    ok(await codeOf(s.realChunk(baked, 'ai', '../index.json')) === 'bad_params' && await codeOf(s.realChunk(baked, 'ai', 'frames-1.json')) === 'bad_params', 'invalid chunk file name → throws bad_params, no request sent');
    ok(await codeOf(s.realManifest({ source: 'live', runId: '../../x' }, 'ai')) === 'no_replay' && await codeOf(s.realManifest({ source: 'none' }, 'ai')) === 'no_replay'
      && await codeOf(s.realManifest(undefined, 'ai')) === 'no_replay', 'forged runId / source=none / empty ref → no_replay');
    const n = f.calls.length;
    await codeOf(s.realManifest({ source: 'none' }, 'ai'));
    ok(f.calls.length === n, 'no_replay sends no request');
    ok(await codeOf(s.realManifest({ source: 'baked' }, 'baseline')) === 'no-throw' && (await s.realManifest({ source: 'baked' }, 'baseline')).scenario === 'baseline', 'the baseline scenario can be fetched too');
  }

  // ---- 15. Real-network copy: status line + 4 caveats, in both zh and en; pre-computed is never live ----
  {
    ok(realLabels.en.live === 'Cloud · live · {s} s' && realLabels.zh.live === '云端现场 · 用时 {s} s', `live copy: ${realLabels.en.live} / ${realLabels.zh.live}`);
    ok(realLabels.en.baked === 'SUMO · pre-computed' && realLabels.zh.baked === 'SUMO · 预先跑好', `baked copy: ${realLabels.en.baked} / ${realLabels.zh.baked}`);
    const en = realLabels.en.caveats.join(' | '), zh = realLabels.zh.caveats.join(' | ');
    ok(/OpenStreetMap/.test(en) && /SCATS/.test(en) && /08:00/.test(en) && /[Ss]ignal timing/.test(en) && /turn shares/.test(en) && /not measured/.test(en), `en caveats: ${en}`);
    ok(/OpenStreetMap/.test(zh) && /SCATS/.test(zh) && /08:00/.test(zh) && /配时/.test(zh) && /转向/.test(zh) && /不是实测/.test(zh), `zh caveats: ${zh}`);
    ok(realLabels.en.caveats.length === realLabels.zh.caveats.length && realLabels.en.caveats.length >= 4, `zh and en have the same number of caveats (${realLabels.en.caveats.length})`);
    ok(realLabels.en.note === 'SUMO 1.27.1 · real CBD network (OSM) + SCATS 08:00–09:00 flows · signal timing and turn shares assumed' && realLabels.zh.note.includes('OSM'), `panel note: ${realLabels.en.note}`);
    ok(Object.isFrozen(realLabels) && Object.isFrozen(realLabels.en.caveats) && Object.isFrozen(REAL_SCENARIOS) && Object.isFrozen(REAL_DEFAULTS), 'realLabels / REAL_SCENARIOS / REAL_DEFAULTS are frozen');
    ok(JSON.stringify(REAL_SCENARIOS) === '["baseline","original","ai"]' && REAL_DEFAULTS.p_original === 0.14 && REAL_DEFAULTS.p_ai === 0.53, 'REAL_SCENARIOS and default diversion shares 0.14 / 0.53 follow contract v2');
    { const src = readFileSync(new URL('../public/js/sumo-client.js', import.meta.url), 'utf8');
      ok(REAL_TIMEOUT_MS === 180000 && /async function runReal\(params = \{\}, \{ onStatus, signal, timeoutMs: limitMs = REAL_TIMEOUT_MS \} = \{\}\)/.test(src),
        `runReal without timeoutMs waits ${REAL_TIMEOUT_MS / 1000} s by default (the full hour takes about 40–60 s in the cloud, plus cold-start headroom)`); }
    const forged = { network: 'real', source: 'baked', elapsedMs: 1234, runId: RID };
    ok(sourceLabel(forged, 'en') === 'SUMO · pre-computed' && realSourceLabel(forged, 'zh') === 'SUMO · 预先跑好', 'reverse (real network): a baked result is still labelled pre-computed even with elapsedMs / runId');
    ok(realSourceLabel({ network: 'real', source: 'live' }, 'en') === realLabels.en.none && realSourceLabel(undefined, 'zh') === realLabels.zh.none, 'reverse (real network): live without an elapsed time / empty value → no "Cloud · live"');
    ok(sourceLabel({ source: 'baked' }, 'en') === labels.en.baked, 'results without network=real still use the synthetic 2×2 copy (old API unaffected)');
    const codes = ['health_down', 'sumo_rate', 'sumo_busy', 'timeout', 'sumo_failed', 'network', 'not_found', 'cancelled', 'bad_params', 'bad_response', 'bad_chunk'];
    ok(codes.every((c) => labels.zh.reasons[c] && labels.en.reasons[c] && reasonLabel(c, 'en') === labels.en.reasons[c]), 'every reason runReal can return has zh and en copy');
  }

  // ---- 16. runOptions: POST {network:'real', seed?, options} → poll → index (baseline + opt-<id>); no pre-computed fallback, every failure is source=none ----
  {
    const optIdx = (ids, extra = {}) => ({
      ...realIdx('live-options'), params: { seed: 7, options: [], frames: false },
      scenarios: ['baseline', ...ids].map((id) => ({ id, label: { en: id, zh: id }, diversion_share: 0, manifest: `${id}/manifest.json`, metrics: { works_queue_max_m: 1 } })), ...extra,
    });
    const OPTS = [{ id: 'A', p: 0.14 }, { id: 'B', p: 0.14 }, { id: 'C', p: 0.607 }];
    const live = () => json(200, optIdx(['opt-A', 'opt-B', 'opt-C']));
    const noBaked = (f) => f.calls.every((c) => !c.url.startsWith('/sumo/public/'));
    const neverLiveOpt = (r, msg) => ok(r.source === 'none' && r.network === 'real' && r.index === null && r.runId === undefined
      && sourceLabel(r, 'en') === realLabels.en.none && sourceLabel(r, 'zh') === realLabels.zh.none, `${msg}: source=none, index=null, copy "${sourceLabel(r, 'zh')}", no runId`);

    const f = fake({ polls: ['queued', 'running', 'complete'], index: live });
    const phases = [];
    const r = await client(f).runOptions(OPTS.map((o) => ({ ...o, label: 'x' })), { seed: 7, onStatus: (s) => phases.push(s.phase), timeoutMs: 2000 });
    ok(r.source === 'live' && r.network === 'real' && r.runId === RID && r.index.tag === 'live-options' && r.index.scenarios.length === 4 && r.engine === ENGINE && r.reason === undefined,
      `runOptions live: source=live, runId, index has baseline + 3 options (${r.source} ${r.reason || ''})`);
    ok(f.posts()[0].body === '{"network":"real","seed":7,"options":[{"id":"A","p":0.14},{"id":"B","p":0.14},{"id":"C","p":0.607}]}', `POST body: ${f.posts()[0].body}`);
    ok(/^Cloud · live · \d+\.\d s$/.test(sourceLabel(r, 'en')) && /^云端现场 · 用时 \d+\.\d s$/.test(sourceLabel(r, 'zh')), `runOptions live copy: ${sourceLabel(r, 'zh')}`);
    ok(['health', 'submit', 'queued', 'running', 'complete', 'done'].every((p) => phases.includes(p)) && noBaked(f), `runOptions onStatus: ${phases.join(' → ')}; no pre-computed files touched`);
    const g = fake({ index: live });
    await client(g).runOptions(OPTS);
    ok(!('seed' in JSON.parse(g.posts()[0].body)), 'no seed → body has no seed (serve.py sets the default)');
    const s = client(f);
    await s.realManifest(r, 'opt-B').catch(() => null); // the fake server has no such file (404); only the URL matters here
    ok(f.calls.at(-1).url === `/api/sumo/v1/runs/${RID}/opt-B/manifest.json`, 'realManifest accepts opt-B → /api/sumo/v1/runs/<id>/opt-B/manifest.json');
    ok(await s.realManifest(r, 'opt-F').then(() => 'no-throw', (e) => e.code) === 'bad_params' && await s.realChunk(r, 'opt-a', 'frames-000.json').then(() => 'no-throw', (e) => e.code) === 'bad_params',
      'opt-F / opt-a rejected → bad_params');

    // invalid parameters: no request at all
    for (const bad of [[], undefined, 'A', [{ id: 'F', p: 0.1 }], [{ id: 'a', p: 0.1 }], [{ id: 'A', p: 0.1 }, { id: 'A', p: 0.2 }], [{ id: 'A', p: 1.01 }], [{ id: 'A', p: -0.1 }],
      [{ id: 'A', p: NaN }], [{ id: 'A', p: '0.5' }], [{ id: 'A' }], [null], ['A', 'B', 'C', 'D', 'E', 'A'].map((id) => ({ id, p: 0.1 }))]) {
      const h = fake({ index: live });
      const rb = await client(h).runOptions(bad);
      ok(rb.reason === 'bad_params' && h.calls.length === 0, `runOptions(${JSON.stringify(bad)}) → reason=bad_params, no request sent`);
      neverLiveOpt(rb, 'runOptions invalid parameters');
    }

    // failures: no pre-computed fallback → source=none + reason code
    for (const [name, o, reason, extra] of [
      ['health unreachable', { health: () => { throw new TypeError('fetch failed'); } }, 'health_down', { detail: 'network', noPost: true }],
      ['health 503 sumo_starting', { health: () => json(503, { ok: false, error: 'sumo_starting', msg: 'starting' }) }, 'health_down', { detail: 'sumo_starting', noPost: true }],
      ['POST 429 sumo_rate', { post: () => json(429, { ok: false, error: 'sumo_rate', msg: 'at most 3 per minute' }) }, 'sumo_rate', {}],
      ['POST 429 sumo_busy', { post: () => json(429, { ok: false, error: 'sumo_busy', msg: 'busy' }) }, 'sumo_busy', {}],
      ['POST 400 (older container without options support)', { post: () => json(400, { ok: false, error: 'bad_config', msg: 'Invalid parameters: Unknown field: options' }) }, 'bad_params', { text: 'options' }],
      ['run failed', { polls: ['running', 'failed'] }, 'sumo_failed', { text: FAIL_TEXT, liveRunId: true }],
      ['stuck in running', { polls: ['running'] }, 'timeout', { ms: 120, liveRunId: true }],
      ['poll 404', { poll: () => json(404, { ok: false, error: 'not_found', msg: 'no such run' }) }, 'not_found', { liveRunId: true }],
      ['index missing one option', { index: () => json(200, optIdx(['opt-A', 'opt-B'])) }, 'bad_response', { liveRunId: true }],
      ['index has the original three scenarios', { index: realLive }, 'bad_response', { liveRunId: true }],
      ['index is not a v2 real network', { index: () => json(200, idx('live')) }, 'bad_response', { liveRunId: true }],
    ]) {
      const h = fake({ index: live, ...o });
      const t0 = Date.now();
      const rf = await client(h).runOptions(OPTS, { timeoutMs: extra.ms || 2000 });
      ok(rf.reason === reason && (!extra.detail || rf.detail === extra.detail) && (!extra.noPost || h.posts().length === 0)
        && (!extra.text || String(rf.error).includes(extra.text)) && (!extra.liveRunId || rf.liveRunId === RID) && noBaked(h),
        `runOptions ${name} → none, reason=${rf.reason}${rf.detail ? ` (detail ${rf.detail})` : ''}, no pre-computed files fetched`);
      neverLiveOpt(rf, `runOptions ${name}`);
      if (extra.ms) ok(Date.now() - t0 < 1500, `runOptions ${name}: honours timeoutMs (${Date.now() - t0} ms)`);
    }
    const ctl = new AbortController();
    const h = fake({ polls: ['running'], index: live });
    const rc = await client(h, { pollMs: 20 }).runOptions(OPTS, { signal: ctl.signal, timeoutMs: 2000, onStatus: (st) => { if (st.phase === 'running') ctl.abort(); } });
    ok(rc.reason === 'cancelled' && rc.liveRunId === RID && noBaked(h), `runOptions user cancels → none, reason=${rc.reason}`);
    neverLiveOpt(rc, 'runOptions cancel');
    ok(Object.isFrozen(OPTION_IDS) && OPTION_IDS.join('') === 'ABCDE', 'OPTION_IDS = A–E, frozen');
  }
} catch (e) {
  F++;
  console.log('❌ test crashed: ' + (e && e.stack || e));
}

console.log(`${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
