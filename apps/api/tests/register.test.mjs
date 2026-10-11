// Worksite register server side: /api/worksites* in worker.js + the WorksiteRegister Durable Object (fake storage, run directly in Node)
// Negative assertions: edit_token is returned only at creation, and no GET returns the token or its hash; seed worksites cannot be edited; the entry cap and daily write cap hold
// Usage: node tests/register.test.mjs; no npm install needed
import { ok, eq, sec, done } from "./mini.mjs";
import worker from "../src/worker.js";
import { WorksiteRegister } from "../src/register.js";
import { sha256Hex } from "../public/js/signs.js";
import { WS_LIMITS } from "../public/js/worksites.js";

// Fake DO namespace: in-memory storage (get / put / list shaped like workerd's, deep-copying on every read and write)
function fakeRegister(clock = () => Date.parse("2026-09-30T00:00:00Z")) {
  const store = new Map();
  const storage = {
    async get(k) {
      return structuredClone(store.get(k));
    },
    async put(k, v) {
      store.set(k, structuredClone(v));
    },
    async list({ prefix }) {
      return new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
    },
  };
  const obj = new WorksiteRegister({ storage }, {}, clock);
  const ns = { idFromName: (n) => n, get: () => ({ fetch: (u, init) => obj.fetch(new Request(u, init)) }) };
  return { store, ns };
}

const WS = {
  title: "Collins St water main",
  kind: "utility",
  links: ["l595594354_9756035316"],
  closes: { lanes: 1, footpath: "left" },
  time: { from: "2026-10-12", to: "2026-10-14", hours: [9, 15] },
  equipment: [{ id: "VMS-1", type: "vms", at_m: 200, frames: [["USE", "RUSSELL ST"]] }],
};

