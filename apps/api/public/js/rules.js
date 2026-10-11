// Keyword rules: the fallback when the LLM is unavailable, and the answer when MOCK=1. One copy shared by the browser and the Worker
// Reads the sign text only and never computes route shares (D-0929-1435); same input, same output; src is always "rule"
// Rule table: docs/hackathon/specs/T5-PRD.md (keyword rules); all numeric constants are below, so update tests/rules.test.mjs when changing them
import { normalizeRequest, signMessage, countWords } from "./signs.js";

export const RULE_V = "k1";

// ---- notice: estimated from readable seconds and word count; more words or fewer seconds give a lower value ----
const SEC_PER_WORD = 1; // about 1 s per word of unfamiliar text (the usual lower bound in VMS design)
const FRAME_SWITCH_S = 1; // two alternating frames add one frame switch
const NOTICE_MAX = 0.95;

// ---- understand: the rules differ by persona only for non-standard abbreviations; other persona differences are engine parameters ----
const UNDERSTAND_BASE = 0.9;
const UNDERSTAND_MIN = 0.2;
const ABBREV_PENALTY = { commuter: 0.05, local: 0.03, tourist: 0.15, delivery: 0.03 }; // penalty per non-standard abbreviation
const ABBREV_MAX = 3; // count at most 3

// ---- trust: not persona-specific in the rules (trust in signs is an engine persona parameter); slightly higher when the sign gives minutes ----
const TRUST_BASE = 0.7;
const TRUST_NUMBER_BONUS = 0.1;

const USE_WORDS = new Set(["USE", "VIA", "TAKE", "TRY"]);
const AVOID_WORDS = new Set(["AVOID"]);
const CLOSED_WORDS = new Set(["CLOSED", "BLOCKED"]);
const JOIN_WORDS = new Set(["OR", "AND", "&", "/"]);

// Road-suffix spellings (a VMS line has only 10 characters, so suffixes are often abbreviated or dropped: LA TROBE ST does not fit)
const SUFFIX = [
  ["ST", "STREET"], ["RD", "ROAD"], ["AVE", "AVENUE", "AV"], ["PDE", "PARADE"], ["HWY", "HIGHWAY"],
  ["FWY", "FREEWAY"], ["BLVD", "BOULEVARD"], ["DR", "DRIVE"], ["LN", "LANE"], ["PL", "PLACE"],
  ["CRES", "CRESCENT"], ["TCE", "TERRACE"], ["CT", "COURT"], ["GR", "GROVE"], ["SQ", "SQUARE"],
];
const SUFFIX_OF = new Map(SUFFIX.flatMap((g) => g.map((s) => [s, g])));

// Abbreviations common on Australian signs that most people recognise; a vowel-less word not listed here counts as non-standard
const STANDARD = new Set([
  ...SUFFIX.flat(), "CBD", "KM", "KMH", "KPH", "MIN", "MINS", "HR", "HRS", "AM", "PM", "NB", "SB", "EB", "WB",
  "NTH", "STH", "MT", "TV", "VMS", "PTV",
]);
// Abbreviations with vowels that ordinary drivers (especially visitors) may not recognise
const NONSTANDARD = new Set([
  "WKS", "AHD", "DLY", "DLYS", "TFC", "TRFC", "CLSD", "ALT", "RTE", "DET", "DETR", "ACC", "INC", "LNS", "RHT", "LFT",
  "BTWN", "XING", "CONST", "CONSTR", "EXP", "EXPT", "MAINT", "EVT", "EVNT", "PKG", "PED", "PEDS", "CYC", "DIV", "DIVN",
  "SPD", "LMT", "RDWKS", "RDWRKS", "WRKS", "INFO", "GOVT", "ENTR", "EXT", "OPP",
]);

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- road-name matching

