// Plan explanation: reads the numbers the engine computed for each plan and writes pros, cons, the hardest-hit group, risks, and which plan it leans towards and why. Shared by the browser and the Worker
// Principle (D-0929-1310, "the LLM suggests, the engine computes"): every number in an explanation must come from the engine (allowedNumbers); any sentence with an invented number or a number in words (hasWordNumber) is dropped;
//   it only gives a lean, never the decision: the person responsible chooses the plan (the fixed decide sentence is always in the response)
// Rule-based version (src: "rule", deterministic, free) + LLM version (D-0929-2307, serverExplain() in the Worker's src/llm.js: src "llm" / cached "kv"),
//   with the same request / response format; LLM text and cached explanations always go through sanitizeExplain() first, otherwise the rule-based version + note
// 🔒 label must not contain < > (the web page builds templates with innerHTML); unknown fields are dropped

export const EXPLAIN_LIMITS = { options: 5, label: 60, item: 200, items: 6, max: 1e8 };
export const GROUPS = ["commuter", "local", "tourist", "delivery", "transit", "pedestrian"];
export const LANGS = ["zh", "en"];

export class ExplainError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "ExplainError";
    this.code = code;
  }
}
const bad = (code, msg) => new ExplainError(code, msg);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// Lower-is-better metrics used for pros, cons and totals. detour_share is not one (more detouring is not necessarily bad); it only feeds risks
const METRICS = [
  { key: "delay_veh_min", name: { zh: "全网延误", en: "network delay" }, unit: { zh: "车·分钟", en: "vehicle-min" } },
  { key: "queue_m", name: { zh: "排队", en: "queue" }, unit: { zh: "米", en: "m" } },
  { key: "mean_delay_s", name: { zh: "每车多等", en: "extra wait per car" }, unit: { zh: "秒", en: "s" } },
  { key: "transit_pax_min", name: { zh: "电车公交乘客延误", en: "tram & bus passenger delay" }, unit: { zh: "人·分钟", en: "passenger-min" } },
  { key: "peds_extra_min", name: { zh: "行人多花的时间", en: "extra walking time" }, unit: { zh: "人·分钟", en: "person-min" } },
  { key: "hire_aud", name: { zh: "设备租金", en: "equipment hire" }, unit: { zh: "澳元", en: "AUD" } },
  { key: "days", name: { zh: "工期", en: "duration" }, unit: { zh: "天", en: "days" } },
];
const EXTRA = ["detour_share", "transit_blocked_pax_h", "peds_blocked_h", "blocked_vph"];
const METRIC_KEYS = [...METRICS.map((m) => m.key), ...EXTRA];
const GROUP_NAME = {
  zh: { commuter: "通勤司机", local: "本地司机", tourist: "游客", delivery: "送货司机", transit: "电车公交乘客", pedestrian: "行人" },
  en: { commuter: "commuters", local: "local drivers", tourist: "visitors", delivery: "delivery drivers", transit: "tram & bus passengers", pedestrian: "pedestrians" },
};

function num(x, where, max = EXPLAIN_LIMITS.max) {
  if (x === undefined || x === null) return null;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max) throw bad("bad_number", `${where} must be a number from 0 to ${max} (omit it or use null if unknown)`);
  return x;
}

function label(x, where) {
  if (typeof x !== "string") throw bad("bad_label", `${where} must be a string`);
  const t = x.replace(/\s+/g, " ").trim();
  if (!t || t.length > EXPLAIN_LIMITS.label) throw bad("bad_label", `${where} must be 1–${EXPLAIN_LIMITS.label} characters`);
  if (/[<>\u0000-\u001f\u007f]/.test(t)) throw bad("bad_text", `${where} must not contain < > or control characters`);
  return t;
}

