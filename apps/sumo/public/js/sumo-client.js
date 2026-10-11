// The page's only entry point to SUMO (D-0930-1700; docs/reference/interfaces.md, HTTP API /api/sumo/v1)
// Tries the cloud first (/api/sumo/v1 → hackathon-sumo → serve.py in a Cloudflare Container). When the cloud is off, unreachable,
// starting, rate-limited, busy, timed out, failed or cancelled, each method falls back in its own way: run() to the synthetic 2×2
// results in /sumo/public/baked/ (written by apps/sumo/tools/bake.py), runReal() to the real-network replay in /sumo/public/real/,
// runOptions() to nothing (source 'none').
// Every result carries source: 'live' (cloud run) | 'baked' (pre-computed) | 'none' (neither available); the page picks its copy from
// that and from labels only. A pre-computed result is never labelled live (reverse-asserted in tests/client.test.mjs).
//
// Usage:
//   import { createSumoClient, labels, sourceLabel, reasonLabel } from '/sumo/public/js/sumo-client.js';
//   const sumo = createSumoClient();
//   const first = await sumo.bakedFor({});                          // show the preset immediately (it has per-frame trajectories)
//   const r = await sumo.run({ diversion_share: 0.3 }, { onStatus, signal });   // aborting signal → pre-computed result, reason 'cancelled'
//   sourceLabel(r, 'en') → 'Live cloud run · 12.3 s' or 'Pre-computed SUMO results'; r.reason is the short code for why it fell back
//   const m = await sumo.manifest(r, 'closure'); const c = await sumo.chunk(r, 'closure', m.chunks[0]);  // grid points have metrics only, no trajectories
// Real CBD network (contract v2):
//   const real = await sumo.loadReal();                               // {source:'baked', network:'real', index}, /sumo/public/real/index.json
//   const m = await sumo.realManifest(real, 'original'); const c = await sumo.realChunk(real, 'original', m.chunks[0]);
//   const r = await sumo.runReal({ seed, p_original: 0.14, p_ai: 0.53 }, { onStatus, signal, timeoutMs: 180000 });
//   // → {source:'live', runId, elapsedMs, index} or {source:'baked', reason, index} (reason: health_down / sumo_rate / sumo_busy / timeout / sumo_failed / network / not_found / cancelled …)
//   sourceLabel(r, 'en') → 'Cloud · live · 31.4 s' | 'SUMO · pre-computed'; realLabels[lang].caveats must be shown alongside
// Any set of plan diversion shares (same network, same works, only p changes): no pre-computed fallback; on failure source:'none' and the page shows '—' + reasonLabel(r.reason)
//   const r = await sumo.runOptions([{ id: 'A', p: 0.14 }, { id: 'B', p: 0.14 }, { id: 'C', p: 0.607 }], { seed, onStatus, signal, timeoutMs: 180000 });
//   // → {source:'live', network:'real', runId, elapsedMs, index} or {source:'none', network:'real', reason, index:null}
//   // index.scenarios = baseline + opt-A / opt-B / opt-C (metrics as for original / ai); options with the same p run once, later ones carry reused_from:'opt-A'; no per-frame output by default (manifest.chunks = [])
// Runs in the browser and in Node (pass fetch and absolute URLs in Node); no dependencies

