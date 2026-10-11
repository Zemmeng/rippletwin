// Global daily cap on LLM calls: one Durable Object counter, shared by every Worker instance and every entry URL
// Why: /api/read is public, so with MOCK=0 anyone can POST; a per-instance per-minute limit cannot stop many instances or cache-busting variations. This is the real cap
// 🔒 No budget (BUDGET unbound, DO error, over the cap) means no call and a rule reading: better to use the LLM less than to overspend
// The free plan only allows SQLite-backed DOs (wrangler.jsonc migrations use new_sqlite_classes); resets daily at 00:00 UTC (10:00 or 11:00 in Melbourne)
// ⚠️ No import of "cloudflare:workers": worker.js must run directly in Node for tests, and a plain class with fetch() works as a DO in workerd too

const DAY_KEY = "calls"; // stores a single { day, n } record, so it never grows

const int = (x) => {
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

export class LlmBudget {
  // clock is injected only by tests; workerd passes just (ctx, env)
  constructor(ctx, env, clock = Date.now) {
    this.ctx = ctx;
    this.clock = clock;
  }

  // POST /take?n=3&max=600 → { ok, used, max, day }. There is no other I/O between get and put, so the DO input gate guarantees no other request interleaves
  async fetch(request) {
    const u = new URL(request.url);
    const n = int(u.searchParams.get("n"));
    const max = int(u.searchParams.get("max"));
    if (u.pathname !== "/take" || !(n > 0) || Number.isNaN(max)) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const cur = await this.ctx.storage.get(DAY_KEY);
    const used = cur && cur.day === day && Number.isInteger(cur.n) ? cur.n : 0;
    if (used + n > max) return Response.json({ ok: false, used, max, day });
    await this.ctx.storage.put(DAY_KEY, { day, n: used + n });
    return Response.json({ ok: true, used: used + n, max, day });
  }
}

// Worker side: reserve n calls. Returns "ok" | "over" | "no_budget" | "error" (never throws)
export async function takeBudget(env, n, max) {
  const ns = env?.BUDGET;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return "no_budget";
  try {
    const stub = ns.get(ns.idFromName("global"));
    const r = await stub.fetch(`https://budget.internal/take?n=${n}&max=${max}`, { method: "POST" });
    const b = await r.json();
    return b && b.ok === true ? "ok" : r.ok ? "over" : "error";
  } catch {
    return "error";
  }
}
