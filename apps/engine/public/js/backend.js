// backend.js — the wiring layer (D-0929-1540): the web page's main entry point, so the page never assembles the engine itself.
// Loads the road network + flows + transit (transit.json) from apps/roads, parameters from apps/params and the sign reader (readSigns / checkSigns) from apps/api in one go and builds the engine;
// the page calls run / compare / advise / check and gets display-ready numbers (summary), with the raw engine result in .raw. Nothing that fails to load throws (except the road network):
//   params → assumed values; sign reader → the engine's keyword rules; checkSigns → no checking; transit → not computed (summary.transit = { src: null }).
//   status() says what each one is using.
// Pedestrians: also loads the footpath network walk.json + pedestrian counts peds.json; when the plan closes a footpath (closes.footpath) the detour is computed → summary.peds.
//   These two files (3.6 MB) load in the background and connect() does not wait for them (vehicle numbers are not held up): status().peds = 'loading' → fetched / given / none;
//   run() waits for them only when a footpath is actually closed this hour (at most PEDS_WAIT_MS); timing out or failing never throws, summary.peds = { src: null, footpath }.
// Usage (browser, same origin as /engine/ /roads/ /api/ /params/):
//   const be = await (await import('/engine/public/js/backend.js')).connect();
//   const s = await be.run(be.demo('lonsdale'));     // s.queue_m, s.mean_delay_s, s.routes, s.by_type, s.flags, s.transit (trams and buses) …
//   const c = await be.compare(be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), be.demo('lonsdale'));  // before / after
// The engine core (everything index.js exports) still never imports the api module; only this wiring layer dynamically loads the apps/api files by URL.

import {
  createEngine, mockReadSigns, mockAdvise, advise as adviseCore, loadParams, PARAMS_URL, TYPES,
  requestsFor, affected, capFactors, windowWhens, transitImpact, isTransit, validatePlan, pedImpact, pedsUnavailable, footpathActive,
  advisorSummary, sampleHours, overlaps, shiftWorksite,
} from './index.js';
import { TIERS, VMS_AT_M, WARN_FRAME, daysOf, siteOf, tierNeeds, resolveNeeds, hireOf, stockOf, guidedFrames, delayFrames, vmsTextOk, timeErrors, whenErrors, usageOf, sharingWith, vmsRead } from './options.js';
import { isActive } from './worksite.js';
import { requestKey } from './reading.js';

const jclone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
export const AI_LOG_MAX = 200; // max entries kept in the AI call log (ring buffer, oldest dropped first); in memory only, never uploaded
export const PEDS_WAIT_MS = 8000; // max ms run() waits for pedestrian data still loading when a footpath is closed (after that it returns vehicle numbers first, summary.peds.src = null, pending = true)

export const PATHS = {
  network: '/roads/public/cbd/network.json',
  flows: '/roads/public/cbd/flows.json',
  transit: '/roads/public/cbd/transit.json',
  walk: '/roads/public/cbd/walk.json', // footpath network
  peds: '/roads/public/cbd/peds.json', // pedestrians per footpath per hour
  equipment: '/roads/public/cbd/equipment.json', // RPM Hire equipment stock + day rates (assumed values); fetched on the first be.options() call
  params: PARAMS_URL,
  reader: '/api/public/js/reader.js',
  check: '/api/public/js/check.js',
};

