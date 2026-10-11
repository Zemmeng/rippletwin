// Deployment config: key items in wrangler.jsonc / package.json / the lockfile / .dev.vars.example (the api Worker must be deployable by deploy.sh and bindable by site)
// Usage: node tests/config.test.mjs; no npm install needed
import { readFileSync } from "node:fs";
import { ok, eq, sec, done } from "./mini.mjs";
import { parseJsonc } from "../tools/jsonc.mjs";
import * as entry from "../src/worker.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

await sec("wrangler.jsonc", () => {
  const w = parseJsonc(read("wrangler.jsonc"));
  eq([w.name, w.main], ["hackathon-api", "src/worker.js"], "Worker name hackathon-api (the site service binding uses this name)");
  eq([w.assets?.directory, w.assets?.binding], ["public", "ASSETS"], "static assets in public/, binding ASSETS");
  ok(["0", "1"].includes(w.vars?.MOCK), `vars.MOCK is the string "0" or "1" (currently ${JSON.stringify(w.vars?.MOCK)}; the Worker treats only "0" as off)`);
  ok(/^https:\/\//.test(w.vars?.LLM_BASE_URL || ""), `LLM_BASE_URL is https: ${w.vars?.LLM_BASE_URL}`);
  ok(typeof w.vars?.LLM_MODEL === "string" && w.vars.LLM_MODEL.length > 0, `LLM_MODEL = ${w.vars?.LLM_MODEL}`);
  const secretish = Object.keys(w.vars || {}).filter((k) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k));
  eq(secretish, [], "negative: no key / secret / token in vars (the key goes only through wrangler secret put)");
  ok(!("services" in w), "api binds no other Worker (only site binds it)");
  eq(w.workers_dev, false, "no hackathon-api.*.workers.dev: site is the only public entry point (the service binding does not need it)");
  for (const k of ["LLM_MAX_CALLS_PER_MIN", "LLM_MAX_CALLS_PER_DAY"]) {
    ok(/^[0-9]+$/.test(w.vars?.[k] ?? ""), `vars.${k} is an integer string (currently ${JSON.stringify(w.vars?.[k])})`);
  }
});

await sec("Durable Object BUDGET: the global counter for the daily LLM cap", () => {
  const w = parseJsonc(read("wrangler.jsonc"));
  const b = (w.durable_objects?.bindings || []).find((x) => x.name === "BUDGET");
  eq(b?.class_name, "LlmBudget", "binding BUDGET → class LlmBudget (src/llm.js uses env.BUDGET)");
  const sqlite = (w.migrations || []).flatMap((m) => m.new_sqlite_classes || []);
  ok(sqlite.includes("LlmBudget"), "migrations use new_sqlite_classes (the free plan only allows SQLite-backed DOs)");
  ok(!(w.migrations || []).some((m) => (m.new_classes || []).includes("LlmBudget")), "negative: not new_classes (KV-backed DOs cannot be deployed on the free plan)");
  eq(typeof entry.LlmBudget, "function", "the entry src/worker.js exports LlmBudget (workerd looks classes up by name)");
});

await sec("Durable Object REGISTER: the worksite register", () => {
  const w = parseJsonc(read("wrangler.jsonc"));
  const b = (w.durable_objects?.bindings || []).find((x) => x.name === "REGISTER");
  eq(b?.class_name, "WorksiteRegister", "binding REGISTER → class WorksiteRegister (src/register.js uses env.REGISTER)");
  eq((w.migrations || []).map((m) => m.tag), ["v1", "v2"], "migrations are append-only: v1 → v2");
  eq(w.migrations[0], { tag: "v1", new_sqlite_classes: ["LlmBudget"] }, "negative: the deployed v1 is unchanged (changing it makes deploy fail with a migration error)");
  eq(w.migrations[1], { tag: "v2", new_sqlite_classes: ["WorksiteRegister"] }, "v2 adds WorksiteRegister with new_sqlite_classes");
  eq(typeof entry.WorksiteRegister, "function", "the entry src/worker.js exports WorksiteRegister");
});

await sec("tests/workerd.test.mjs is hermetic: ignores MOCK in wrangler.jsonc and any key in a local .dev.vars", () => {
  const t = read("tests/workerd.test.mjs");
  ok(/const OFF = \{ MOCK: "1", LLM_API_KEY: "" \}/.test(t), "the default Worker forces MOCK=1 and an empty key via vars (the check stays green and spends nothing even with MOCK=0 in wrangler.jsonc)");
  ok(/\bvars,\s*\n\s*persist: false/.test(t), "unstable_dev with a vars override and persist:false (DO counters are not saved to disk)");
  ok(/LLM_BASE_URL: `http:\/\/127\.0\.0\.1:/.test(t), "the Worker with the LLM on talks only to the in-process fake provider");
});

await sec("package.json + lockfile: deployable by deploy.sh", () => {
  const pkg = JSON.parse(read("package.json"));
  eq(pkg.scripts?.deploy, "wrangler deploy", "has a deploy script (deploy.sh runs npm run deploy)");
  const lock = JSON.parse(read("package-lock.json"));
  ok(/^4\./.test(lock.packages?.["node_modules/wrangler"]?.version || ""), `the lockfile has wrangler 4.x (deploy.sh installs from it with npm ci): ${lock.packages?.["node_modules/wrangler"]?.version}`);
  eq(lock.packages?.[""]?.devDependencies, pkg.devDependencies, "lockfile and package.json dependencies match (otherwise npm ci fails)");
});

await sec(".dev.vars.example: variable names and placeholder values only", () => {
  const ex = read(".dev.vars.example");
  for (const k of ["MOCK", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) ok(new RegExp(`^${k}=`, "m").test(ex), `lists ${k}`);
  eq(ex.match(/^LLM_API_KEY=(.*)$/m)?.[1], "", "negative: the LLM_API_KEY value is empty");
  eq(ex.match(/^MOCK=(.*)$/m)?.[1], "1", "the example defaults to MOCK=1 (copying it spends nothing)");
});

done();