// Request → normalised request; throws ExplainError if invalid; unknown fields are dropped
export function normalizeExplainRequest(req) {
  if (!isObj(req)) throw bad("bad_request", "the request must be an object");
  const lang = req.lang === undefined || req.lang === null ? "en" : req.lang;
  if (!LANGS.includes(lang)) throw bad("bad_lang", `lang must be one of ${LANGS.join(" / ")}`);
  if (!Array.isArray(req.options) || req.options.length < 1 || req.options.length > EXPLAIN_LIMITS.options) {
    throw bad("bad_options", `options must hold 1–${EXPLAIN_LIMITS.options} plans`);
  }
  const ids = new Set();
  const options = req.options.map((o, i) => {
    const at = `options[${i}]`;
    if (!isObj(o)) throw bad("bad_options", `${at} must be an object`);
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw bad("bad_options", `${at}.id must be 1–32 letters, digits, _ or -`);
    if (ids.has(o.id)) throw bad("bad_options", `${at}.id "${o.id}" is a duplicate`);
    ids.add(o.id);
    const m = isObj(o.metrics) ? o.metrics : {};
    const metrics = {};
    for (const k of METRIC_KEYS) {
      const v = num(m[k], `${at}.metrics.${k}`, k === "detour_share" ? 1 : EXPLAIN_LIMITS.max);
      if (v !== null) metrics[k] = v;
    }
    const pc = isObj(o.per_capita_min) ? o.per_capita_min : {};
    const per_capita_min = {};
    for (const g of GROUPS) {
      const v = num(pc[g], `${at}.per_capita_min.${g}`, 1e4);
      if (v !== null) per_capita_min[g] = v;
    }
    const f = isObj(o.flags) ? o.flags : {};
    return {
      id: o.id,
      label: label(o.label, `${at}.label`),
      metrics,
      per_capita_min,
      flags: { params_assumed: f.params_assumed === true, reading_rules: f.reading_rules === true },
    };
  });
  return { lang, options };
}

// ---- Numbers: the rule-based version uses only request numbers and per-plan totals; LLM text is checked against the same set ----

const commas = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const fmtInt = (n) => commas(String(Math.round(n)));
const fmt1 = (n) => String(Math.round(n * 10) / 10);
const fmtMetric = (k, v) => (k === "detour_share" ? `${Math.round(v * 100)}%` : k === "mean_delay_s" || k === "queue_m" || v >= 100 ? fmtInt(v) : fmt1(v));

// Total = vehicle-minutes + passenger-minutes + pedestrian-minutes (added as is, not weighted by occupancy, which why states); no total without network delay
export function totalOf(o) {
  const m = o.metrics;
  if (m.delay_veh_min === undefined) return null;
  return m.delay_veh_min + (m.transit_pax_min || 0) + (m.peds_extra_min || 0);
}

// Numbers allowed in an explanation: every number in the request (including in labels) and each plan's total, plus their whole-number, one-decimal and percentage forms
export function allowedNumbers(req) {
  const out = new Set();
  const add = (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    for (const x of [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100)]) out.add(String(x));
  };
  add(req.options.length);
  for (const o of req.options) {
    for (const v of Object.values(o.metrics)) add(v);
    for (const v of Object.values(o.per_capita_min)) add(v);
    add(totalOf(o));
    for (const t of [...(o.label.match(/\d+(?:\.\d+)?/g) || []), ...numbersIn(o.label)]) out.add(t);
  }
  return out;
}

// Numbers in a text (thousands commas removed). NFKC first, so full-width digits ３００ are checked as 300; a thousands separator must be a comma + exactly 3 digits,
//   so that after NFKC turns the full-width Chinese comma into "," the text "10493，918" is not read as one number
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)|\d+(?:\.\d+)?/g;
export const numbersIn = (text) => (String(text).normalize("NFKC").match(NUM_RE) || []).map((t) => t.replace(/,/g, ""));
const traceable = (text, allowed) => numbersIn(text).every((n) => allowed.has(n) || allowed.has(String(Number(n))));