export const SCENARIOS = Object.freeze(['baseline', 'closure', 'guided', 'footpath']);
const FIELDS = ['seed', 'scenarios', 'demand_duration_s', 'clearance_s', 'demand_scale', 'diversion_share'];
// Matches DEFAULT_CONFIG in apps/web/tools/sumo/build_demo.py
export const DEFAULT_PARAMS = Object.freeze({ seed: 42, scenarios: SCENARIOS, demand_duration_s: 600, clearance_s: 1200, demand_scale: 1, diversion_share: 0.45 });
const RUN_ID = /^[0-9a-f]{32}$/;
const HEALTH_MS = 6000; // longest wait for the health check before falling back to pre-computed results
const REQ_MS = 10000;   // a single API request (POST, poll, index.json)
const FILE_MS = 20000;  // manifest / frame chunk / pre-computed file (largest chunk ≈ 0.5 MB)
// The Workers' own error codes (apps/sumo/src/proxy.js, apps/site/src/worker.js); other codes passed through from the container (bad_config / sumo_error / not_ready …) are classified by status
const KNOWN = new Set(['sumo_off', 'sumo_down', 'sumo_starting', 'sumo_rate', 'sumo_busy', 'not_found', 'too_big']);
// Real network (contract v2): scenario ids and default diversion shares (the engine's readings of 'ROADWORK AHEAD' / 'USE RUSSELL / SAVE 9 MIN')
export const REAL_SCENARIOS = Object.freeze(['baseline', 'original', 'ai']);
export const REAL_DEFAULTS = Object.freeze({ p_original: 0.14, p_ai: 0.53 });
export const REAL_TIMEOUT_MS = 180000; // one real-network run of three scenarios (the full 08:00–09:00 hour): about 40–60 s in the cloud, plus headroom for cold start and queueing
const REAL_HEALTH_MS = 12000;  // real-network and options runs give a freshly woken container longer to answer the health check
const LIVE = Symbol('live');   // marks a successful drive(), distinct from fallback results (plain objects)

// Options mode: option ids and the default overall time limit (baseline + up to 5 options; enough for the one-hour simulation)
export const OPTION_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
const OPTIONS_TIMEOUT_MS = 180000;
const isRealScenario = (s) => REAL_SCENARIOS.includes(s) || /^opt-[A-E]$/.test(s);

export class SumoError extends Error {
  constructor(code, msg) {
    super(msg || code);
    this.code = code;
  }
}

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

// Three states + the caveats that must appear alongside. {s} = seconds; the page must not write its own 'live'-style copy
export const labels = deepFreeze({
  zh: {
    live: '云端实时运行 · 用时 {s} s',
    baked: '预先跑好的 SUMO 结果',
    sketch: '示意',
    none: '暂时拿不到 SUMO 结果',
    running: 'SUMO 正在云端计算 · 已用 {s} s',
    caveats: ['合成 2×2 路口，不是墨尔本真实几何', '车流、配时、行人需求为模型假设', '零碰撞只说明本次模型检查通过'],
    reasons: {
      sumo_off: '云端 SUMO 没有开启', sumo_down: '云端 SUMO 没有响应', sumo_starting: '云端 SUMO 正在启动',
      sumo_rate: '运行太频繁，请一分钟后再试', sumo_busy: '云端 SUMO 正忙', sumo_failed: '这次运行没通过模型检查',
      not_found: '云端结果不见了（服务可能重启过）', too_big: '请求太大', bad_params: '参数超出允许范围',
      bad_response: '云端返回的内容不对', timeout: '云端运行超时', network: '网络连不上', cancelled: '已取消',
      health_down: '云端 SUMO 连不上', bad_chunk: '结果文件校验没通过',
    },
  },
  en: {
    live: 'Live cloud run · {s} s',
    baked: 'Pre-computed SUMO results',
    sketch: 'Illustrative',
    none: 'SUMO results unavailable',
    running: 'SUMO running in the cloud · {s} s',
    caveats: ['Synthetic 2×2 grid, not real Melbourne geometry', 'Traffic volumes, signal timing and pedestrian demand are model assumptions', 'Zero collisions only means this model run passed its checks'],
    reasons: {
      sumo_off: 'Cloud SUMO is switched off', sumo_down: 'Cloud SUMO is not responding', sumo_starting: 'Cloud SUMO is starting up',
      sumo_rate: 'Too many runs; try again in a minute', sumo_busy: 'Cloud SUMO is busy', sumo_failed: 'This run failed the model checks',
      not_found: 'Cloud result is gone (service may have restarted)', too_big: 'Request too large', bad_params: 'Parameters out of range',
      bad_response: 'Unexpected response from the cloud', timeout: 'Cloud run timed out', network: 'Network unreachable', cancelled: 'Cancelled',
      health_down: 'Cloud SUMO is unreachable', bad_chunk: 'Result file failed its checksum',
    },
  },
});

