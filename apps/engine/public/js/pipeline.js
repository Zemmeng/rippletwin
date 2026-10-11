// pipeline.js — the engine core's entry point (D-0929-1435): createEngine({ network, flows, readSigns }) →
//   await engine.prepare(plan)                fetch every reading needed first (injected readSigns, async; each wording asked once per persona, cached for good)
//   engine.evaluate(plan, { seed })           synchronous, pure computation: same input (plan + cached readings) gives the same result, safe to re-run
//   engine.window(worksites, whens)           total delay over a period; engine.conflict(a, b): step 6 clash cost
// plan = { when: { date, hour, day? }, worksites: [worksite] }; format in docs/reference/interfaces.md (Worksite plan, Engine API).
// Steps 1–2 routes.js / reading.js, step 4 choice.js + calibrate.js, step 5 assign.js.
// As queues grow the engine re-runs route choice on the visible queue itself (method of successive averages, MSA) without asking the LLM again (readings depend only on text + persona).

import { loadNetwork, isNet } from './net.js';
import { isActive, capFactors, overlaps, windowWhens, dayType } from './worksite.js';
import { affected } from './routes.js';
import { round1, cleanName } from './cards.js';
import { canon } from './canon.js';
import { TYPES, DEFAULT_AB, chooseShares, informed } from './choice.js';
import { calibrate, anchorRequest } from './calibrate.js';
import { applyParams, isApplied } from './params.js';
import { requestsFor, requestKey } from './reading.js';
import { evaluate as assign, pathNow, maxQueue } from './assign.js';

export const MSA_ITERS = 6; // queue-feedback iterations (successive averages)
export const OCCUPANCY = 1; // 1 person per vehicle (the core counts car drivers only; tram and bus riders are modelled separately in transit.js)

const r3 = x => Math.round(x * 1000) / 1000;