// A number written in words (anything other than Arabic digits) always counts as untraceable: 两倍, 一半, 三成, 三分之一, 九十米, 七百澳元, twice, half, ninety, seven hundred...
// Conservative keyword rules: better to drop a good sentence (e.g. 每一辆车, "double the queue") than let one through; plan labels are cut out before checking.
// Gaps: a single Chinese numeral with no unit (缩短约九), and a difference that happens to equal another allowed number (1200−600=600); only the prompt covers these (README, known issues)
const ZH_DIGIT = "零〇一二两三四五六七八九十";
const WORD_NUM = [
  new RegExp(`[${ZH_DIGIT}][十百千万亿]|十[一二三四五六七八九]`), // 九十, 三百, 一千, 十万, 十一 (but not 千万 or 万一)
  /[一二两三四五六七八九十几数半][倍成]|分之|一半|减半|翻倍|翻番/, // multiples, tenths, fractions
  new RegExp(`[${ZH_DIGIT}百千万]+(?:个百分点|米|秒|分钟|小时|澳元|元|辆|人|天|公里)`), // 三天, 九十米, 一辆 (numeral + unit)
  /\b(?:twice|thrice|half|halves|halved|halving|halve|doubles?(?![-\s]check)|doubled|doubling|triples?|tripled|tripling|quadruple[sd]?|(?:two|three|four|five|six|seven|eight|nine|ten|many|several)-?fold|hundreds?|thousands?|millions?|dozens?)\b/i,
  /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i,
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+(?:minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|metres?|meters?|kilometres?|kilometers?|km|m|dollars?|aud|vehicles?|cars?|people|persons?|passengers?|pedestrians?|trams?|buses|percent|per\s?cent|times)\b/i,
  /\btimes\s+(?:as|more|less|longer|shorter|higher|lower|larger|smaller|bigger|greater|worse|better)\b/i,
];
export function hasWordNumber(text, labels = []) {
  let t = String(text).normalize("NFKC");
  for (const l of labels) if (l) t = t.split(l).join(" ");
  return WORD_NUM.some((re) => re.test(t));
}

// ---- Rule-based explanation: deterministic and traceable; src: "rule" ----