// demo plans, checked on the real network (docs/hackathon/specs/T13-web-wiring-PRD.md §3). at_m = metres upstream of the works start
const WEEK = { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] };
const DEMOS = {
  // main demo: Lonsdale St westbound, one block from the La Trobe / Swanston junction, about 1,100 veh/h at 08:00, so one closed lane queues
  lonsdale: {
    when: { date: '2026-10-06', hour: 8 },
    worksites: [{
      id: 'B-12', name: 'Lonsdale St westbound lane closure', links: ['l595594354_9756035316'], closes: { lanes: 1 }, time: WEEK,
      equipment: [
        { id: 'VMS-1', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']] },
        { id: 'S-1', type: 'sign', at_m: 100, text: 'RIGHT LANE CLOSED' },
        { id: 'A-1', type: 'arrow', at_m: 60 },
        { id: 'B-1', type: 'barrier', at_m: 0 },
      ],
    }],
  },
  // second scene: La Trobe St westbound, west of Swanston St, at 17:00. Light traffic, so one closed lane barely queues (a finding in itself)
  latrobe: {
    when: { date: '2026-10-06', hour: 17 },
    worksites: [{
      id: 'B-12', name: 'La Trobe St westbound lane closure at Swanston St', links: ['l2187770692_2190483583'], closes: { lanes: 1 }, time: WEEK,
      equipment: [
        { id: 'VMS-1', type: 'vms', at_m: 260, frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']] },
        { id: 'S-1', type: 'sign', at_m: 100, text: 'RIGHT LANE CLOSED' },
        { id: 'A-1', type: 'arrow', at_m: 60 },
        { id: 'B-1', type: 'barrier', at_m: 0 },
      ],
    }],
  },
};
const clone = x => JSON.parse(JSON.stringify(x));

// demo('lonsdale', { frames, at_m, hour }) → a fresh copy of the plan (VMS-1 text / position and the hour changed)
export function demoPlan(name, { frames, at_m, hour } = {}) {
  if (!DEMOS[name]) throw new Error(`No demo plan ${name} (available: ${Object.keys(DEMOS).join(' / ')})`);
  const plan = clone(DEMOS[name]);
  const vms = plan.worksites[0].equipment.find(e => e.id === 'VMS-1');
  if (frames) vms.frames = clone(frames);
  if (Number.isFinite(at_m)) vms.at_m = at_m;
  if (Number.isInteger(hour)) plan.when.hour = hour;
  return plan;
}
export const DEMO_NAMES = Object.keys(DEMOS);

async function getJSON(url, f) {
  if (typeof f !== 'function') throw new Error(`Reading ${url} needs fetch`);
  const res = await f(url);
  if (!res || !res.ok) throw new Error(`Failed to read ${url}: HTTP ${res ? res.status : 'no response'}`);
  return res.json();
}

// engine result → the numbers the page needs. Affected vehicles = the personas' vehicles (by_type); slowed background traffic is counted separately (others_min)
// transit = transitImpact() result (trams and buses); absent = transit data not loaded → { src: null }
export function summarize(res, { failed = 0, params = null, signCheck = null, transit = null } = {}) {
  const veh = TYPES.reduce((s, t) => s + (res.by_type[t]?.vehicles || 0), 0);
  const affectedMin = TYPES.reduce((s, t) => s + (res.by_type[t]?.delay_min || 0), 0);
  const approaches = res.approaches.map(a => ({
    worksite: a.worksite, entry: a.entry, street: a.street, dir: a.dir, to: a.to, volume: a.volume, blocked: a.blocked,
    queue_m: a.queue_m, delay_min: a.delay_min, detour_share: +(1 - (a.share?.stay ?? 0)).toFixed(3),
    routes: a.routes.map(r => ({ id: r.id, name: r.name, share: r.share, usual_min: r.usual_min, now_min: r.now_min, extra_min: r.extra_min, turn_m: r.turn_m, truck: r.truck })),
    by_type: Object.fromEntries(TYPES.map(t => [t, {
      detour: a.by_type[t]?.detour ?? 0, informed: a.by_type[t]?.informed ?? 0, extra_min: a.by_type[t]?.extra_min ?? 0,
      why: a.by_type[t]?.reading?.why ?? null, // render with textContent
    }])),
  }));
  // main approach = the one with the largest delay: queue, split and "why" all come from it, never mixed across approaches (with several worksites)
  const mainIdx = approaches.reduce((bi, a, i) => ((a.delay_min || 0) > (approaches[bi]?.delay_min || 0) ? i : bi), 0);
  const main = approaches[mainIdx] || null;
  const signErrors = (signCheck || []).filter(c => !c.ok);
  return {
    when: res.when,
    delay_min: res.delay_min, // network total delay (veh·min, including background traffic)
    affected_min: Math.round(affectedMin), // total delay of affected vehicles
    others_min: res.others_min, // background traffic not on the works approach but slowed by diverted traffic
    vehicles: Math.round(veh),
    mean_delay_s: veh ? Math.round((affectedMin / veh) * 60) : 0, // mean extra seconds per affected vehicle
    main: main ? mainIdx : null, // index of the main approach in approaches
    street: main ? main.street : null,
    queue_m: main ? main.queue_m : 0,
    detour_share: main ? main.detour_share : 0,
    routes: main ? main.routes : [],
    why: Object.fromEntries(TYPES.map(t => [t, main ? main.by_type[t].why : null])), // one reason per persona (main approach; render with textContent)
    blocked_vph: res.blocked_vph, // vehicles stuck at a full closure with no detour (veh/h), not counted as delay
    active: res.active, // ids of worksites active at this time; empty = no works now, all numbers 0
    by_type: Object.fromEntries(TYPES.map(t => [t, { per_capita_min: res.by_type[t]?.per_capita_min ?? 0, vehicles: res.by_type[t]?.vehicles ?? 0, delay_min: res.by_type[t]?.delay_min ?? 0 }])),
    approaches,
    hot: res.hot,
    transit: transit || { src: null }, // affected tram / bus routes and rider-minutes (transit.js; riders per trip are assumed, see transit.assumed)
    flags: {
      // ok = the numbers can be trusted (all readings obtained, calibration hit, sign text valid); false → the UI shows a warning
      ok: !res.missing && !failed && res.calib.ok && !signErrors.length && !(res.blocked_vph > 0),
      missing: res.missing, failed,
      blocked_vph: res.blocked_vph,
      inactive: !res.active.length, // true = none of the plan's worksites is active at this time
      reading_src: res.calib.src, // rule = keyword-rule estimate; with the LLM reader it is file / the model name
      calib_ok: res.calib.ok,
      params: params ? params.src : null, // params = sourced (params.json); default = assumed values
      sign_errors: signErrors.map(c => ({ worksite: c.worksite, street: c.street, code: c.error?.code, msg: c.error?.msg })),
      sign_warnings: (signCheck || []).flatMap(c => (c.warnings || []).map(w => ({ worksite: c.worksite, street: c.street, ...w }))),
    },
    raw: res,
  };
}

// invalid plan (e.g. a malformed closes.footpath) → throws this error: .code = 'bad_plan', .errors = each reason. The page can call be.validate(plan) first
function planError(errs) {
  const e = new Error('Invalid plan: ' + errs.join('; '));
  e.code = 'bad_plan';
  e.errors = errs;
  return e;
}

// footpath network + pedestrian counts: use them if given, otherwise fetch from the same origin; failure or bad format never throws (→ status.peds = 'none')
async function loadPeds(opts, base, f) {
  if (opts.walk && opts.peds) return { walk: opts.walk, peds: opts.peds, st: 'given' };
  try {
    const [walk, peds] = await Promise.all([opts.walk || getJSON(base + PATHS.walk, f), opts.peds || getJSON(base + PATHS.peds, f)]);
    if (!Array.isArray(walk?.nodes) || !Array.isArray(walk?.links)) throw new Error('walk.json must have nodes[] and links[]');
    if (!peds?.days || typeof peds.days !== 'object') throw new Error('peds.json must have days');
    return { walk, peds, st: 'fetched' };
  } catch (e) {
    return { walk: null, peds: null, st: 'none', err: `Footpath / pedestrian data not loaded, pedestrian impact not computed (summary.peds.src = null): ${e?.message || e}` };
  }
}

// opts: base (URL prefix, default same origin), fetch, importer (dynamic import, injected in tests); network / flows / transit / params / readSigns / checkSigns / walk / peds can also be passed directly
//   onAiLog (called with one record per sign-reading call), aiLogMax (log size limit, default AI_LOG_MAX)
export async function connect(opts = {}) {
  const base = opts.base ?? '';
  const f = 'fetch' in opts ? opts.fetch : globalThis.fetch;
  const importer = opts.importer || (u => import(u));
  const status = { network: 'given', transit: null, params: null, reader: null, check: null, peds: 'loading', errors: [], reader_errors: {} };
  // 0 transit (transit.json): starts downloading with the network; failure does not throw, trams and buses are just not computed
  const transitP = opts.transit ? Promise.resolve(opts.transit) : getJSON(base + PATHS.transit, f);
  transitP.catch(() => {}); // catch now, await below (no unhandled rejection if the network fails first and throws)
  // 5 footpaths + pedestrians: background fetch, connect does not wait (not on the critical path of the vehicle numbers)
  let pd = opts.walk && opts.peds ? { walk: opts.walk, peds: opts.peds, st: 'given' } : { st: 'loading' };
  status.peds = pd.st;
  const pedsP = (pd.st === 'given' ? Promise.resolve(pd) : loadPeds(opts, base, f)).then(r => {
    pd = r; status.peds = r.st;
    if (r.err) status.errors.push(r.err);
    return r.st;
  });
  const waitMs = Number.isFinite(opts.pedsWaitMs) ? opts.pedsWaitMs : PEDS_WAIT_MS;
  function waitPeds() {
    if (pd.st !== 'loading') return Promise.resolve();
    let tm;
    return Promise.race([pedsP, new Promise(r => { tm = setTimeout(r, waitMs); })]).finally(() => clearTimeout(tm));
  }

  // 1 network + flows: nothing can be computed without them, so a failure here throws
  let { network, flows } = opts;
  if (!network || !flows) {
    [network, flows] = await Promise.all([getJSON(base + PATHS.network, f), getJSON(base + PATHS.flows, f)]);
    status.network = 'fetched';
  }
  // 2 parameters (apps/params)
  const params = opts.params ?? await loadParams({ url: base + PATHS.params, fetch: f });
  // 3 sign reader (apps/api reader.js): falls back to the engine's rule reader
  let rs = opts.readSigns;
  if (rs) status.reader = 'given';
  else {
    try { rs = (await importer(base + PATHS.reader)).readSigns; if (typeof rs !== 'function') throw new Error('reader.js does not export readSigns'); status.reader = 't5'; }
    catch (e) { rs = mockReadSigns; status.reader = 'engine-mock'; status.errors.push(`Sign reader (apps/api reader.js) not loaded, using the engine's keyword rules: ${e?.message || e}`); }
  }
  // reader errors: an invalid request (SignError, with .code) → rethrown; the engine counts that persona as "nobody persuaded" and summary.flags.failed reports the count;
  // any other error (e.g. no crypto.subtle on a non-https page, so the reader throws computing its cache key) → that call uses the engine's rule reader instead, so numbers never silently get worse
  // AI call log (the page's "AI road users" and "AI call log" panels): one record per reader call { seq, t, persona, signs, roads, kmh, read_s, src, model, ms, reading },
  // rule fallbacks recorded truthfully (src: rule + fallback reason), errors as src: error. A thin wrapper: no extra requests, readings unchanged; the engine caches readings by text + persona, so each wording is asked once
  const aiLog = [];
  const logMax = Number.isInteger(opts.aiLogMax) && opts.aiLogMax > 0 ? opts.aiLogMax : AI_LOG_MAX; // tests can lower it
  const aiSubs = new Set(typeof opts.onAiLog === 'function' ? [opts.onAiLog] : []);
  const aiByKey = new Map(); // requestKey → this session's record for that request (used by readingsOf)
  let aiSeq = 0;
  const clk = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
  function aiRecord(req, r, t0, extra = {}) {
    const e = {
      seq: ++aiSeq, t: new Date().toISOString(), persona: req?.persona ?? null,
      signs: jclone(req?.signs || []), roads: jclone(req?.roads || []), kmh: req?.kmh ?? null,
      read_s: (req?.signs || []).map(x => x?.read_s ?? null),
      src: r ? (r.src ?? null) : 'error', model: r?.model ?? null, ms: Math.max(0, Math.round(clk() - t0)),
      reading: r ? jclone(r) : null, ...extra,
    };
    aiLog.push(e);
    if (aiLog.length > logMax) aiLog.splice(0, aiLog.length - logMax);
    try { aiByKey.set(requestKey(req), e); } catch { /* an invalid request is still logged */ }
    for (const fn of aiSubs) { try { fn(jclone(e)); } catch { /* an error in a page callback does not affect readings */ } }
  }
  const reader = async req => {
    const t0 = clk();
    try { const r = await rs(req); aiRecord(req, r, t0); return r; } catch (e) {
      const k = e?.code || 'fallback: ' + (e?.message || String(e));
      status.reader_errors[k] = (status.reader_errors[k] || 0) + 1;
      if (!e?.code && rs !== mockReadSigns) {
        const r = await mockReadSigns(req);
        aiRecord(req, r, t0, { fallback: String(e?.message || e).slice(0, 200) });
        return r;
      }
      aiRecord(req, null, t0, { error: String(e?.code || e?.message || e).slice(0, 200) });
      throw e;
    }
  };
  const errCount = () => Object.entries(status.reader_errors).filter(([k]) => !k.startsWith('fallback')).reduce((n, [, c]) => n + c, 0);
  // 4 sign text rule check (apps/api checkSigns)
  let check = opts.checkSigns;
  if (check) status.check = 'given';
  else {
    try { check = (await importer(base + PATHS.check)).checkSigns; if (typeof check !== 'function') throw new Error('check.js does not export checkSigns'); status.check = 't5'; }
    catch (e) { check = null; status.check = 'none'; status.errors.push(`checkSigns (apps/api check.js) not loaded, sign text is not checked: ${e?.message || e}`); }
  }

  let transit = null;
  try {
    transit = await transitP;
    if (!isTransit(transit)) throw new Error('transit.json has no routes[]');
    status.transit = opts.transit ? 'given' : 'gtfs';
  } catch (e) { transit = null; status.transit = 'none'; status.errors.push(`Transit data not loaded, trams and buses not computed: ${e?.message || e}`); }

  const engine = createEngine({ network, flows, readSigns: reader, params });
  status.params = engine.params.src;
  if (engine.params.errors.length) status.errors.push(...engine.params.errors.map(e => 'params: ' + e));

  // pedestrian impact: no footpath closed this hour → all zeros without the data (no waiting even if it is still loading); closed → wait for the data (at most waitMs)
  async function pedsOf(plan) {
    try {
      if (pd.st === 'loading') {
        if (!footpathActive(plan)) return pedImpact(null, null, plan);
        await waitPeds();
        if (pd.st === 'loading') return { ...pedsUnavailable(plan), pending: true, error: `Footpath / pedestrian data did not arrive within ${waitMs} ms; pedestrians skipped this time` };
      }
      if (!pd.walk) return pedsUnavailable(plan);
      return pedImpact(pd.walk, pd.peds, plan, { net: engine.net });
    } catch (e) { return { ...pedsUnavailable(plan), error: String(e?.message || e) }; } // bad data never breaks the vehicle numbers (and leaves no unhandled rejected promise)
  }
  const validate = plan => validatePlan(plan);
  const runPlans = new WeakMap(), readCache = new WeakMap(); // run() summary → its plan / readings (used by readingsOf)
  let lastRun = null;

  // sign text validity: checked on the requests the engine would actually send (each affected approach × the commuter's "all signs" request).
  // Validity does not depend on time: every worksite in the plan is checked, not just those active now
  function checkPlan(plan) {
    const all = plan.worksites || [];
    const factors = capFactors(engine.net, all);
    const out = [];
    for (const ws of all) {
      for (const ap of affected(engine.net, engine.flows, ws, plan.when, factors)) {
        const req = requestsFor(ap, ws, ['commuter']).full.commuter;
        if (!req) continue;
        if (!check) { out.push({ worksite: ws.id, street: ap.street, ok: true, warnings: [], unchecked: true }); continue; }
        let r;
        try { r = check(req); } catch (e) { r = { ok: false, error: { code: 'check_threw', msg: String(e?.message || e) }, warnings: [] }; }
        out.push({ worksite: ws.id, street: ap.street, ...r });
      }
    }
    return out;
  }

  // trams and buses: a failure must not break the page; it is reported in transit.error
  function transitFor(plan, res) {
    if (!transit) return { src: null };
    try { return transitImpact(engine.net, engine.flows, transit, plan, res); } catch (e) { return { src: null, error: String(e?.message || e) }; }
  }

  async function run(plan) {
    const errs = validate(plan);
    if (errs.length) throw planError(errs);
    const pedsP1 = pedsOf(plan); // awaited alongside the vehicle computation
    const prep = await engine.prepare(plan);
    const res = engine.evaluate(plan);
    const s = summarize(res, { failed: prep.failed, params: engine.params, signCheck: checkPlan(plan), transit: transitFor(plan, res) });
    s.peds = await pedsP1; // pedestrian detour for a footpath closure; not closed / works inactive = all zeros, data not loaded = { src: null }
    runPlans.set(s, jclone(plan)); lastRun = s;
    return s;
  }

  // for a run()'s main approach: which signs each persona read (in driving order), the reading, its source (file / kv / llm / rule) and how many ms it took.
  // Uses only existing readings and the log (never asks the reader again, sends no requests); a summary not from run(), or with no main approach → null
  function readingsOf(s) {
    if (!s || !runPlans.has(s)) return null;
    if (readCache.has(s)) return jclone(readCache.get(s));
    let out = null;
    try {
      const plan = runPlans.get(s), m = s.main == null ? null : s.approaches[s.main];
      const ws = m && (plan.worksites || []).find(w => w.id === m.worksite);
      if (ws) {
        const active = (plan.worksites || []).filter(w => isActive(w, plan.when));
        // same method as the engine's structure() (structure does not depend on time), so the same approach → the same reading requests
        const ap = affected(engine.net, null, ws, { date: '2000-01-03', hour: 0 }, capFactors(engine.net, active)).find(a => a.entry === m.entry);
        if (ap) {
          const full = requestsFor(ap, ws, TYPES).full;
          const personas = {};
          for (const t of TYPES) {
            const req = full[t];
            if (!req) { personas[t] = null; continue; }
            const k = requestKey(req), hit = aiByKey.get(k), r = engine.readings.get(k) ?? hit?.reading ?? null;
            personas[t] = { signs: jclone(req.signs), roads: jclone(req.roads), kmh: req.kmh, reading: r ? jclone(r) : null,
              src: r?.src ?? hit?.src ?? null, model: r?.model ?? null, ms: hit?.ms ?? null, t: hit?.t ?? null, fallback: hit?.fallback ?? null };
          }
          out = { when: s.when, worksite: m.worksite, entry: m.entry, street: m.street, dir: m.dir, personas };
        }
      }
    } catch { out = null; }
    readCache.set(s, out);
    return jclone(out);
  }

  // before / after comparison (step 4): two plans at the same time, negative = better
  // queue and detour share are compared on the before-plan's main approach: if the main approach moves to another street afterwards, the same stretch is still compared (flagged as main_changed)
  async function compare(before, after) {
    const [a, b] = [await run(before), await run(after)];
    const am = a.main == null ? null : a.approaches[a.main];
    const bm = am ? b.approaches.find(x => x.worksite === am.worksite && x.entry === am.entry) : null;
    // same stretch: the before-plan's main approach in the after result (if it is gone afterwards = no longer congested, count 0)
    const pick = (x, k) => (am ? (x === a ? am[k] : bm ? bm[k] : 0) : x[k]);
    const same = k => +(pick(b, k) - pick(a, k)).toFixed(3);
    const d = k => +(b[k] - a[k]).toFixed(3);
    return {
      before: a, after: b,
      delta: {
        delay_min: d('delay_min'), affected_min: d('affected_min'), mean_delay_s: d('mean_delay_s'),
        queue_m: same('queue_m'), detour_share: same('detour_share'),
        street: am ? am.street : null, main_changed: Boolean(am && b.main != null && b.approaches[b.main] !== bm),
        // tram / bus rider-minutes (after − before, negative = better); transit data not loaded = null. Stopped trams have no minutes; see transit.blocked_pax_h in before / after
        transit_pax_min: a.transit.src && b.transit.src ? b.transit.pax_min - a.transit.pax_min : null,
        // pedestrian extra person-minutes; pedestrian data not loaded = null
        peds_extra_min: a.peds?.src && b.peds?.src ? +(b.peds.extra_min - a.peds.extra_min).toFixed(3) : null,
      },
    };
  }

  // planning advisor (step 7): rule-based (mockAdvise; no LLM advisor was built); every suggestion is re-run by the engine. Numbers are summed over the whole works period (days × sampled hours)
  // a worksite without dates (time) has an empty works period: compare just the hour plan.when instead, otherwise every suggestion would score 0 and be marked "not recommended"
  async function advise(plan, { askAdvisor = mockAdvise } = {}) {
    const errs = validate(plan);
    if (errs.length) throw planError(errs);
    const e0 = errCount();
    const whens = windowWhens(plan.worksites || []).length ? undefined : [plan.when];
    const r = await adviseCore(engine, plan, { askAdvisor, whens });
    const missing = (r.before.result?.missing || 0) + r.options.reduce((n, o) => n + (o.result?.missing || 0), 0);
    const failed = errCount() - e0;
    return {
      src: r.src,
      window: { whens: r.whens, truncated: r.truncated, single_hour: Boolean(whens) },
      flags: { ok: !missing && !failed && engine.calib.ok, missing, failed, reading_src: engine.calib.src },
      before_min: r.before.delay_min,
      options: r.options.map(o => ({
        kind: o.suggestion.kind, worksite: o.suggestion.worksite, why: o.suggestion.why ?? null,
        frames: o.suggestion.frames ?? null, equipment: o.suggestion.equipment ?? null, at_m: o.suggestion.at_m ?? null, days: o.suggestion.days ?? null,
        skipped: o.skipped ?? null, after_min: o.delay_min ?? null, delta_min: o.delta_min ?? null, better: Boolean(o.better),
        plan: o.worksites ? { when: plan.when, worksites: o.worksites } : null,
      })),
    };
  }

  // inventory-constrained options (D-0929-2011 item 3): one worksite → 3 traffic-management kits, Minimum (no VMS) / Standard (two VMS reporting delay) / Guided (one VMS naming a detour),
  // each run by the engine for the same hour, with hire cost and a stock check.
  // Input: a single worksite (needs when, or a worksite time → defaults to the start date and the first sampled hour), or a whole plan { when, worksites } (builds worksites[0],
  // or the one named by opts.worksite; other worksites stay as they are and are computed together, and equipment taken by time-overlapping worksites is subtracted from stock first). The input is not modified.
  // options() itself never calls the LLM (the guidance frame uses the rule-based mockAdvise wording); each kit's readings go through the same reader chain as run() (answers file → /api/read → rules),
  // so identical readings give byte-identical output. Before a demo, the sign texts options() generates should be precomputed into the answers file, otherwise production asks /api/read live.
  let inventory = opts.equipment || null;
  let invSrc = inventory ? 'given' : null;
  async function inventoryOf() {
    if (!inventory) {
      try {
        const inv = await getJSON(base + PATHS.equipment, f);
        if (!Array.isArray(inv?.items)) throw new Error('equipment.json has no items[]');
        inventory = inv; invSrc = 'fetched';
      } catch (e) {
        const err = new Error(`Equipment inventory not loaded, cannot build options: ${e?.message || e}`);
        err.code = 'no_inventory';
        throw err;
      }
    }
    return inventory;
  }
  const brief = s => ({
    when: s.when, street: s.street, queue_m: s.queue_m, delay_min: s.delay_min, affected_min: s.affected_min, others_min: s.others_min,
    vehicles: s.vehicles, mean_delay_s: s.mean_delay_s, detour_share: s.detour_share, blocked_vph: s.blocked_vph,
    routes: s.routes.map(r => ({ id: r.id, name: r.name, share: r.share, extra_min: r.extra_min })),
    transit: s.transit?.src ? { src: s.transit.src, pax_min: s.transit.pax_min, blocked_pax_h: s.transit.blocked_pax_h } : null,
    peds: s.peds?.src ? { src: s.peds.src, extra_min: s.peds.extra_min } : null,
  });

  async function options(input, { n = 3, when, worksite } = {}) {
    const inv = await inventoryOf();
    const isPlan = Boolean(input && Array.isArray(input.worksites));
    const plan0 = clone(isPlan ? input : { when: null, worksites: [input] });
    const errs = validate(plan0);
    if (errs.length) throw planError(errs);
    const idx = worksite != null ? plan0.worksites.findIndex(w => w.id === worksite) : 0;
    if (idx < 0 || !plan0.worksites[idx]) throw planError([worksite != null ? `No worksite ${worksite} in the plan` : 'No worksite in the plan']);
    const ws = plan0.worksites[idx];
    const tErrs = timeErrors(ws.time, `Worksite ${ws.id ?? '?'}`);
    if (tErrs.length) throw planError(tErrs);
    if (when) plan0.when = clone(when);
    if (!plan0.when && ws.time?.from) plan0.when = { date: ws.time.from, hour: sampleHours([ws])[0] };
    if (!plan0.when) throw planError(['The worksite has no time; pass when ({ date, hour })']);
    const wErrs = whenErrors(plan0.when);
    if (wErrs.length) throw planError(wErrs);
    const site = siteOf(engine.net, ws);
    if (site.missing.length) throw planError([`Worksite ${ws.id ?? '?'}: links not in the network: ${site.missing.join(', ')} (counting them as 0 m would under-count barriers)`]);
    if (site.lanes == null) throw planError([`Worksite ${ws.id ?? '?'}: links is empty`]);
    const active = isActive(ws, plan0.when); // false = this worksite is inactive at `when`; all three kits score 0 and cannot be trusted
    const shared = sharingWith(plan0.worksites, ws); // other time-overlapping worksites: shared stock
    const used0 = usageOf(shared);
    const days = daysOf(ws.time);
    const count = Math.max(1, Math.min(TIERS.length, Math.floor(Number(n)) || TIERS.length));
    const planWith = equipment => ({ when: clone(plan0.when), worksites: plan0.worksites.map((w, i) => (i === idx ? { ...clone(w), equipment } : clone(w))) });

    const out = [];
    let guide = null; // set from the Minimum kit's engine result: the fastest detour's name, minutes saved, and how far before the turn the VMS goes
    let delay = null; // also set from the Minimum kit: extra minutes per vehicle on the stay route → the Standard tier's two VMS texts (delayFrames)
    for (const tier of TIERS.slice(0, count)) {
      const frames = tier.guided && guide?.frames ? guide.frames : tier.delay && delay?.frames ? delay.frames : [WARN_FRAME];
      const needs = tierNeeds(tier, ws, site, { vmsAt: guide?.at_m ?? VMS_AT_M, frames });
      const { equipment, short } = resolveNeeds(needs, inv, used0);
      const plan = planWith(equipment);
      const s = await run(plan);
      if (tier.id === 'o1' && count > 1) {
        const sum = advisorSummary(s.raw, [plan.worksites[idx]]);
        const adv = await mockAdvise(sum);
        const sug = (adv?.suggestions || []).find(x => x.kind === 'text' && x.worksite === ws.id);
        const fr = sug ? guidedFrames(sug.frames) : null;
        guide = { frames: fr, at_m: Number.isFinite(sug?.at_m) ? sug.at_m : VMS_AT_M, why: sug?.why ?? null };
        delay = delayFrames(sum, ws.id);
      }
      const vmsAll = equipment.filter(e => e.type === 'vms'), vms = vmsAll[0];
      const textOk = vms ? vmsAll.every(v => vmsTextOk(v.frames)) : null;
      const stock = { ...stockOf(equipment, inv, short, used0), shared_with: shared.map(w => w.id ?? null) };
      const read = vms ? vmsRead(equipment) : null; // every VMS made it into the reading request (not pushed out by the 6-sign limit)
      const flags = {
        ok: s.flags.ok && active && stock.ok && (!vms || (textOk && read)),
        stock_ok: stock.ok,
        vms_text_ok: textOk,
        vms_read: read,
        guided: Boolean(tier.guided && guide?.frames && vms && read),
        no_faster_detour: Boolean(tier.guided && !guide?.frames), // the engine finds no faster detour: the Guided VMS shows ROADWORK / AHEAD
        no_delay_min: Boolean(tier.delay && !delay), // the engine finds under 1 extra minute on the stay route (or no works): the Standard VMS shows ROADWORK / AHEAD
        sign_errors: s.flags.sign_errors, reading_src: s.flags.reading_src, params: s.flags.params, failed: s.flags.failed, missing: s.flags.missing,
        inactive: !active, full_closure: site.full, footpath: site.footpath, no_time: !ws.time, missing_links: site.missing,
        assumed: ['hire.day_rate_aud', 'stock.qty'], // D-0929-1536: hire rates and stock are assumed values, labelled as such in the UI
      };
      const hire = hireOf(equipment, inv, days), result = brief(s), first = out[0];
      out.push({
        id: tier.id, label: tier.label, label_zh: tier.label_zh,
        plan, hire, stock, result, flags,
        // versus the Minimum kit (this − Minimum, negative = less congestion); if the engine gives the same numbers they stay the same, no difference is invented
        vs: first ? { id: first.id, delay_min: +(result.delay_min - first.result.delay_min).toFixed(3), affected_min: result.affected_min - first.result.affected_min,
          queue_m: result.queue_m - first.result.queue_m, hire_aud: hire.total_aud - first.hire.total_aud } : null,
        ...(tier.guided ? { guide: { frames: guide?.frames ?? null, at_m: guide?.at_m ?? null, why: guide?.why ?? null } } : {}),
        ...(tier.delay ? { delay: { min: delay?.min ?? null, frames: delay?.frames ?? null } } : {}),
      });
    }
    return {
      worksite: ws.id ?? null, when: clone(plan0.when), days,
      site: { len_m: site.len_m, lanes: site.lanes, close_lanes: site.close_lanes, full: site.full, footpath: site.footpath },
      inventory: { src: invSrc, version: inventory.version ?? null, assumed: true }, options: out,
    };
  }

  // overlapping works (clash, D-0929-2011 item 2): how much more congestion this worksite and another one at the same time cause together than separately.
  // clash cost = D(A+B) − D(A) − D(B), D = network total delay (veh·min), computed by the engine's engine.conflict(), not reimplemented here.
  // Time window = the days the two worksites actually overlap × the peak hours inside the overlapping hours (8, 17; else the middle hour; same basis as advise()).
  //   Only overlapping moments matter: elsewhere only one worksite is active and the clash cost is 0 anyway. So a / b / ab are sums over the sampled hours of the overlap days, not the whole works period.
  //   opts.hours changes the sampled hours; opts.when computes a single moment. a and b can each be a worksite or a whole plan (worksites[0] is used).
  // Display fields a / b / ab / cost are never negative; raw numbers are in raw. Two kinds of "≈ 0" are flagged separately:
  //   flags.negative_delay: one of D(A) / D(B) / D(A+B) is < 0 (links whose baseline flow already exceeds capacity, e.g. Flinders St, see #58)
  //     → flags.reliable = false and cost shows 0; the page says "≈ 0 · baseline flow exceeds capacity, result not reliable"
  //   flags.substitutes: all three D ≥ 0 but D(A+B) < D(A) + D(B) (two worksites on one corridor substitute for each other, overlapping adds no delay)
  //     → cost shows 0, still reliable
  //   reading failures (flags.failed > 0, same basis as compare / advise) → also reliable = false.
  const wsOf = x => (x && Array.isArray(x.worksites) ? x.worksites[0] : x);
  const dn = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  function overlapOf(a, b) {
    if (!a.time || !b.time || !overlaps(a, b)) return { from: null, to: null, days: 0, hours: null };
    const from = a.time.from > b.time.from ? a.time.from : b.time.from, to = a.time.to < b.time.to ? a.time.to : b.time.to;
    const [a0, a1] = a.time.hours || [0, 24], [b0, b1] = b.time.hours || [0, 24];
    return { from, to, days: dn(to) - dn(from) + 1, hours: [Math.max(a0, b0), Math.min(a1, b1)] };
  }
  async function prepPairs(sets, whens) {
    for (const worksites of sets) await engine.prepare({ when: whens[0], worksites }, { whens });
  }
  async function clash(a0, b0, opts = {}) {
    const a = wsOf(a0), b1 = wsOf(b0);
    if (!a || !b1) throw new Error('clash(a, b): a and b must each be a worksite or a plan');
    if (!opts.when && (!a.time || !b1.time)) throw new Error('clash(a, b): both worksites need a time (or pass opts.when to compute a single moment)');
    const errs = validate({ worksites: [a, b1] }); // like run / compare / advise, reject invalid worksites first instead of computing silently
    if (errs.length) throw planError(errs);
    const b = a.id === b1.id ? { ...b1, id: `${b1.id}-2` } : b1; // the engine would treat the same id as one worksite
    const ov = overlapOf(a, b);
    const whens = opts.when ? [opts.when] : ov.days ? windowWhens([{ time: { from: ov.from, to: ov.to, hours: ov.hours } }], opts.hours) : [];
    const e0 = errCount();
    let c = { a: 0, b: 0, ab: 0, cost: 0 };
    if (whens.length) {
      await prepPairs([[a], [b], [a, b]], whens);
      c = engine.conflict(a, b, { whens });
    }
    const raw = { a: c.a, b: c.b, ab: c.ab, cost: c.cost };
    const negDelay = [raw.a, raw.b, raw.ab].some(x => x < 0);
    const substitutes = !negDelay && raw.cost < 0;
    const failed = errCount() - e0;
    return {
      a: Math.max(0, raw.a), b: Math.max(0, raw.b), ab: Math.max(0, raw.ab), cost: negDelay ? 0 : Math.max(0, raw.cost), raw,
      whens: whens.length, hours: [...new Set(whens.map(w => w.hour))], truncated: Boolean(whens.truncated),
      overlap: { from: ov.from, to: ov.to, days: ov.days },
      flags: { reliable: !negDelay && !failed, negative_delay: negDelay, substitutes, reading_src: engine.calib.src, failed },
    };
  }

  // one-click stagger: shift b later by 1…maxDays days (with back: true each step also tries the same shift earlier, in the order +1, −1, +2, −2 …),
  // re-running clash() at each step; stop at the first that "no longer overlaps" or has "clash cost = 0 and a reliable result". Same input, same result.
  // best: reliable attempts rank above unreliable ones (an unreliable one is clamped to 0 and must not pass as "cleared"); among equally reliable ones the lowest clash cost, then the earliest tried.
  // best.ab / period: network total delay D(A+B) before and after the shift over the same period (earliest start to latest finish of a, b and the shifted b × sampled hours),
  //   so both numbers use the same yardstick: b's own delay just moves to other days, and the saving is mainly the clash cost.
  async function stagger(a0, b0, { maxDays = 7, hours, back = false } = {}) {
    const a = wsOf(a0), b = wsOf(b0);
    if (!a?.time || !b?.time) throw new Error('stagger(a, b): both worksites need a time');
    const base = await clash(a, b, { hours });
    const order = [];
    for (let d = 1; d <= maxDays; d++) { order.push(d); if (back) order.push(-d); }
    const tries = [];
    let best = null;
    for (const days of order) {
      const r = await clash(a, shiftWorksite(b, days), { hours });
      tries.push({ days, cost: r.cost, overlap_days: r.overlap.days, reliable: r.flags.reliable });
      const cand = { days, cost: r.cost, overlap_days: r.overlap.days, reliable: r.flags.reliable };
      if (!best || (cand.reliable && !best.reliable) || (cand.reliable === best.reliable && cand.cost < best.cost)) best = cand;
      if (!r.overlap.days || (r.cost === 0 && r.flags.reliable)) break;
    }
    if (!best) return { base, best: null, tries, period: null };
    const b2 = shiftWorksite(b, best.days);
    const W = windowWhens([a, b, b2], hours);
    const e0 = errCount();
    await prepPairs([[a, b], [a, b2]], W);
    const before = engine.window([a, b], W).delay_min, after = engine.window([a, b2], W).delay_min;
    const failed = errCount() - e0;
    best.ab = Math.max(0, after);
    return {
      base, best, tries, worksite: b2,
      period: { from: W[0]?.date ?? null, to: W[W.length - 1]?.date ?? null, whens: W.length, truncated: Boolean(W.truncated),
        ab_before: Math.max(0, before), ab_after: Math.max(0, after),
        reliable: before >= 0 && after >= 0 && !failed && base.flags.reliable && best.reliable, failed },
    };
  }

  return {
    engine,
    options,
    clash, stagger,
    status: () => JSON.parse(JSON.stringify({ ...status, calib: engine.calib, params_used: engine.params.used })),
    run, compare, advise, check: checkPlan, validate,
    pedsReady: () => pedsP, // resolves when pedestrian data has finished loading (success or not) → status().peds: fetched / given / none
    // AI call log: aiLog() → every reader call this session (chronological, at most AI_LOG_MAX); onAiLog(fn) calls fn(record) for each new one and returns an unsubscribe function
    aiLog: () => jclone(aiLog),
    onAiLog: fn => { if (typeof fn !== 'function') return () => {}; aiSubs.add(fn); return () => aiSubs.delete(fn); },
    readingsOf, lastReadings: () => readingsOf(lastRun),
    demo: demoPlan, demos: DEMO_NAMES,
  };
}
