// Server side of the worksite register: the WorksiteRegister Durable Object stores worksites; worker.js hands /api/worksites* to handleWorksites()
// Why a DO: overlapping works can only affect each other if everyone sees the same list; one global instance = one ledger, with no interleaved writes (same pattern as budget.js)
// 🔒 Public endpoint with no login: anyone can register a worksite; editing needs the edit_token issued at creation (returned once; only its SHA-256 is stored). No GET ever returns a token or hash
// 🔒 Seed worksites (public/js/worksites-seed.js) are not stored and cannot be edited (403 locked); a full register gives 409; the global daily write cap gives 429
// ⚠️ No import of "cloudflare:workers": worker.js must run directly in Node for tests, and a plain class with fetch() works as a DO in workerd too
import { normalizeWorksite, applyPatch, parseQuery, selectWorksites, isSeedId, SEEDS, WS_LIMITS, ID_RE, WorksiteError } from "../public/js/worksites.js";
import { sha256Hex } from "../public/js/signs.js";
import { readLimited, json, fail } from "./http.js";

const MAX_BODY = 16 * 1024; // even 30 fully populated equipment items are only a few KB
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0 O 1 I, so IDs can be read out without confusion

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return `W-${[...b].map((x) => ID_ALPHABET[x % 32]).join("")}`;
};
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

export class WorksiteRegister {
  // clock is injected only by tests; workerd passes just (ctx, env)
  constructor(ctx, env, clock = Date.now) {
    this.ctx = ctx;
    this.clock = clock;
  }

