// Sign-text spec + request normalisation + reading validation + cache key. One copy shared by the browser (reader.js) and the Worker (src/worker.js)
// Spec sources: RPM Hire VMS product page (4 lines × 10 characters per frame), WA VMS guideline §1.4 and §7.4; see docs/hackathon/specs/T5-PRD.md
// Interface: docs/reference/interfaces.md (road-user reading)

export const PERSONAS = ["commuter", "local", "tourist", "delivery"];

export const LIMITS = {
  frames: 2, // at most 2 VMS frames
  lines: 4, // at most 4 lines per frame
  chars: 10, // at most 10 characters per line
  words: 8, // at most 8 words across all frames of one sign; static signs also allow 8 words
  signChars: 40, // a static sign / arrow board message is at most 40 characters (RIGHT LANE CLOSED is 17)
  signs: 8, // at most 8 signs per request
  roads: 8, // current road + candidate detours, at most 8
  roadChars: 40,
  readS: 120, // readable seconds: larger values are capped at 120 (the engine yields 100+ s in a 5 km/h queue); only negatives are rejected
  kmh: 130,
};

// Sign text allows only capitals, digits, spaces and common punctuation; no < >, so nobody can forge the tag the prompt wraps sign text in
const SIGN_CHARS = /^[A-Z0-9 .,'&:!?()+/-]*$/;
// Road names use the same character set as the engine's cleanName() (apps/engine/public/js/cards.js); road names never go inside <sign>, so brackets and slashes are fine
const ROAD_CHARS = /^[A-Za-z0-9 .,'&/()-]+$/;

// The msg texts below are Chinese on purpose: the zh UI shows them verbatim, and the English UI maps them by code and
// extracts the quoted 「line」 (apps/web/src/js/6-engine.js checkMsg)
export class SignError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "SignError";
    this.code = code; // machine-readable code; the Worker puts it into { ok:false, error } as is
  }
}

const bad = (code, msg) => new SignError(code, msg);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const squash = (s) => s.replace(/\s+/g, " ").trim();

// One line / message of sign text: upper-case, collapse spaces, then check the character set
function signText(x, where) {
  if (typeof x !== "string") throw bad("bad_sign", `${where} 要是字符串`);
  const t = squash(x.toUpperCase());
  if (!SIGN_CHARS.test(t)) throw bad("bad_chars", `${where} 只能用大写字母、数字、空格和 . , ' & : ! ? ( ) + / -`);
  return t;
}

export const countWords = (text) => (text ? text.split(" ").length : 0);

// One sign → normalised sign; the worksite register (worksites.js) uses this to validate equipment sign text too
export function normSign(s, i) {
  const at = `signs[${i}]`;
  if (!isObj(s)) throw bad("bad_sign", `${at} 要是对象`);
  const readS = s.read_s;
  if (typeof readS !== "number" || !Number.isFinite(readS) || readS < 0) {
    throw bad("bad_read_s", `${at}.read_s 要是不小于 0 的秒数`);
  }
  const read_s = Math.round(Math.min(readS, LIMITS.readS));

  if (s.kind === "vms") {
    const fr = s.frames;
    if (!Array.isArray(fr) || fr.length < 1 || fr.length > LIMITS.frames) {
      throw bad("too_many_frames", `${at} 的 VMS 要有 1–${LIMITS.frames} 帧`);
    }
    let words = 0;
    const frames = fr.map((f, j) => {
      if (!Array.isArray(f)) throw bad("bad_sign", `${at}.frames[${j}] 要是一组行`);
      if (f.length > LIMITS.lines) throw bad("too_many_lines", `${at}.frames[${j}] 超过 ${LIMITS.lines} 行`);
      const lines = f.map((l, k) => signText(l, `${at}.frames[${j}][${k}]`)).filter(Boolean);
      for (const l of lines) {
        if (l.length > LIMITS.chars) throw bad("line_too_long", `「${l}」超过每行 ${LIMITS.chars} 个字符`);
        words += countWords(l);
      }
      if (!lines.length) throw bad("empty_frame", `${at}.frames[${j}] 没有字`);
      return lines;
    });
    if (words > LIMITS.words) throw bad("too_many_words", `${at} 合计 ${words} 个词，超过 ${LIMITS.words} 个`);
    return { kind: "vms", frames, read_s };
  }

  // An arrow board may have no text: a missing text is treated as an empty string
  if (s.kind === "sign" || s.kind === "arrow") {
    const text = signText(s.kind === "arrow" && (s.text === undefined || s.text === null) ? "" : s.text, `${at}.text`);
    if (!text && s.kind === "sign") throw bad("empty_sign", `${at}.text 没有字`);
    if (text.length > LIMITS.signChars) throw bad("line_too_long", `${at}.text 超过 ${LIMITS.signChars} 个字符`);
    if (countWords(text) > LIMITS.words) throw bad("too_many_words", `${at}.text 超过 ${LIMITS.words} 个词`);
    return { kind: s.kind, text, read_s };
  }

  throw bad("bad_kind", `${at}.kind 只能是 vms / sign / arrow`);
}

