// reading.js — step 2 produces the "reading requests" of D-0929-1435: the engine hands the signs each persona passes to the injected readSigns()
// (apps/api reader.js), which returns only a reading (noticed, understood, which road to use / avoid, minutes saved or delay quoted, trust); format in docs/reference/interfaces.md (Sign reading).
// Each persona needs two kinds of request per approach:
//   full   — every sign on this approach (in driving order): sets the persuaded share and any advice about the stay route
//   prefix — the signs visible before a detour's turn (sign.m ≥ turn_m): a sign only names a road if it comes before the turn
// A request depends only on "text + persona" (no travel times or queues), so each wording is asked once per persona and the cache stays valid.

import { canon } from './canon.js';
import { readSeconds, cleanName } from './cards.js';

export function signsOn(ap, ws) {
  return (ws.equipment || [])
    // at_m < 0 = downstream of the works start (e.g. END ROADWORK at the end of the works): too late to divert, so not sent for reading and not counted in the 6-sign limit
    .filter(e => (e.type === 'vms' || e.type === 'sign' || e.type === 'arrow') && (!e.dir || e.dir === ap.dir) && (Number(e.at_m) || 0) >= 0)
    .map(e => ({ m: Number(e.at_m) || 0, kind: e.type, ...(e.type === 'vms' ? { frames: e.frames } : { text: e.text }), read_s: readSeconds(ap.kmh, e.type === 'vms' ? e.char_mm : 200) }))
    .sort((a, b) => b.m - a.m)
    .slice(-6); // the reader accepts at most 6 signs per request: keep the 6 nearest the works
}

export function request(persona, ap, signs) {
  return {
    persona,
    kmh: ap.kmh,
    signs: signs.map(({ m, ...s }) => s), // a reading depends only on text + persona: positions stay inside the engine
    roads: [ap.street, ...ap.alts.map(r => r.name)].map(cleanName),
  };
}

export const requestKey = req => canon(req);

// every request an approach needs: { full: {persona: req}, prefix: {persona: {routeId: req | null}} }
export function requestsFor(ap, ws, types) {
  const signs = signsOn(ap, ws);
  const out = { signs, full: {}, prefix: {} };
  for (const t of types) {
    out.full[t] = signs.length ? request(t, ap, signs) : null;
    out.prefix[t] = {};
    for (const r of ap.alts) {
      const seen = signs.filter(s => s.m >= (r.diverge_m ?? 0));
      out.prefix[t][r.id] = seen.length ? request(t, ap, seen) : null;
    }
  }
  return out;
}

// ---------- Mock reader: keyword rules used as the fallback and in tests (matches keywords only, no real understanding; the UI labels it an estimate) ----------
const NOTICE = { commuter: 0.85, local: 0.55, tourist: 0.8, delivery: 0.8 };
const UNDERSTAND = { commuter: 0.9, local: 0.9, tourist: 0.75, delivery: 0.9 };
const TRUST = { commuter: 0.8, local: 0.5, tourist: 0.9, delivery: 0.7 };
const NONSTD = new Set(['RD', 'WKS', 'AHD', 'LN', 'CLSD', 'DET', 'ALT', 'RTE', 'XING', 'CONG', 'DLY']);

const words = s => (s.frames ? s.frames.flat() : [s.text || '']).join(' ').toUpperCase().split(/\s+/).filter(Boolean);

export async function mockReadSigns(req) {
  const toks = req.signs.flatMap(words);
  const readF = Math.max(0, ...req.signs.map(s => Math.min(1, (s.read_s ?? 4) / 4)));
  const nonstd = toks.some(t => NONSTD.has(t));
  const road = w => req.roads.find(r => r.toUpperCase().split(' ')[0] === w);
  const advice = {};
  for (let i = 0; i < toks.length - 1; i++) {
    const r = road(toks[i + 1]);
    if (!r) continue;
    if (toks[i] === 'USE' || toks[i] === 'VIA') advice[r] = 'use';
    if (toks[i] === 'AVOID') advice[r] = 'avoid';
  }
  const text = toks.join(' ');
  const save = /\bSAVE\s+(\d{1,2})\s*MIN/.exec(text);
  const delay = /\b(\d{1,2})\s*MIN\s+DELAY/.exec(text);
  const p = req.persona;
  return {
    persona: p,
    notice: +(NOTICE[p] * readF).toFixed(3),
    understand: +(UNDERSTAND[p] * (nonstd ? (p === 'tourist' ? 0.45 : 0.9) : 1)).toFixed(3),
    advice,
    saving_min: save ? Number(save[1]) : null,
    delay_min: delay ? Number(delay[1]) : null,
    trust: TRUST[p],
    why: Object.keys(advice).length ? `Sign says ${Object.entries(advice).map(([k, v]) => `${v} ${k}`).join(', ')}.` : 'Sign only warns of roadwork.',
    src: 'rule',
    model: 'engine-mock',
    prompt_v: '-',
  };
}