export function ruleExplain(input) {
  const req = normalizeExplainRequest(input);
  const L = req.lang;
  const zh = L === "zh";
  const g = GROUP_NAME[L];
  const many = req.options.length > 1;
  const show = (m, v) => `${m.name[L]} ${fmtMetric(m.key, v)} ${m.unit[L]}`;

  const range = {};
  for (const m of METRICS) {
    const vs = req.options.map((o) => o.metrics[m.key]).filter((v) => v !== undefined);
    if (vs.length === req.options.length && Math.max(...vs) > Math.min(...vs)) range[m.key] = [Math.min(...vs), Math.max(...vs)];
  }

  const options = req.options.map((o) => {
    const m = o.metrics;
    const parts = METRICS.filter((x) => ["delay_veh_min", "queue_m", "mean_delay_s", "transit_pax_min"].includes(x.key) && m[x.key] !== undefined).map((x) => show(x, m[x.key]));
    const summary = !parts.length ? o.label : zh ? `${o.label}：${parts.join("，")}。` : `${o.label}: ${parts.join(", ")}.`;
    const pros = [];
    const cons = [];
    if (many) {
      for (const x of METRICS) {
        const r = range[x.key];
        if (!r) continue;
        if (m[x.key] === r[0]) pros.push(zh ? `${x.name.zh}最少（${fmtMetric(x.key, m[x.key])} ${x.unit.zh}）` : `Lowest ${x.name.en} (${fmtMetric(x.key, m[x.key])} ${x.unit.en})`);
        if (m[x.key] === r[1]) cons.push(zh ? `${x.name.zh}最多（${fmtMetric(x.key, m[x.key])} ${x.unit.zh}）` : `Highest ${x.name.en} (${fmtMetric(x.key, m[x.key])} ${x.unit.en})`);
      }
    }
    const groups = Object.entries(o.per_capita_min).filter(([, v]) => v > 0);
    const worst = groups.length ? groups.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
    const hardest_hit = worst ? { group: worst[0], min: Math.round(worst[1] * 10) / 10, text: zh ? `${g[worst[0]]}每人多花 ${fmt1(worst[1])} 分钟，受影响最大` : `${cap(g[worst[0]])} lose the most: ${fmt1(worst[1])} min each` } : null;
    const risks = [];
    if (m.transit_blocked_pax_h > 0) risks.push(zh ? `有电车 / 公交停运，每小时约 ${fmtInt(m.transit_blocked_pax_h)} 名乘客受影响` : `Trams or buses stop running: about ${fmtInt(m.transit_blocked_pax_h)} passengers an hour affected`);
    if (m.peds_blocked_h > 0) risks.push(zh ? `有行人无路可绕，每小时约 ${fmtInt(m.peds_blocked_h)} 人` : `Some pedestrians have no way around: about ${fmtInt(m.peds_blocked_h)} an hour`);
    if (m.blocked_vph > 0) risks.push(zh ? `全封后有车无路可绕，每小时约 ${fmtInt(m.blocked_vph)} 辆` : `After full closure some traffic has no detour: about ${fmtInt(m.blocked_vph)} vehicles an hour`);
    if (m.detour_share > 0.5) risks.push(zh ? `${fmtMetric("detour_share", m.detour_share)} 的车要绕行，绕行路线本身可能也会堵` : `${fmtMetric("detour_share", m.detour_share)} of drivers detour, so the detour itself may clog`);
    if (o.flags.params_assumed) risks.push(zh ? "部分参数是假设值，数字看区间" : "Some inputs are assumptions; read the numbers as ranges");
    if (o.flags.reading_rules) risks.push(zh ? "路人怎么读屏是关键词规则估算的" : "How drivers read the signs is a keyword-rule estimate");
    return { id: o.id, summary, pros, cons, hardest_hit, risks };
  });

  let lean = null;
  const totals = req.options.map((o) => ({ o, t: totalOf(o) })).filter((x) => x.t !== null);
  if (many && totals.length === req.options.length) {
    const best = totals.reduce((a, b) => (b.t < a.t ? b : a));
    if (totals.some((x) => x.t > best.t)) {
      const risky = options.find((x) => x.id === best.o.id).risks.length > 0;
      const cheaper = range.hire_aud && best.o.metrics.hire_aud !== range.hire_aud[0];
      const why = zh
        ? `把车·分钟、乘客·分钟、行人·分钟直接相加（没按载客人数换算），「${best.o.label}」合计最少（${fmtInt(best.t)}）。${cheaper ? "但它的租金不是最低。" : ""}${risky ? "注意它的风险提示。" : ""}`
        : `Adding vehicle-, passenger- and pedestrian-minutes as they are (not weighted by occupancy), "${best.o.label}" has the lowest total (${fmtInt(best.t)}).${cheaper ? " It is not the cheapest to hire, though." : ""}${risky ? " Check its risks." : ""}`;
      lean = { option: best.o.id, why };
    }
  }

  return {
    src: "rule",
    lang: L,
    options,
    lean,
    decide: zh ? "AI 只给参考，不替人拍板：选哪套由负责人决定，并写下理由。" : "This is advice only. The person responsible chooses the plan and records why.",
  };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- External explanations (LLM, cache, API responses) are untrusted: a bad shape voids the whole thing (returns null, the caller uses the rule-based version); sentences with untraceable or word numbers are dropped ----
// Only three metadata fields pass (short, letters, digits and a little punctuation only): model, prompt_v (LLM version), note (fallback reason code, e.g. llm_fallback: timeout)
const META = ["model", "prompt_v", "note"];
const META_RE = /^[A-Za-z0-9 ._:/,()-]{1,120}$/;

// chk = { allowed: allowedNumbers(req), labels: plan labels (NFKC, longest first) }
const cleanItem = (x, chk) => {
  if (typeof x !== "string") return null;
  const t = x.replace(/\s+/g, " ").trim().slice(0, EXPLAIN_LIMITS.item);
  if (!t || /[<>]/.test(t) || !traceable(t, chk.allowed) || hasWordNumber(t, chk.labels)) return null;
  return t;
};
const cleanList = (xs, chk) => (Array.isArray(xs) ? xs.map((x) => cleanItem(x, chk)).filter(Boolean).slice(0, EXPLAIN_LIMITS.items) : []);

export function sanitizeExplain(raw, input, src) {
  const req = normalizeExplainRequest(input);
  if (!isObj(raw) || !Array.isArray(raw.options)) return null;
  const chk = { allowed: allowedNumbers(req), labels: req.options.map((o) => o.label.normalize("NFKC")).sort((a, b) => b.length - a.length) };
  const byId = new Map(raw.options.filter(isObj).map((o) => [o.id, o]));
  if (!req.options.every((o) => byId.has(o.id))) return null;
  const rule = ruleExplain(req);
  const options = req.options.map((o, i) => {
    const r = byId.get(o.id);
    return {
      id: o.id,
      summary: cleanItem(r.summary, chk) || rule.options[i].summary,
      pros: cleanList(r.pros, chk),
      cons: cleanList(r.cons, chk),
      hardest_hit: rule.options[i].hardest_hit, // the hardest-hit group comes from engine numbers, never from outside
      risks: [...new Set([...rule.options[i].risks, ...cleanList(r.risks, chk)])].slice(0, EXPLAIN_LIMITS.items),
    };
  });
  let lean = null;
  if (isObj(raw.lean) && req.options.some((o) => o.id === raw.lean.option)) {
    const why = cleanItem(raw.lean.why, chk);
    if (why) lean = { option: raw.lean.option, why };
  }
  const out = { src, lang: req.lang, options, lean, decide: rule.decide };
  for (const k of META) if (typeof raw[k] === "string" && META_RE.test(raw[k])) out[k] = raw[k];
  return out;
}

// ---- Browser side: engine result → one plan; POST /api/explain, and run the rule-based version in the browser if the API is unreachable ----

// A be.run() result (summarize() in apps/engine/public/js/backend.js) → one plan in the request. extra: { hire_aud, days }
export function optionFromRun(id, name, s, extra = {}) {
  const t = s?.transit?.src ? s.transit : null;
  const p = s?.peds?.src ? s.peds : null;
  const per = {};
  for (const k of ["commuter", "local", "tourist", "delivery"]) if (s?.by_type?.[k]) per[k] = s.by_type[k].per_capita_min;
  if (t && t.pax_h > 0 && t.pax_min !== null) per.transit = t.pax_min / t.pax_h;
  if (p && p.ped_h > 0) per.pedestrian = p.extra_min / p.ped_h;
  const metrics = {
    delay_veh_min: s?.delay_min,
    queue_m: s?.queue_m,
    mean_delay_s: s?.mean_delay_s,
    detour_share: s?.detour_share,
    transit_pax_min: t ? t.pax_min : undefined,
    transit_blocked_pax_h: t ? t.blocked_pax_h : undefined,
    peds_extra_min: p ? p.extra_min : undefined,
    peds_blocked_h: p ? p.blocked_ped_h : undefined,
    blocked_vph: s?.blocked_vph,
    hire_aud: extra.hire_aud,
    days: extra.days,
  };
  for (const k of Object.keys(metrics)) if (typeof metrics[k] !== "number" || !Number.isFinite(metrics[k]) || metrics[k] < 0) delete metrics[k];
  return {
    id,
    label: name,
    metrics,
    per_capita_min: per,
    flags: { params_assumed: s?.flags?.params !== "params", reading_rules: s?.flags?.reading_src === "rule" },
  };
}

// → explanation; opts: { fetch, apiBase, timeoutMs }. An invalid request throws ExplainError (a caller bug); if the API is unreachable, the local rule-based version (src: "rule")
// src as given by the API (llm / kv / rule), anything else becomes "api"; waits 25 s by default: the Worker waits at most 20 s for the LLM (EXPLAIN_TIMEOUT_MS) and then answers with the rule-based version itself
const API_SRC = ["llm", "kv", "rule"];
export async function explainOptions(input, opts = {}) {
  const req = normalizeExplainRequest(input);
  const f = opts.fetch || globalThis.fetch;
  if (typeof f === "function") {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs ?? 25_000) : null;
    try {
      const r = await f(`${opts.apiBase || ""}/api/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: ctl?.signal });
      const b = await r.json().catch(() => null);
      const clean = r.ok && b?.ok ? sanitizeExplain(b.explain, req, API_SRC.includes(b.explain?.src) ? b.explain.src : "api") : null;
      if (clean) return clean;
    } catch {
      // offline, timed out, or the site has no api binding: use the rule-based version below
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return ruleExplain(req);
}