// params: the result of loadParams() / applyParams() (or raw params.json content); omitted = all assumed values;
// explicitly passed personas / mix take precedence over params
export function createEngine({ network, flows, readSigns, params, personas, mix } = {}) {
  const P = isApplied(params) ? params : applyParams(params ?? null);
  personas = personas || P.personas;
  mix = mix || P.mix;
  const anchors = P.anchors;
  const paramsInfo = {
    src: P.used.src, version: P.used.version,
    used: { mix: P.used.mix, anchors: P.used.anchors, persona: P.used.persona },
    ignored: P.used.ignored, errors: P.used.errors,
    override: [personas !== P.personas && 'personas', mix !== P.mix && 'mix'].filter(Boolean),
  };
  const net = isNet(network) ? network : loadNetwork(network);
  const readings = new Map(); // requestKey → reading
  const structCache = new Map();
  const baseCache = new Map();
  let calib = { ...DEFAULT_AB, method: 'default', ok: false };

  const get = req => (req ? readings.get(requestKey(req)) : undefined);

  function structure(ws, factors) {
    const closed = [...factors].filter(([, x]) => x.f === 0).map(([id]) => id).sort();
    const k = canon([ws.id, ws.links, ws.closes, closed]);
    if (!structCache.has(k)) structCache.set(k, affected(net, null, ws, { date: '2000-01-03', hour: 0 }, factors));
    return structCache.get(k);
  }

  function base(when) {
    const k = dayType(when) + ':' + when.hour;
    if (!baseCache.has(k)) baseCache.set(k, assign(net, flows, when, [], []));
    return baseCache.get(k);
  }

  function approachesAt(plan) {
    const active = (plan.worksites || []).filter(ws => isActive(ws, plan.when));
    const factors = capFactors(net, active);
    const dt = dayType(plan.when);
    const aps = active.flatMap(ws => structure(ws, factors).map(ap => ({
      ws,
      ap: { ...ap, volume: flows?.days?.[dt]?.[ap.entry]?.[plan.when.hour] ?? 0 },
    })));
    return { active, aps };
  }

  // for one approach and persona: what the signs say (a named road counts only on signs visible before the turn) + the persuaded share
  function signFor(t, ap, reqs) {
    const full = get(reqs.full[t]);
    const street = cleanName(ap.street);
    const use = new Set(), avoid = new Set();
    for (const r of ap.alts) {
      const pre = get(reqs.prefix[t][r.id]);
      const a = pre?.advice?.[cleanName(r.name)];
      if (a === 'use') use.add(r.id);
      if (a === 'avoid') avoid.add(r.id);
    }
    if (full?.advice?.[street] === 'avoid') avoid.add('stay');
    return {
      sign: { use, avoid, saving_min: use.size ? full?.saving_min || 0 : 0, delay_min: full?.delay_min || 0 },
      I: informed(personas[t], full),
      reading: full || null,
    };
  }

  function missingFor(plan, out) {
    const { aps } = approachesAt(plan);
    for (const { ap, ws } of aps) {
      const reqs = requestsFor(ap, ws, TYPES);
      for (const t of TYPES) {
        for (const req of [reqs.full[t], ...Object.values(reqs.prefix[t])]) {
          if (req && !readings.has(requestKey(req))) out.set(requestKey(req), req);
        }
      }
    }
    return out;
  }

  async function prepare(plan, { whens } = {}) {
    const need = new Map();
    for (const which of ['lo', 'hi']) for (const t of TYPES) {
      const req = anchorRequest(which, t);
      if (!readings.has(requestKey(req))) need.set(requestKey(req), req);
    }
    for (const when of [plan.when, ...(whens || [])].filter(Boolean)) missingFor({ ...plan, when }, need);
    if (need.size && typeof readSigns !== 'function') throw new Error('prepare needs readSigns (in the browser pass readSigns from apps/api reader.js; otherwise pass mockReadSigns)');
    const got = await Promise.all([...need].map(async ([k, req]) => {
      try { return [k, await readSigns(req)]; } catch { return [k, null]; }
    }));
    for (const [k, r] of got) if (r) readings.set(k, r);
    const pick = which => Object.fromEntries(TYPES.map(t => [t, readings.get(requestKey(anchorRequest(which, t)))]));
    calib = calibrate(pick('lo'), pick('hi'), { personas, mix, anchors });
    return { asked: need.size, failed: got.filter(([, r]) => !r).length, calib: { ...calib } };
  }

  function overall(byT) {
    const o = {};
    for (const t of TYPES) for (const [id, v] of Object.entries(byT[t])) o[id] = (o[id] || 0) + (mix[t] || 0) * v;
    return o;
  }

  // seed: there is no randomness yet; kept because the interface requires same input → same result
  function evaluate(plan, { seed = 0 } = {}) { // eslint-disable-line no-unused-vars
    const when = plan.when;
    const b = base(when);
    const { active, aps } = approachesAt(plan);
    const missing = missingFor(plan, new Map()).size;
    if (!active.length) {
      return { when, delay_min: 0, tt_base_min: round1(b.tt_s / 60), blocked_vph: 0, by_type: {}, others_min: 0, approaches: [], hot: [], links: [],
        active: [], calib: { ...calib }, missing };
    }

    const ctx = aps.map(({ ap, ws }) => {
      const reqs = requestsFor(ap, ws, TYPES);
      const routes = [ap.stay, ...ap.alts].filter(Boolean);
      const per = Object.fromEntries(TYPES.map(t => [t, signFor(t, ap, reqs)]));
      return { ap, ws, reqs, routes, per };
    });

    // queue feedback: visible queue → choice → assignment → new queue …, averaging the shares over iterations (MSA)
    let q = ctx.map(() => 0);
    let avg = ctx.map(() => null);
    let ev = b;
    for (let k = 1; k <= MSA_ITERS; k++) {
      avg = ctx.map((c, i) => {
        if (!c.ap.alts.length) return null;
        const byT = {};
        for (const t of TYPES) {
          const { sign, I } = c.per[t];
          const s = chooseShares(personas[t], c.routes, sign, { A: calib.A, B: calib.B, I, queue_m: q[i] });
          const a = avg[i]?.[t];
          byT[t] = a ? Object.fromEntries(Object.keys(s).map(id => [id, a[id] + (s[id] - a[id]) / k])) : s;
        }
        return byT;
      });
      const splits = ctx.map((c, i) => ({ ap: c.ap, share: avg[i] ? overall(avg[i]) : { stay: 1 } }));
      ev = assign(net, flows, when, active, splits);
      q = ctx.map(c => maxQueue(ev, c.ap.chain) / 2); // the queue drivers see on average ≈ half the end-of-hour queue
    }

    const typeTot = Object.fromEntries(TYPES.map(t => [t, { delay_min: 0, vehicles: 0 }]));
    let credit = 0; // veh·s: the "time saved" on detours that are usually faster than the stay route, added back to total delay (see below)
    const approaches = ctx.map((c, i) => {
      const F = ev.used?.[i] ?? c.ap.volume;
      const stayBase = c.ap.stayLinks.reduce((s, id) => s + b.links.get(id).t, 0);
      const byT = avg[i] || Object.fromEntries(TYPES.map(t => [t, { stay: 1 }]));
      const share = overall(byT);
      // A detour can be faster than the stay route in normal conditions (a 20 km/h side street vs a 40 km/h parallel street; flows.json is counts, not an equilibrium): if drivers do not normally
      // take it, the stay route has benefits the engine does not model (origin or destination on this street, parking, deliveries). Extra time is measured from the faster of
      // "stay route / this detour, in normal conditions" → a closure never makes diverted vehicles save time (a full closure of Little Bourke St alone used to give −65 veh·min)
      const routes = c.routes.map(r => {
        const now = pathNow(ev, r.links);
        const floor = Math.min(stayBase, pathNow(b, r.links));
        return { id: r.id, name: r.name, usual_min: round1(r.usual_min), now_min: round1(now / 60), share: r3(share[r.id] || 0),
          flow: Math.round((share[r.id] || 0) * F), truck: r.truck, turn_m: r.id === 'stay' ? null : Math.round(r.diverge_m), extra_min: (now - floor) / 60, gain_s: stayBase - floor };
      });
      credit += F * routes.reduce((s, r) => s + (share[r.id] || 0) * r.gain_s, 0);
      const extraOf = sh => routes.reduce((s, r) => s + (sh[r.id] || 0) * r.extra_min, 0);
      const by_type = {};
      for (const t of TYPES) {
        const sh = byT[t];
        const ex = extraOf(sh);
        const veh = F * (mix[t] || 0);
        typeTot[t].delay_min += veh * ex * OCCUPANCY;
        typeTot[t].vehicles += veh;
        const R = c.per[t].reading;
        by_type[t] = {
          share: Object.fromEntries(Object.entries(sh).map(([k, v]) => [k, r3(v)])),
          detour: r3(1 - (sh.stay ?? 0)),
          extra_min: round1(ex),
          informed: r3(c.per[t].I),
          told: [...c.per[t].sign.use].map(id => c.routes.find(r => r.id === id)?.name),
          reading: R ? { notice: R.notice, understand: R.understand, trust: R.trust, advice: R.advice, saving_min: R.saving_min, delay_min: R.delay_min, why: R.why, src: R.src } : null,
        };
      }
      return {
        worksite: c.ws.id, entry: c.ap.entry, street: c.ap.street, dir: c.ap.dir, to: c.ap.to, volume: Math.round(F), blocked: c.ap.blocked,
        queue_m: Math.round(maxQueue(ev, c.ap.chain)), delay_min: Math.round(F * extraOf(share)),
        share: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, r3(v)])),
        routes: routes.map(({ gain_s, ...r }) => ({ ...r, extra_min: round1(r.extra_min) })), // eslint-disable-line no-unused-vars
        by_type,
        signs: c.reqs.signs.map(s => ({ m: s.m, kind: s.kind, read_s: s.read_s, ...(s.frames ? { frames: s.frames } : { text: s.text }) })),
      };
    });

    const links = [];
    const hot = [];
    for (const [id, x] of ev.links) {
      const l = net.links.get(id), bx = b.links.get(id);
      // extra_min: extra veh·min on this link versus the same hour with no works, can be < 0 (vehicles diverted away). delay_s is versus free flow,
      // so it is large on streets that are congested at peak anyway (Flinders / King St); the page draws "slowdown caused by the works" from extra_min
      const extra = (x.v * x.t - bx.v * bx.t) / 60;
      links.push({ id, v: Math.round(x.v), cap: Math.round(x.cap), delay_s: round1(x.t - l.t0_s), queue_m: Math.round(x.queue_m), extra_min: round1(extra) });
      if (extra > 0.5) hot.push({ id, name: l.name, extra_min: Math.round(extra), v: Math.round(x.v), cap: Math.round(x.cap), queue_m: Math.round(x.queue_m) });
    }
    hot.sort((a, z) => z.extra_min - a.extra_min);
    const delay = Math.round((ev.tt_s - b.tt_s + credit) / 60);
    const by_type = {};
    let typed = 0;
    for (const t of TYPES) {
      const x = typeTot[t];
      typed += x.delay_min;
      by_type[t] = { delay_min: Math.round(x.delay_min), vehicles: Math.round(x.vehicles), per_capita_min: x.vehicles ? round1(x.delay_min / x.vehicles) : 0 };
    }
    return {
      when, delay_min: delay, tt_base_min: round1(b.tt_s / 60), blocked_vph: Math.round(ev.blocked_vph),
      by_type, others_min: Math.round(delay - typed), // background traffic not on the works approach but slowed by diverted traffic
      approaches, hot: hot.slice(0, 5), links, active: active.map(w => w.id), calib: { ...calib }, missing,
    };
  }

  function window(worksites, whens) {
    let total = 0;
    const per = [];
    for (const when of whens) { const r = evaluate({ when, worksites }); total += r.delay_min; per.push({ when, delay_min: r.delay_min }); }
    return { delay_min: total, per };
  }

  // step 6: clash cost = D(A+B) − D(A) − D(B). If the times never overlap, only one is active at any moment, so it is exactly 0
  function conflict(a, b, { whens, hours } = {}) {
    const W = whens || windowWhens([a, b], hours);
    const A = window([a], W), B = window([b], W), AB = window([a, b], W);
    return { a: A.delay_min, b: B.delay_min, ab: AB.delay_min, cost: AB.delay_min - A.delay_min - B.delay_min, overlap: overlaps(a, b), whens: W.length, truncated: Boolean(W.truncated) };
  }

  return { net, flows, prepare, evaluate, window, conflict, readings, get calib() { return { ...calib }; }, get params() { return JSON.parse(JSON.stringify({ ...paramsInfo, mix, personas, anchors })); } };
}