// Status line and caveats for the real CBD network (contract v2), used by step 2's SUMO mode; {s} = seconds
export const realLabels = deepFreeze({
  zh: {
    live: '云端现场 · 用时 {s} s',
    baked: 'SUMO · 预先跑好',
    none: '暂时拿不到 SUMO 结果',
    running: 'SUMO 正在云端重跑 · 已用 {s} s',
    note: 'SUMO 1.27.1 · 真实 CBD 路网（OSM）+ SCATS 工作日 08:00 车流 · 信号配时和转向比例是假设',
    caveats: ['真实墨尔本 CBD 路网，来自 OpenStreetMap', '车流取 SCATS 工作日 08:00 的计数', '信号配时和转向比例是假设', '绕行比例来自引擎对路牌的解读，不是实测'],
  },
  en: {
    live: 'Cloud · live · {s} s',
    baked: 'SUMO · pre-computed',
    none: 'SUMO results unavailable',
    running: 'Re-running SUMO in the cloud · {s} s',
    note: 'SUMO 1.27.1 · real CBD network (OSM) + SCATS 08:00–09:00 flows · signal timing and turn shares assumed',
    caveats: ['Real Melbourne CBD street network from OpenStreetMap', 'Traffic volumes from SCATS weekday 08:00–09:00 counts', 'Signal timing and turn shares are assumed', "Diversion shares come from the engine's reading of the sign, not measured"],
  },
});

// Real-network status line: 'Cloud · live' appears only when source === 'live' and an elapsed time is present
export function realSourceLabel(result, lang = 'zh') {
  const L = realLabels[lang] || realLabels.zh;
  if (result && result.source === 'live' && Number.isFinite(result.elapsedMs)) return L.live.replace('{s}', (result.elapsedMs / 1000).toFixed(1));
  if (result && result.source === 'baked') return L.baked;
  return L.none;
}

// Status line copy: 'Live cloud run' appears only when source === 'live'; results with network === 'real' (runReal / loadReal) use the real-network copy
export function sourceLabel(result, lang = 'zh') {
  if (result && result.network === 'real') return realSourceLabel(result, lang);
  const L = labels[lang] || labels.zh;
  if (result && result.source === 'live' && Number.isFinite(result.elapsedMs)) return L.live.replace('{s}', (result.elapsedMs / 1000).toFixed(1));
  if (result && result.source === 'baked') return L.baked;
  return L.none;
}

export function reasonLabel(code, lang = 'zh') {
  const L = labels[lang] || labels.zh;
  return (code && L.reasons[code]) || code || '';
}