  // Internal interface (called only by the Worker): GET /list · GET /get?id= · POST /create { ws, th } · POST /update { id, ws, th }
  // Each entry is stored as "ws:<id>" → { ws, th }; th = SHA-256 of the edit_token, compared only here and never leaves the DO
  async fetch(request) {
    const u = new URL(request.url);
    const s = this.ctx.storage;
    const now = new Date(this.clock()).toISOString();

    if (request.method === "GET" && u.pathname === "/list") {
      const m = await s.list({ prefix: "ws:" });
      return Response.json({ ok: true, worksites: [...m.values()].map((r) => r.ws) });
    }
    if (request.method === "GET" && u.pathname === "/get") {
      const r = await s.get(`ws:${u.searchParams.get("id")}`);
      return r ? Response.json({ ok: true, worksite: r.ws }) : Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    const b = await request.json();

    if (u.pathname === "/create") {
      if (!(await this.takeWrite(now))) return Response.json({ ok: false, error: "daily_cap" }, { status: 429 });
      const n = (await s.list({ prefix: "ws:" })).size;
      if (n >= WS_LIMITS.entries) return Response.json({ ok: false, error: "full" }, { status: 409 });
      let id = null;
      for (let i = 0; i < 8 && !id; i++) {
        const c = newId();
        if (!isSeedId(c) && !(await s.get(`ws:${c}`))) id = c;
      }
      if (!id) return Response.json({ ok: false, error: "id_exhausted" }, { status: 500 });
      const ws = { id, ...b.ws, seed: false, created: now, updated: now };
      await s.put(`ws:${id}`, { ws, th: b.th });
      return Response.json({ ok: true, worksite: ws }, { status: 201 });
    }

    if (u.pathname === "/update") {
      const r = await s.get(`ws:${b.id}`);
      if (!r) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      if (typeof b.th !== "string" || r.th !== b.th) return Response.json({ ok: false, error: "bad_token" }, { status: 403 });
      if (!(await this.takeWrite(now))) return Response.json({ ok: false, error: "daily_cap" }, { status: 429 });
      const ws = { id: b.id, ...b.ws, seed: false, created: r.ws.created, updated: now };
      await s.put(`ws:${b.id}`, { ws, th: r.th });
      return Response.json({ ok: true, worksite: ws });
    }

    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // Global daily write counter (UTC): a single { day, n } record
  async takeWrite(now) {
    const day = now.slice(0, 10);
    const cur = await this.ctx.storage.get("writes");
    const n = cur && cur.day === day && Number.isInteger(cur.n) ? cur.n : 0;
    if (n >= WS_LIMITS.writesPerDay) return false;
    await this.ctx.storage.put("writes", { day, n: n + 1 });
    return true;
  }
}

const stubOf = (env) => {
  const ns = env?.REGISTER;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
  return ns.get(ns.idFromName("global"));
};

// Internal DO call → { status, b }; a DO error gives { status: 503 }
async function doCall(stub, path, body) {
  try {
    const init = body === undefined ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const r = await stub.fetch(`https://register.internal${path}`, init);
    return { status: r.status, b: await r.json() };
  } catch {
    return { status: 503, b: null };
  }
}

// DO error code → public msg
const DO_MSG = {
  not_found: "no such worksite",
  bad_token: "wrong edit_token: only the holder of the token issued at creation can edit",
  daily_cap: `the register has reached today's write limit (${WS_LIMITS.writesPerDay} per day, reset at 00:00 UTC)`,
  full: `the register is full (at most ${WS_LIMITS.entries} entries)`,
};
const fromDo = ({ status, b }) =>
  b ? fail(status, b.error || "register_error", DO_MSG[b.error] || "register error") : fail(503, "register_error", "register temporarily unavailable");

async function readJson(request) {
  const text = await readLimited(request, MAX_BODY);
  if (text === null) return { err: fail(413, "too_large", `request body exceeds ${MAX_BODY} bytes`) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { err: fail(400, "bad_json", "request body is not valid JSON") };
  }
}

const badInput = (e) => {
  if (e instanceof WorksiteError) return fail(400, e.code, e.message);
  throw e;
};

// /api/worksites and /api/worksites/<id>; any other path returns null (worker.js then answers 404)
export async function handleWorksites(request, env, url) {
  const path = url.pathname;
  const stub = stubOf(env);

  if (path === "/api/worksites") {
    if (request.method === "GET") {
      let q;
      try {
        q = parseQuery(url.searchParams);
      } catch (e) {
        return badInput(e);
      }
      // DO unbound or failing: still return the seed worksites so the page works; register tells the page which mode it is in
      let stored = [];
      let register = "seed";
      if (stub) {
        const r = await doCall(stub, "/list");
        if (r.status === 200 && r.b?.ok) {
          stored = r.b.worksites;
          register = "do";
        }
      }
      const worksites = selectWorksites([...SEEDS, ...stored], q);
      return json({ ok: true, register, n: worksites.length, worksites });
    }
    if (request.method === "POST") {
      if (!stub) return fail(503, "no_register", "register not deployed (the api Worker has no REGISTER binding): only the seed worksites are available");
      const { body, err } = await readJson(request);
      if (err) return err;
      let ws;
      try {
        ws = normalizeWorksite(body);
      } catch (e) {
        return badInput(e);
      }
      if (ws.decision) ws.decision.at = new Date().toISOString();
      const token = newToken();
      const r = await doCall(stub, "/create", { ws, th: await sha256Hex(token) });
      if (r.status !== 201) return fromDo(r);
      return json({ ok: true, worksite: r.b.worksite, edit_token: token }, 201);
    }
    return fail(405, "method", "GET / POST only");
  }

  const m = path.match(/^\/api\/worksites\/([^/]+)$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!ID_RE.test(id)) return fail(404, "not_found", "no such worksite");
  const seed = SEEDS.find((s) => s.id === id);

  if (request.method === "GET") {
    if (seed) return json({ ok: true, worksite: seed });
    if (!stub) return fail(404, "not_found", "no such worksite");
    const r = await doCall(stub, `/get?id=${encodeURIComponent(id)}`);
    return r.status === 200 && r.b?.ok ? json({ ok: true, worksite: r.b.worksite }) : fromDo(r);
  }

  if (request.method === "PATCH") {
    if (seed) return fail(403, "locked", "seed worksites cannot be edited: register a new one instead");
    if (!stub) return fail(503, "no_register", "register not deployed (the api Worker has no REGISTER binding)");
    const token = request.headers.get("x-edit-token") || "";
    if (!TOKEN_RE.test(token)) return fail(403, "bad_token", "x-edit-token header required (the 32-character token issued at creation)");
    const { body, err } = await readJson(request);
    if (err) return err;
    const cur = await doCall(stub, `/get?id=${encodeURIComponent(id)}`);
    if (cur.status !== 200 || !cur.b?.ok) return fromDo(cur);
    let ws;
    try {
      ws = applyPatch(cur.b.worksite, body);
    } catch (e) {
      return badInput(e);
    }
    // Stamp server time if this request writes the decision; otherwise keep the original time
    if (ws.decision && body && Object.prototype.hasOwnProperty.call(body, "decision")) ws.decision.at = new Date().toISOString();
    const r = await doCall(stub, "/update", { id, ws, th: await sha256Hex(token) });
    return r.status === 200 && r.b?.ok ? json({ ok: true, worksite: r.b.worksite }) : fromDo(r);
  }

  return fail(405, "method", "GET / PATCH only");
}