function normRoad(r, i) {
  if (typeof r !== "string") throw bad("bad_road", `roads[${i}] 要是字符串`);
  const t = squash(r);
  if (!t || t.length > LIMITS.roadChars || !ROAD_CHARS.test(t)) {
    throw bad("bad_road", `roads[${i}] 要是 1–${LIMITS.roadChars} 个字符的路名（字母、数字、空格、. , ' & / ( ) -）`);
  }
  return t;
}

// Request → normalised request; throws SignError if invalid (the Worker answers 400; in the browser it is thrown to the caller)
// Normalisation: upper-case, collapse spaces, drop empty lines, round read_s, de-duplicate roads; unknown fields are dropped
export function normalizeRequest(req) {
  if (!isObj(req)) throw bad("bad_request", "请求要是一个对象");
  if (!PERSONAS.includes(req.persona)) throw bad("bad_persona", `persona 只能是 ${PERSONAS.join(" / ")}`);
  const kmh = req.kmh;
  if (typeof kmh !== "number" || !Number.isFinite(kmh) || kmh < 0 || kmh > LIMITS.kmh) {
    throw bad("bad_kmh", `kmh 要是 0–${LIMITS.kmh} 的数`);
  }
  if (!Array.isArray(req.signs) || req.signs.length > LIMITS.signs) {
    throw bad("too_many_signs", `signs 要是数组，最多 ${LIMITS.signs} 块`);
  }
  if (!Array.isArray(req.roads) || req.roads.length > LIMITS.roads) {
    throw bad("bad_road", `roads 要是数组，最多 ${LIMITS.roads} 条`);
  }
  return {
    persona: req.persona,
    kmh: Math.round(kmh),
    signs: req.signs.map(normSign),
    roads: [...new Set(req.roads.map(normRoad))],
  };
}

// All text on one sign (frames and lines joined with spaces, in reading order)
export const signMessage = (s) => (s.kind === "vms" ? s.frames.flat().join(" ") : s.text);

// Canonical string for caching: text + persona + candidate roads only. Per the T5 spec, kmh is not in the key (read_s already reflects speed); roads are sorted, so order does not matter
export function canonical(req) {
  return JSON.stringify({ p: req.persona, s: req.signs, r: [...req.roads].sort() });
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- reading validation
// Anything from the answers file, KV or the LLM is untrusted: a bad field returns null (the caller falls back to the rules); nothing is patched up

const MAX_MIN = 240;
const WHY_MAX = 160;
const SRCS = ["file", "kv", "llm", "rule"];

const unit = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null);
const r2 = (x) => Math.round(x * 100) / 100;

function minutes(x) {
  if (x === null || x === undefined) return null;
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= MAX_MIN ? Math.round(x) : undefined;
}

function pair(x) {
  if (!Array.isArray(x) || x.length !== 2) return null;
  const [a, b] = x.map(unit);
  return a !== null && b !== null && a <= b ? [r2(a), r2(b)] : null;
}

export function cleanWhy(x) {
  if (typeof x !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return squash(x.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, WHY_MAX);
}

// raw: a reading from any source; req: the normalised request; src: where this reading actually came from
export function sanitizeReading(raw, req, src) {
  if (!isObj(raw) || !SRCS.includes(src)) return null;
  const notice = unit(raw.notice);
  const understand = unit(raw.understand);
  const trust = unit(raw.trust);
  const saving = minutes(raw.saving_min);
  const delay = minutes(raw.delay_min);
  if (notice === null || understand === null || trust === null || saving === undefined || delay === undefined) return null;

  // advice accepts only roads from the request (case-insensitive, output uses the request's spelling) and only use / avoid
  const advice = {};
  if (raw.advice !== undefined && !isObj(raw.advice)) return null;
  const byUpper = new Map(req.roads.map((r) => [r.toUpperCase(), r]));
  for (const [k, v] of Object.entries(raw.advice || {})) {
    const road = typeof k === "string" ? byUpper.get(squash(k).toUpperCase()) : undefined;
    if (road && (v === "use" || v === "avoid") && advice[road] !== "avoid") advice[road] = v;
  }

  const out = {
    persona: req.persona,
    notice: r2(notice),
    understand: r2(understand),
    advice,
    saving_min: saving,
    delay_min: delay,
    trust: r2(trust),
    why: cleanWhy(raw.why),
  };
  if (isObj(raw.range)) {
    const range = {};
    for (const k of ["notice", "understand", "trust"]) {
      const p = pair(raw.range[k]);
      if (p) range[k] = p;
    }
    if (Object.keys(range).length) out.range = range;
  }
  out.src = src;
  if (typeof raw.model === "string") out.model = raw.model.slice(0, 80);
  if (typeof raw.prompt_v === "string") out.prompt_v = raw.prompt_v.slice(0, 20);
  return out;
}