// Each road → the spellings that may appear on a sign (split into words). If one suffix-less spelling matches two roads (Flinders St / Flinders Ln), it is discarded
export function roadAliases(roads) {
  const byAlias = new Map();
  const add = (alias, road) => {
    const k = alias.join(" ");
    if (!byAlias.has(k)) byAlias.set(k, road);
    else if (byAlias.get(k) !== road) byAlias.set(k, null); // ambiguous: ignore
  };
  for (const road of roads) {
    const toks = road.toUpperCase().replace(/[.']/g, "").split(" ").filter(Boolean);
    const last = toks[toks.length - 1];
    const group = SUFFIX_OF.get(last);
    const stems = [toks];
    if (group && toks.length > 1) stems.push(toks.slice(0, -1));
    for (const stem of stems) {
      const full = stem === toks;
      const variants = full && group ? group.map((s) => [...toks.slice(0, -1), s]) : [stem];
      for (const v of variants) {
        add(v, road);
        if (v.length > 1 && !full) add([v.join("")], road); // LA TROBE → LATROBE
        if (full && v.length > 2) add([v.slice(0, -1).join(""), v[v.length - 1]], road); // LATROBE ST
      }
    }
  }
  const list = [...byAlias].filter(([, r]) => r).map(([k, road]) => ({ toks: k.split(" "), road }));
  return list.sort((a, b) => b.toks.length - a.toks.length); // longest match first
}

// Split a message into words and roads: [{ w: "USE" }, { road: "Russell St" }, ...]
function tokenize(message, aliases) {
  const toks = message.split(" ").map((t) => t.replace(/[.,:!?]+$/, "").replace(/['.]/g, "")).filter(Boolean); // A'BECKETT → ABECKETT
  const items = [];
  for (let i = 0; i < toks.length; ) {
    const hit = aliases.find((a) => a.toks.every((t, j) => toks[i + j] === t));
    if (hit) {
      items.push({ road: hit.road });
      i += hit.toks.length;
    } else {
      items.push({ w: toks[i] });
      i += 1;
    }
  }
  return items;
}

// Collect roads starting at items[i]: X, X OR Y, X / Y
function roadsFrom(items, i) {
  const out = [];
  while (items[i]?.road) {
    out.push(items[i].road);
    if (JOIN_WORDS.has(items[i + 1]?.w) && items[i + 2]?.road) i += 2;
    else break;
  }
  return out;
}

// ---------------------------------------------------------------- reading fields

function adviceOf(messages, aliases) {
  const use = new Set();
  const avoid = new Set();
  for (const m of messages) {
    const items = tokenize(m, aliases);
    items.forEach((it, i) => {
      if (USE_WORDS.has(it.w)) roadsFrom(items, i + 1).forEach((r) => use.add(r));
      if (AVOID_WORDS.has(it.w)) roadsFrom(items, i + 1).forEach((r) => avoid.add(r));
      if (it.road && CLOSED_WORDS.has(items[i + 1]?.w)) avoid.add(it.road);
    });
  }
  const advice = {};
  for (const r of use) advice[r] = "use";
  for (const r of avoid) advice[r] = "avoid"; // told both to use and to avoid the same road: avoid wins (conservative)
  return advice;
}

// N MIN, N-M MIN (take the upper bound); with several signs, take the largest
const NUM = String.raw`(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:MIN|MINS|MINUTES)\b`;
const SAVING_RE = [new RegExp(String.raw`\bSAVES?\s+(?:UP\s+TO\s+)?` + NUM, "g")];
const DELAY_RE = [
  new RegExp(String.raw`\b` + NUM + String.raw`\s+(?:DELAYS?|DLYS?)\b`, "g"),
  new RegExp(String.raw`\b(?:DELAYS?|DLYS?)\s+(?:OF\s+|UP\s+TO\s+)?` + NUM, "g"),
  new RegExp(String.raw`\bALLOW\s+(?:AN\s+)?(?:EXTRA\s+)?` + NUM, "g"),
];

function minutesOf(messages, patterns) {
  let best = null;
  for (const m of messages) {
    for (const re of patterns) {
      for (const hit of m.matchAll(re)) {
        const n = Number(hit[2] ?? hit[1]);
        if (best === null || n > best) best = n;
      }
    }
  }
  return best;
}

function noticeOf(signs) {
  let miss = 1;
  for (const s of signs) {
    const words = Math.max(1, countWords(signMessage(s)));
    const frames = s.kind === "vms" ? s.frames.length : 1;
    const need = words * SEC_PER_WORD + (frames - 1) * FRAME_SWITCH_S;
    const ratio = s.read_s / need;
    miss *= 1 - (NOTICE_MAX * ratio) / (ratio + 0.5);
  }
  return Math.min(NOTICE_MAX, 1 - miss); // notices at least one of the signs
}

export function oddAbbreviations(messages, roads) {
  const roadWords = new Set(roads.flatMap((r) => r.toUpperCase().split(" ")));
  const odd = new Set();
  for (const m of messages) {
    for (const w of m.split(" ")) {
      const t = w.replace(/[.,:!?()]/g, "");
      if (!/^[A-Z]{2,}$/.test(t) || STANDARD.has(t) || roadWords.has(t)) continue;
      if (NONSTANDARD.has(t) || !/[AEIOUY]/.test(t)) odd.add(t);
    }
  }
  return [...odd];
}

function whyOf({ advice, saving, delay, odd, empty }) {
  if (empty) return "No sign to read";
  const use = Object.keys(advice).filter((r) => advice[r] === "use");
  const avoid = Object.keys(advice).filter((r) => advice[r] === "avoid");
  const parts = [];
  if (use.length) parts.push(`use ${use.join(" or ")}`);
  if (avoid.length) parts.push(`avoid ${avoid.join(" and ")}`);
  if (saving !== null) parts.push(`saves ${saving} min`);
  if (delay !== null) parts.push(`${delay} min delay`);
  let why = parts.length ? `Sign says ${parts.join(", ")}` : "No route advice on the sign";
  if (odd.length) why += `; unclear abbreviations ${odd.join(" ")}`;
  return why.slice(0, 160);
}

// ---------------------------------------------------------------- entry point

// Request (raw or already normalised) → reading. Throws SignError if invalid
export function ruleReading(request) {
  const req = normalizeRequest(request);
  const messages = req.signs.map(signMessage);
  const empty = messages.length === 0;
  const aliases = roadAliases(req.roads);
  const advice = adviceOf(messages, aliases);
  const saving = minutesOf(messages, SAVING_RE);
  const delay = minutesOf(messages, DELAY_RE);
  const odd = oddAbbreviations(messages, req.roads);
  const nOdd = Math.min(ABBREV_MAX, odd.length);
  return {
    persona: req.persona,
    notice: empty ? 0 : r2(noticeOf(req.signs)),
    understand: empty ? 0 : r2(clamp(UNDERSTAND_BASE - ABBREV_PENALTY[req.persona] * nOdd, UNDERSTAND_MIN, 1)),
    advice,
    saving_min: saving,
    delay_min: delay,
    trust: empty ? 0 : r2(clamp(TRUST_BASE + (saving !== null || delay !== null ? TRUST_NUMBER_BONUS : 0), 0, 1)),
    why: whyOf({ advice, saving, delay, odd, empty }),
    src: "rule",
    model: "rules",
    prompt_v: RULE_V,
  };
}
