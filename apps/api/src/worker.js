// Thin Worker router: input validation and dispatch. The keyword rules live in public/js/rules.js (shared with the browser); the LLM layer is in src/llm.js.
// GET /api/health status · POST /api/read sign reading · POST /api/explain plan explanation · /api/worksites worksite register (src/register.js) · everything else goes to the static assets in public/
// By default (MOCK is not "0", or there is no LLM_API_KEY) only the rules run and nothing is spent. To enable the LLM, see the README section "Status and re-enabling the LLM".
import { normalizeRequest, SignError } from "../public/js/signs.js";
import { ruleReading } from "../public/js/rules.js";
import { llmConfig, llmStatus, serverReading, serverExplain } from "./llm.js";
import { handleWorksites } from "./register.js";
import { normalizeExplainRequest, ruleExplain, ExplainError } from "../public/js/explain.js";
import { readLimited, json, fail } from "./http.js";

// Durable Object classes must be exported from the entry module (wrangler.jsonc durable_objects / migrations refer to them by name)
export { LlmBudget } from "./budget.js";
export { WorksiteRegister } from "./register.js";
export { readLimited };

// Can be overridden at deploy time with --var VERSION:$(git rev-parse --short HEAD)
const VERSION = "0.3.0";
const MAX_BODY = 8 * 1024; // a valid request is a few hundred bytes; 8 KB is plenty

// MOCK is off only when it is explicitly "0": an unset variable means no spending
export const isMock = (env) => env?.MOCK !== "0";

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      // llm: { mode, model, key: present or not (never the value), cache: kv / cache-api / memory (by hostname), prompt_v, explain_v, provider, budget, per_day, per_min }
      // register: whether the worksite register Durable Object is bound (unbound = only the read-only seed worksites)
      return json({ ok: true, v: env.VERSION || VERSION, mock: isMock(env), llm: llmStatus(env, url.hostname), register: hasRegister(env) });
    }

    if (path === "/api/read") {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const text = await readLimited(request, MAX_BODY);
      if (text === null) return fail(413, "too_large", `request body exceeds ${MAX_BODY} bytes`);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return fail(400, "bad_json", "request body is not valid JSON");
      }
      let req;
      try {
        req = normalizeRequest(body);
      } catch (e) {
        if (e instanceof SignError) return fail(400, e.code, e.message);
        throw e;
      }
      return json({ ok: true, reading: await read(req, env, url.origin) });
    }

    // Plan explanation: with the LLM enabled (same conditions as /api/read) ask once and pass the text through sanitizeExplain(); otherwise, or on error, use the rule-based version (D-0929-2307)
    if (path === "/api/explain") {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const text = await readLimited(request, MAX_BODY);
      if (text === null) return fail(413, "too_large", `request body exceeds ${MAX_BODY} bytes`);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return fail(400, "bad_json", "request body is not valid JSON");
      }
      let req;
      try {
        req = normalizeExplainRequest(body);
      } catch (e) {
        if (e instanceof ExplainError) return fail(400, e.code, e.message);
        throw e;
      }
      return json({ ok: true, explain: await explain(req, env, url.origin) });
    }

    if (path === "/api/worksites" || path.startsWith("/api/worksites/")) {
      const r = await handleWorksites(request, env, url);
      if (r) return r;
    }

    // Unknown /api/* paths get an explicit JSON 404 instead of going to ASSETS, so the front end never mistakes an HTML page for an API response
    if (path.startsWith("/api/")) return fail(404, "not_found", "no such endpoint");

    return env.ASSETS ? env.ASSETS.fetch(request) : fail(404, "not_found", "no static assets");
  },
};

const hasRegister = (env) => Boolean(env?.REGISTER && typeof env.REGISTER.idFromName === "function");

// req is already normalised. MOCK or no key → rules (no note);
// otherwise memory → KV / Cache API → LLM (3 samples combined) → rules if any step fails. origin: the Cache API key uses a fake same-origin URL
export async function read(req, env = {}, origin) {
  if (llmConfig(env).mode !== "llm") return ruleReading(req);
  try {
    return await serverReading(req, env, { origin });
  } catch {
    return { ...ruleReading(req), note: "llm_error" }; // never pass the error text through
  }
}

// req is already normalised (normalizeExplainRequest). MOCK or no key → rule-based version (no note);
// otherwise memory → KV / Cache API → LLM (1 call) → sanitise; if any step fails, rule-based version + note
export async function explain(req, env = {}, origin) {
  if (llmConfig(env).mode !== "llm") return ruleExplain(req);
  try {
    return await serverExplain(req, env, { origin });
  } catch {
    return { ...ruleExplain(req), note: "llm_error" }; // never pass the error text through
  }
}