const pick = (params) => {
  const out = {};
  for (const k of FIELDS) if (params && params[k] !== undefined) out[k] = params[k];
  return out;
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const normalize = (params) => {
  const p = pick(params);
  const out = { ...DEFAULT_PARAMS, ...p };
  for (const k of ['seed', 'demand_duration_s', 'clearance_s', 'demand_scale', 'diversion_share']) out[k] = num(out[k], DEFAULT_PARAMS[k]);
  return out;
};
const same = (a, b) => Math.abs(a - b) < 1e-9;
const sameRun = (a, b) => ['seed', 'demand_duration_s', 'clearance_s', 'demand_scale', 'diversion_share'].every((k) => same(num(a[k], NaN), num(b[k], NaN)));

function reasonOf(status, data) {
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (KNOWN.has(code)) return code;
  if (status === 429) return 'sumo_busy'; // a 429 without a known code counts as busy
  if (status === 404) return 'not_found';
  if (status === 400 || status === 413 || status === 415) return 'bad_params';
  if (status >= 500) return 'sumo_down';
  return 'bad_response';
}
const msgOf = (r) => (r.data && (r.data.msg || r.data.error)) || (r.text || '').slice(0, 300) || `HTTP ${r.status}`;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new SumoError('cancelled'));
    const t = setTimeout(done, ms);
    function done() { if (signal) signal.removeEventListener('abort', stop); resolve(); }
    function stop() { clearTimeout(t); reject(new SumoError('cancelled')); }
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createSumoClient({ base = '/api/sumo/v1', baked = '/sumo/public/baked', real = '/sumo/public/real', fetch = globalThis.fetch, timeoutMs = 45000, pollMs = 1000 } = {}) {
  const api = base.replace(/\/+$/, '');
  const root = baked.replace(/\/+$/, '');
  const realRoot = real.replace(/\/+$/, '');
  let realP = null;
  const doFetch = fetch; // not called as a method: obj.fetch() throws Illegal invocation in browsers
  const now = globalThis.performance && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
  let catalogP = null;
  const files = new Map(); // pre-computed index path → Promise (switching parameters back and forth does not re-download)

  // → { status, data (JSON; undefined if not JSON), text }; throws SumoError on timeout / cancel / network failure
  async function request(url, { method = 'GET', body, ms = REQ_MS, signal } = {}) {
    const ctl = new AbortController();
    let why = null;
    const timer = setTimeout(() => { why = 'timeout'; ctl.abort(); }, Math.max(0, ms));
    const onAbort = () => { why = why || 'cancelled'; ctl.abort(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      const headers = body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' };
      const res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = undefined; }
      return { status: res.status, data, text };
    } catch (e) {
      throw new SumoError(why || 'network', why === 'timeout' ? `no response within ${Math.round(ms)} ms` : String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function health({ signal, ms = HEALTH_MS, limitMs = timeoutMs } = {}) {
    try {
      const r = await request(`${api}/health`, { ms: Math.min(ms, limitMs), signal });
      if (r.status === 200 && r.data && r.data.status === 'ready' && r.data.engine) {
        return { ok: true, engine: r.data.engine, activeJobs: r.data.active_jobs ?? null, status: 200 };
      }
      const error = r.status !== 200 ? reasonOf(r.status, r.data) : r.data && typeof r.data.status === 'string' ? 'sumo_starting' : 'bad_response';
      return { ok: false, error, msg: msgOf(r), status: r.status };
    } catch (e) {
      return { ok: false, error: e.code || 'network', msg: e.message };
    }
  }

  function loadBaked() {
    if (!catalogP) {
      catalogP = (async () => {
        const r = await request(`${root}/baked.json`, { ms: FILE_MS });
        if (r.status !== 200 || !r.data || r.data.version !== 1) throw new SumoError('baked_missing', `could not load the pre-computed catalogue baked.json (${msgOf(r)})`);
        return r.data;
      })();
      catalogP.catch(() => { catalogP = null; }); // failures are not cached; retry next time
    }
    return catalogP;
  }

  // Pick the nearest of the preset and the complete grid points: diversion and demand are each normalised by grid spacing before taking the distance; a point with the preset's parameters uses the preset (it has per-frame trajectories)
  function nearest(cat, want) {
    const cands = [];
    if (cat.preset && cat.preset.path) cands.push({ key: 'preset', params: cat.preset.params, path: cat.preset.path, preset: true });
    for (const g of cat.grid || []) if (g && g.status === 'complete' && g.path) cands.push({ key: g.key, params: g.params, path: g.path, preset: false });
    if (!cands.length) throw new SumoError('baked_missing', 'no usable point in the pre-computed results');
    const step = (k) => {
      const v = [...new Set(cands.map((c) => num(c.params[k], 0)))].sort((a, b) => a - b);
      let s = Infinity;
      for (let i = 1; i < v.length; i++) s = Math.min(s, v[i] - v[i - 1]);
      return Number.isFinite(s) && s > 0 ? s : 1;
    };
    const sd = step('diversion_share'), sx = step('demand_scale');
    const score = (c) => Math.hypot((num(c.params.diversion_share, 0) - want.diversion_share) / sd, (num(c.params.demand_scale, 0) - want.demand_scale) / sx);
    return cands
      .map((c) => ({ ...c, d: score(c) }))
      .sort((a, b) => a.d - b.d || (a.d < 1e-9 && b.d < 1e-9 ? b.preset - a.preset : 0) || Math.abs(a.params.demand_scale - want.demand_scale) - Math.abs(b.params.demand_scale - want.demand_scale) || (a.key < b.key ? -1 : 1))[0];
  }

  async function bakedFor(params = {}) {
    const cat = await loadBaked();
    const want = normalize(params);
    let c = nearest(cat, want);
    // grid point with exactly the preset's parameters → use the preset (same results, plus trajectories)
    if (!c.preset && cat.preset && cat.preset.path && sameRun(c.params, cat.preset.params)) c = { key: 'preset', params: cat.preset.params, path: cat.preset.path, preset: true };
    if (!/^(preset\/index|grid\/[\w.-]+)\.json$/.test(c.path)) throw new SumoError('baked_missing', `invalid pre-computed path: ${c.path}`);
    if (!files.has(c.path)) {
      const p = request(`${root}/${c.path}`, { ms: FILE_MS }).then((r) => {
        if (r.status !== 200 || !r.data || !Array.isArray(r.data.scenarios)) throw new SumoError('baked_missing', `could not load ${c.path} (${msgOf(r)})`);
        return r.data;
      });
      files.set(c.path, p);
      p.catch(() => files.delete(c.path));
    }
    const index = await files.get(c.path);
    const failed = (cat.grid || []).find((g) => g && g.status !== 'complete' && g.params && sameRun(g.params, want));
    return {
      key: c.key, exact: sameRun(c.params, want), params: c.params, requested: want, index,
      engine: cat.engine, generatedAt: cat.generated_at, bakedOn: cat.source, generator: cat.generator_sha256,
      hasReplay: c.preset,
      ...(failed ? { failedExact: { key: failed.key, error: failed.error || '' } } : {}),
      source: 'baked', // last, so it overrides whatever source the file claims
    };
  }

  async function fallback(params, reason, extra) {
    try {
      return { ...(await bakedFor(params)), reason, ...extra, source: 'baked' };
    } catch (e) {
      return { source: 'none', reason, ...extra, index: null, hasReplay: false, bakedError: e.message };
    }
  }

  // One cloud run: health → POST /runs → poll every pollMs → fetch index.json once complete.
  // Success returns { [LIVE]: true, runId, elapsedMs, data, h }; any failure goes to fb(reason, extra) for the fallback (its return value is returned as-is)
  async function drive(body, { onStatus, signal, limitMs, fb, healthMs = HEALTH_MS, healthReason = (h) => h.error, indexOk = (d) => Array.isArray(d.scenarios) }) {
    const t0 = now();
    const left = () => limitMs - (now() - t0);
    const emit = (phase, extra) => { if (onStatus) try { onStatus({ phase, elapsedMs: now() - t0, ...extra }); } catch { /* an error in the page callback does not affect the run */ } };
    const back = (reason, extra = {}) => { emit('fallback', { reason }); return fb(reason, extra); };
    if (signal && signal.aborted) return back('cancelled');

    emit('health');
    const h = await health({ signal, ms: healthMs, limitMs });
    if (!h.ok) {
      const reason = healthReason(h);
      // the real network reports every health failure as health_down; the specific cause (sumo_starting / timeout / network …) stays in detail
      return back(reason, { error: h.msg, status: h.status, ...(reason !== h.error ? { detail: h.error } : {}) });
    }

    let runId, last = null;
    try {
      emit('submit');
      const r = await request(`${api}/runs`, { method: 'POST', body, ms: Math.min(REQ_MS, left()), signal });
      if (r.status !== 202 || !r.data || !RUN_ID.test(r.data.id || '')) {
        return back(r.status === 202 ? 'bad_response' : reasonOf(r.status, r.data), { error: msgOf(r), status: r.status });
      }
      runId = r.data.id;
      last = r.data.status || 'queued';
      emit(last, { runId });
    } catch (e) {
      return back(e.code, { error: e.message });
    }

    // the in-flight run is only recorded (liveRunId); a pre-computed result never carries a runId
    let misses = 0;
    for (;;) {
      if (left() <= 0) return back('timeout', { error: `did not finish within ${Math.round(limitMs / 1000)} s`, liveRunId: runId });
      try { await sleep(Math.min(pollMs, left()), signal); } catch { return back('cancelled', { liveRunId: runId }); }
      if (left() <= 0) return back('timeout', { error: `did not finish within ${Math.round(limitMs / 1000)} s`, liveRunId: runId });
      let r;
      try {
        r = await request(`${api}/runs/${runId}`, { ms: Math.min(REQ_MS, left()), signal });
      } catch (e) {
        if (e.code === 'cancelled') return back('cancelled', { liveRunId: runId });
        if (++misses >= 3 || left() <= 0) return back(left() <= 0 ? 'timeout' : e.code, { error: e.message, liveRunId: runId });
        continue;
      }
      if (r.status !== 200 || !r.data) {
        if (r.status === 404 || ++misses >= 3) return back(reasonOf(r.status, r.data), { error: msgOf(r), status: r.status, liveRunId: runId });
        continue;
      }
      misses = 0;
      const st = r.data.status;
      if (st !== last) { emit(st, { runId }); last = st; }
      if (st === 'failed') return back('sumo_failed', { error: String(r.data.error || ''), liveRunId: runId });
      if (st !== 'complete') continue;
      try {
        // the result is ready: allow at least 5 s to fetch the index rather than drop it because the overall limit just ran out
        const ix = await request(`${api}/runs/${runId}/index.json`, { ms: Math.min(REQ_MS, Math.max(left(), 5000)), signal });
        if (ix.status !== 200 || !ix.data || !indexOk(ix.data)) {
          return back(reasonOf(ix.status, ix.data), { error: msgOf(ix), status: ix.status, liveRunId: runId });
        }
        const elapsedMs = now() - t0;
        emit('done', { runId });
        return { [LIVE]: true, runId, elapsedMs, data: ix.data, h };
      } catch (e) {
        return back(e.code, { error: e.message, liveRunId: runId });
      }
    }
  }

  async function run(params = {}, { onStatus, signal } = {}) {
    const body = pick(params);
    const r = await drive(body, { onStatus, signal, limitMs: timeoutMs, fb: (reason, extra) => fallback(params, reason, extra) });
    if (!r || !r[LIVE]) return r;
    return { runId: r.runId, elapsedMs: r.elapsedMs, index: r.data, engine: r.data.engine || r.h.engine, params: r.data.config || body, hasReplay: true, source: 'live' };
  }

  // ---- Real CBD network (contract v2) ----
  const isRealIndex = (d) => !!d && d.version === 2 && d.network === 'real' && Array.isArray(d.scenarios);

  // Pre-computed real-network results: /sumo/public/real/index.json (downloaded once; failures are not cached)
  function loadReal() {
    if (!realP) {
      realP = (async () => {
        const r = await request(`${realRoot}/index.json`, { ms: FILE_MS });
        if (r.status !== 200 || !isRealIndex(r.data)) throw new SumoError('baked_missing', `pre-computed real-network index.json missing or malformed (${msgOf(r)})`);
        return { network: 'real', index: r.data, engine: r.data.engine, generator: r.data.generator_sha256, source: 'baked' };
      })();
      realP.catch(() => { realP = null; });
    }
    return realP;
  }

  async function realFallback(reason, extra) {
    try {
      return { ...(await loadReal()), reason, ...extra, network: 'real', source: 'baked' };
    } catch (e) {
      return { network: 'real', reason, ...extra, index: null, bakedError: e.message, source: 'none' };
    }
  }

  // Real-network request body: finite numbers only (plus scenarios as an array); serve.py's validate_real checks ranges, out of range → 400 → fallback with bad_params
  function realBody(params = {}) {
    const out = { network: 'real' };
    for (const k of ['seed', 'p_original', 'p_ai']) if (typeof params[k] === 'number' && Number.isFinite(params[k])) out[k] = params[k];
    if (Array.isArray(params.scenarios) && params.scenarios.length) out.scenarios = params.scenarios.filter((x) => REAL_SCENARIOS.includes(x));
    return out;
  }

  // Cloud re-run of the real network: success {source:'live', network:'real', runId, elapsedMs, index}; any failure falls back to {source:'baked', reason, index}
  async function runReal(params = {}, { onStatus, signal, timeoutMs: limitMs = REAL_TIMEOUT_MS } = {}) {
    const body = realBody(params);
    const r = await drive(body, {
      onStatus, signal, limitMs, fb: realFallback, healthMs: REAL_HEALTH_MS, indexOk: isRealIndex,
      healthReason: (h) => (h.error === 'cancelled' ? 'cancelled' : 'health_down'),
    });
    if (!r || !r[LIVE]) return r;
    return { network: 'real', runId: r.runId, elapsedMs: r.elapsedMs, index: r.data, engine: r.data.engine || r.h.engine, params: r.data.params || body, source: 'live' };
  }

  function realBase(ref) {
    if (ref && ref.source === 'live' && RUN_ID.test(ref.runId || '')) return `${api}/runs/${ref.runId}`;
    if (ref && ref.source === 'baked') return realRoot;
    throw new SumoError('no_replay', 'no real-network result to replay (source is not live / baked)');
  }

  async function realManifest(ref, scenario, { signal } = {}) {
    if (!isRealScenario(scenario)) throw new SumoError('bad_params', `unknown scenario: ${scenario}`);
    const r = await request(`${realBase(ref)}/${scenario}/manifest.json`, { ms: FILE_MS, signal });
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.chunks)) throw new SumoError(reasonOf(r.status, r.data), msgOf(r));
    return r.data;
  }

  // file may be a file name or manifest.chunks[i] itself: with a sha256 and WebCrypto it is verified; without WebCrypto (plain-http pages etc.) the check is skipped rather than breaking the page
  async function realChunk(ref, scenario, file, { signal } = {}) {
    const entry = file && typeof file === 'object' ? file : { file };
    if (!isRealScenario(scenario) || !/^frames-\d{3}\.json$/.test(entry.file || '')) throw new SumoError('bad_params', `unrecognised chunk: ${scenario}/${entry.file}`);
    const r = await request(`${realBase(ref)}/${scenario}/${entry.file}`, { ms: FILE_MS, signal });
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.frames)) throw new SumoError(reasonOf(r.status, r.data), msgOf(r));
    if (entry.sha256) {
      let got = null;
      try { if (globalThis.crypto && globalThis.crypto.subtle) got = await sha256Hex(r.text); } catch { got = null; }
      if (got !== null && got !== entry.sha256) throw new SumoError('bad_chunk', `${scenario}/${entry.file}: sha256 does not match the manifest`);
    }
    return r.data;
  }

  function replayBase(ref) {
    if (ref && ref.source === 'live' && RUN_ID.test(ref.runId || '')) return `${api}/runs/${ref.runId}`;
    if (ref && ref.source === 'baked' && ref.hasReplay === true) return `${root}/preset`;
    throw new SumoError('no_replay', 'this result has metrics only, no per-frame trajectories (pre-computed grid points store only the index)');
  }

  async function manifest(ref, scenario, { signal } = {}) {
    if (!SCENARIOS.includes(scenario)) throw new SumoError('bad_params', `unknown scenario: ${scenario}`);
    const r = await request(`${replayBase(ref)}/${scenario}/manifest.json`, { ms: FILE_MS, signal });
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.chunks)) throw new SumoError(reasonOf(r.status, r.data), msgOf(r));
    return r.data;
  }

  // file may be a file name or manifest.chunks[i] itself: a sha256 is verified wherever WebCrypto is available
  async function chunk(ref, scenario, file, { signal } = {}) {
    const entry = file && typeof file === 'object' ? file : { file };
    if (!SCENARIOS.includes(scenario) || !/^frames-\d{3}\.json$/.test(entry.file || '')) throw new SumoError('bad_params', `unrecognised chunk: ${scenario}/${entry.file}`);
    const r = await request(`${replayBase(ref)}/${scenario}/${entry.file}`, { ms: FILE_MS, signal });
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.frames)) throw new SumoError(reasonOf(r.status, r.data), msgOf(r));
    if (entry.sha256 && globalThis.crypto && globalThis.crypto.subtle && (await sha256Hex(r.text)) !== entry.sha256) {
      throw new SumoError('bad_chunk', `${scenario}/${entry.file}: sha256 does not match the manifest`);
    }
    return r.data;
  }

  // ---- Options mode: baseline + one opt-<id> scenario per option; no pre-computed fallback ----
  // Request body: 1–5 options {id: unique A–E, p: finite number in 0–1}; returns null if invalid (no request sent); seed only if finite, serve.py checks its range
  function optionsBody(options, seed) {
    if (!Array.isArray(options) || options.length < 1 || options.length > OPTION_IDS.length) return null;
    const seen = new Set();
    const opts = [];
    for (const o of options) {
      if (!o || !OPTION_IDS.includes(o.id) || seen.has(o.id) || typeof o.p !== 'number' || !Number.isFinite(o.p) || o.p < 0 || o.p > 1) return null;
      seen.add(o.id);
      opts.push({ id: o.id, p: o.p });
    }
    const body = { network: 'real' };
    if (typeof seed === 'number' && Number.isFinite(seed)) body.seed = seed;
    body.options = opts;
    return body;
  }

  // Success {source:'live', network:'real', runId, elapsedMs, index, engine, params}; any failure {source:'none', network:'real', reason, index:null, …}
  async function runOptions(options, { seed, onStatus, signal, timeoutMs: limitMs = OPTIONS_TIMEOUT_MS } = {}) {
    const none = (reason, extra = {}) => ({ network: 'real', reason, ...extra, index: null, source: 'none' });
    const body = optionsBody(options, seed);
    if (!body) return none('bad_params', { error: 'options must be 1–5 items {id: unique A–E, p: 0–1}' });
    const want = body.options.map((o) => `opt-${o.id}`);
    const r = await drive(body, {
      onStatus, signal, limitMs, fb: none, healthMs: REAL_HEALTH_MS,
      indexOk: (d) => isRealIndex(d) && want.every((id) => d.scenarios.some((x) => x && x.id === id && x.metrics)),
      healthReason: (h) => (h.error === 'cancelled' ? 'cancelled' : 'health_down'),
    });
    if (!r || !r[LIVE]) return r;
    return { network: 'real', runId: r.runId, elapsedMs: r.elapsedMs, index: r.data, engine: r.data.engine || r.h.engine, params: r.data.params || body, source: 'live' };
  }

  return { health, run, loadBaked, bakedFor, manifest, chunk, loadReal, runReal, runOptions, realManifest, realChunk };
}