const call = (env, path, { method = "GET", body, token, raw } = {}) => {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-edit-token"] = token;
  return worker.fetch(new Request(`https://site.test${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
};
const j = async (r) => ({ status: r.status, b: await r.json() });

await sec("REGISTER unbound: read-only seed worksites, the page still works", async () => {
  const env = {};
  const h = await j(await call(env, "/api/health"));
  eq(h.b.register, false, "/api/health reports register:false");
  const l = await j(await call(env, "/api/worksites"));
  eq([l.status, l.b.register, l.b.n, l.b.worksites.map((w) => w.id)], [200, "seed", 3, ["W-LATROBE", "W-LONSDALE", "W-LTLBOURKE"]], "GET returns the 3 seeds (sorted by start date, then id)");
  const p = await j(await call(env, "/api/worksites", { method: "POST", body: WS }));
  eq([p.status, p.b.error], [503, "no_register"], "POST → 503 no_register");
  const one = await j(await call(env, "/api/worksites/W-LONSDALE"));
  eq([one.status, one.b.worksite.seed], [200, true], "GET one seed worksite");
});

await sec("create → read → update (with token)", async () => {
  let now = Date.parse("2026-09-30T01:00:00Z");
  const { store, ns } = fakeRegister(() => now);
  const env = { REGISTER: ns };
  eq((await j(await call(env, "/api/health"))).b.register, true, "/api/health reports register:true");

  const c = await j(await call(env, "/api/worksites", { method: "POST", body: { ...WS, email: "someone@example.com", id: "W-LONSDALE", seed: true } }));
  eq(c.status, 201, "POST → 201");
  const { worksite: w, edit_token: token } = c.b;
  ok(/^W-[2-9A-HJ-NP-Z]{6}$/.test(w.id), `the server issues the id (the client's W-LONSDALE is ignored): ${w.id}`);
  ok(/^[0-9a-f]{32}$/.test(token), "edit_token is 32 hex characters");
  eq([w.seed, w.created, w.updated, w.status], [false, "2026-09-30T01:00:00.000Z", "2026-09-30T01:00:00.000Z", "draft"], "seed:false · server timestamps");
  ok(!("email" in w), "negative: the email is neither stored nor returned");

  const rec = store.get(`ws:${w.id}`);
  eq(rec.th, await sha256Hex(token), "storage holds the SHA-256 of the token");
  ok(!JSON.stringify(rec).includes(token), "negative: storage does not hold the plain token");

  const l = await call(env, "/api/worksites");
  const lt = await l.text();
  const lb = JSON.parse(lt);
  eq([lb.register, lb.n], ["do", 4], "list = 3 seeds + 1 new entry");
  const one = await call(env, `/api/worksites/${w.id}`);
  const ot = await one.text();
  for (const [name, t] of [["list", lt], ["single entry", ot]]) {
    ok(!t.includes(token) && !t.includes(rec.th) && !/"th"/.test(t), `negative: the ${name} has no token, no hash and no th field`);
  }

  const noTok = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", body: { status: "assessed" } }));
  eq([noTok.status, noTok.b.error], [403, "bad_token"], "no token → 403");
  const wrong = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", body: { status: "assessed" }, token: "0".repeat(32) }));
  eq([wrong.status, wrong.b.error], [403, "bad_token"], "wrong token → 403");
  eq(store.get(`ws:${w.id}`).ws.status, "draft", "negative: a rejected change is not stored");

  now = Date.parse("2026-09-30T02:00:00Z");
  const good = await j(await call(env, `/api/worksites/${w.id}`, {
    method: "PATCH", token,
    body: { status: "decided", decision: { option: "o2", by: "council", reason: "least tram delay", at: "1999-01-01T00:00:00Z" } },
  }));
  eq([good.status, good.b.worksite.status, good.b.worksite.decision.option], [200, "decided", "o2"], "correct token → 200, decision recorded");
  ok(good.b.worksite.decision.at !== "1999-01-01T00:00:00Z" && /^\d{4}-\d{2}-\d{2}T/.test(good.b.worksite.decision.at), "decision.at is stamped by the server, not taken from the client");
  eq([good.b.worksite.created, good.b.worksite.updated], ["2026-09-30T01:00:00.000Z", "2026-09-30T02:00:00.000Z"], "created unchanged · updated refreshed");
  const keepAt = good.b.worksite.decision.at;
  const again = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", token, body: { title: "Collins St water main (stage 1)" } }));
  eq([again.b.worksite.title, again.b.worksite.decision.at], ["Collins St water main (stage 1)", keepAt], "the original decision time is kept when the decision is not changed");
  ok(!JSON.stringify(again.b).includes(token), "negative: no token in the PATCH response either");

  const bad = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", token, body: { links: [] } }));
  eq([bad.status, bad.b.error], [400, "bad_links"], "an invalid change → 400 code");
  const empty = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", token, body: {} }));
  eq([empty.status, empty.b.error], [400, "bad_patch"], "empty PATCH → 400 bad_patch");

  const c2 = await j(await call(env, "/api/worksites", { method: "POST", body: WS }));
  ok(c2.b.worksite.id !== w.id && c2.b.edit_token !== token, "a second entry: different id and token");
  const cross = await j(await call(env, `/api/worksites/${w.id}`, { method: "PATCH", token: c2.b.edit_token, body: { status: "withdrawn" } }));
  eq([cross.status, cross.b.error], [403, "bad_token"], "negative: another entry's token cannot edit this one");
});

await sec("seed worksites cannot be edited", async () => {
  const { ns } = fakeRegister();
  const env = { REGISTER: ns };
  const r = await j(await call(env, "/api/worksites/W-LONSDALE", { method: "PATCH", token: "a".repeat(32), body: { status: "withdrawn" } }));
  eq([r.status, r.b.error], [403, "locked"], "PATCH a seed → 403 locked");
  const l = await j(await call(env, "/api/worksites"));
  eq(l.b.worksites.find((w) => w.id === "W-LONSDALE").status, "draft", "unchanged");
});

await sec("queries, errors and methods", async () => {
  const { ns } = fakeRegister();
  const env = { REGISTER: ns };
  await call(env, "/api/worksites", { method: "POST", body: WS });
  eq((await j(await call(env, "/api/worksites?from=2026-10-10"))).b.worksites.map((w) => w.title), ["Little Bourke St closure on the Russell St detour", "Collins St water main"], "from filter: works still running after 10-10");
  eq((await j(await call(env, "/api/worksites?status=decided"))).b.n, 0, "status filter");
  const q = await j(await call(env, "/api/worksites?from=tomorrow"));
  eq([q.status, q.b.error], [400, "bad_query"], "bad query parameter → 400");
  const nf = await j(await call(env, "/api/worksites/W-NOPE12"));
  eq([nf.status, nf.b.error], [404, "not_found"], "no such entry → 404");
  eq((await call(env, "/api/worksites/..%2F..%2Fhealth")).status, 404, "odd characters in the id → 404");
  eq((await call(env, "/api/worksites/a/b")).status, 404, "an extra path segment → 404");
  eq((await j(await call(env, "/api/worksites", { method: "DELETE" }))).status, 405, "DELETE on the list → 405");
  eq((await j(await call(env, "/api/worksites/W-LONSDALE", { method: "DELETE" }))).status, 405, "DELETE on an entry → 405 (no delete; set status to withdrawn instead)");
  const bj = await j(await call(env, "/api/worksites", { method: "POST", raw: "{nope" }));
  eq([bj.status, bj.b.error], [400, "bad_json"], "bad JSON → 400");
  const big = await j(await call(env, "/api/worksites", { method: "POST", raw: JSON.stringify({ ...WS, title: "x".repeat(20000) }) }));
  eq([big.status, big.b.error], [413, "too_large"], "body over 16 KB → 413");
  const inv = await j(await call(env, "/api/worksites", { method: "POST", body: { ...WS, title: "<b>hi</b>" } }));
  eq([inv.status, inv.b.error], [400, "bad_text"], "negative: a title with < > → 400");
});

await sec("caps: full register 409 · daily write cap 429 · counter resets after 00:00 UTC", async () => {
  const { store, ns } = fakeRegister(() => Date.parse("2026-09-30T05:00:00Z"));
  const env = { REGISTER: ns };
  for (let i = 0; i < WS_LIMITS.entries; i++) store.set(`ws:W-FILL${String(i).padStart(3, "0")}`, { ws: { id: `W-FILL${i}` }, th: "x" });
  const full = await j(await call(env, "/api/worksites", { method: "POST", body: WS }));
  eq([full.status, full.b.error], [409, "full"], `${WS_LIMITS.entries} entries → 409 full`);

  const b = fakeRegister(() => Date.parse("2026-09-30T05:00:00Z"));
  b.store.set("writes", { day: "2026-09-30", n: WS_LIMITS.writesPerDay });
  const cap = await j(await call({ REGISTER: b.ns }, "/api/worksites", { method: "POST", body: WS }));
  eq([cap.status, cap.b.error], [429, "daily_cap"], `${WS_LIMITS.writesPerDay} writes today → 429`);
  b.store.set("writes", { day: "2026-09-29", n: WS_LIMITS.writesPerDay });
  eq((await call({ REGISTER: b.ns }, "/api/worksites", { method: "POST", body: WS })).status, 201, "yesterday's count does not apply");
  eq(b.store.get("writes"), { day: "2026-09-30", n: 1 }, "the counter is a single record");
});

await sec("DO error: GET falls back to the seeds, writes answer 503", async () => {
  const env = { REGISTER: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("boom"); } }) } };
  const l = await j(await call(env, "/api/worksites"));
  eq([l.status, l.b.register, l.b.n], [200, "seed", 3], "GET still returns the seeds");
  const p = await j(await call(env, "/api/worksites", { method: "POST", body: WS }));
  eq([p.status, p.b.error], [503, "register_error"], "POST → 503, the error text is not passed through");
  ok(!JSON.stringify(p.b).includes("boom"), "negative: internal error text never leaves");
});

done();
