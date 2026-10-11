// The engine calls only this function: readSigns(request) → Promise<reading> (docs/reference/interfaces.md, road-user reading)
// In order: the answers file shipped with the site → POST /api/read (the Worker checks KV, then asks the LLM) → keyword rules (src: "rule")
// An invalid request throws SignError straight away: that is a caller bug and is not hidden behind the rules
import { normalizeRequest, canonical, sha256Hex, sanitizeReading } from "./signs.js";
import { ruleReading } from "./rules.js";

export { SignError } from "./signs.js";

const DEFAULTS = {
  answersUrl: new URL("../answers/demo.json", import.meta.url).href,
  apiBase: "", // empty for same-origin deployment; pass http://localhost:<port> for a separately run local Worker
  timeoutMs: 8000,
};

const memo = new Map(); // hash of the canonical request → Promise<reading>: one fetch per message and persona per session
const answerFiles = new Map(); // answersUrl → Promise<{ [key]: { reading } }>

// For tests or a "read again" action in the UI
export function resetReader() {
  memo.clear();
  answerFiles.clear();
}

// Answers-file key: SHA-256 of the canonical string (persona + normalised signs + sorted roads)
export const answerKey = (req) => sha256Hex(canonical(normalizeRequest(req)));

// opts: { fetch, apiBase, answersUrl, timeoutMs }; tests inject fetch
export async function readSigns(request, opts = {}) {
  const req = normalizeRequest(request);
  const o = { ...DEFAULTS, ...opts };
  const key = await sha256Hex(canonical(req));
  if (!memo.has(key)) memo.set(key, resolve(req, key, o));
  return structuredClone(await memo.get(key));
}

async function resolve(req, key, o) {
  const f = o.fetch || globalThis.fetch;
  if (typeof f === "function") {
    const fromFile = await fileReading(req, key, o, f);
    if (fromFile) return fromFile;
    const fromApi = await apiReading(req, o, f);
    if (fromApi) return fromApi;
  }
  return ruleReading(req);
}

async function fileReading(req, key, o, f) {
  try {
    if (!answerFiles.has(o.answersUrl)) answerFiles.set(o.answersUrl, loadAnswers(o.answersUrl, f));
    const answers = await answerFiles.get(o.answersUrl);
    const entry = answers[key];
    return entry ? sanitizeReading(entry.reading, req, "file") : null;
  } catch {
    return null;
  }
}

async function loadAnswers(url, f) {
  try {
    const res = await f(url);
    if (!res.ok) return {};
    const body = await res.json();
    return body && typeof body.answers === "object" && body.answers ? body.answers : {};
  } catch {
    return {};
  }
}

async function apiReading(req, o, f) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs) : null;
  try {
    const res = await f(`${o.apiBase}/api/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: ctl?.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const r = body?.reading;
    const src = ["kv", "llm", "rule"].includes(r?.src) ? r.src : null;
    return src ? sanitizeReading(r, req, src) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
