// Execution pack + equipment hire (public/js/pack.js): equipment-to-inventory mapping, quote, over-stock, shared inventory across worksites, set-up checks, who to notify, text versions
// Negative assertions: quotes and texts always say the rates are assumptions; equipment with no inventory match is never forced onto an item; notifications name roles only; no token in the texts
// Usage: node tests/pack.test.mjs; no npm install needed (the real-data sections are skipped without the apps/roads inventory / network)
import { existsSync, readFileSync } from "node:fs";
import { ok, eq, sec, done, throws } from "./mini.mjs";
import { itemFor, quote, stockCheck, buildPack, packText, packDoc, linkInfoFrom, daysOf, loadInventory } from "../public/js/pack.js";
import { SEEDS, normalizeWorksite, WorksiteError } from "../public/js/worksites.js";

const roads = new URL("../../roads/public/cbd/", import.meta.url);
const have = existsSync(new URL("equipment.json", roads)) && existsSync(new URL("network.json", roads));

await sec("equipment → inventory item", () => {
  eq(itemFor({ type: "vms" }), { item: "vms_a", how: "type" }, "VMS defaults to class A");
  eq(itemFor({ type: "arrow" }).item, "arrow_board", "arrow board");
  eq(itemFor({ type: "barrier" }).item, "barrier_water", "barrier defaults to a water-filled barrier (friendlier to pedestrians and cyclists)");
  eq(itemFor({ type: "sign", text: "RIGHT LANE CLOSED" }).item, "sign_lane_closed_right", "by the sign text");
  eq(itemFor({ type: "sign", text: "ROADWORK AHEAD" }).item, "sign_roadwork_ahead", "ROADWORK AHEAD");
  eq(itemFor({ type: "sign", text: "END ROADWORK" }).item, "sign_end_roadwork", "END ROADWORK is not mistaken for ROADWORK AHEAD");
  eq(itemFor({ type: "sign", text: "DETOUR LEFT" }).item, "sign_detour_left", "DETOUR LEFT");
  eq(itemFor({ type: "sign", text: "FOOTPATH CLOSED USE OTHER SIDE" }).item, "sign_footpath_closed", "footpath closed");
  eq(itemFor({ type: "sign", text: "ROAD CLOSED" }), { item: null, how: "none" }, "negative: a sign not in the inventory is not forced onto an item");
  eq(itemFor({ type: "vms", item: "vms_c" }), { item: "vms_c", how: "given" }, "an explicit item is used as given");
});

await sec("register worksites can carry item / qty", () => {
  const base = { title: "x", links: ["a"], closes: { lanes: 1 }, time: { from: "2026-10-01", to: "2026-10-02" } };
  const w = normalizeWorksite({ ...base, equipment: [{ id: "V", type: "vms", at_m: 100, frames: [["USE", "RUSSELL ST"]], item: "vms_c", qty: 2 }] });
  eq([w.equipment[0].item, w.equipment[0].qty], ["vms_c", 2], "item / qty kept");
  const code = (e) => {
    try {
      normalizeWorksite({ ...base, equipment: [e] });
    } catch (x) {
      return x instanceof WorksiteError ? x.code : "?";
    }
    return null;
  };
  eq(code({ id: "V", type: "barrier", at_m: 0, item: "Barrier Water" }), "bad_equipment", "malformed item");
  eq(code({ id: "V", type: "barrier", at_m: 0, qty: 0 }), "bad_equipment", "qty 0");
  eq(daysOf({ from: "2026-10-05", to: "2026-10-09" }), 5, "duration in calendar days, inclusive");
  throws(() => buildPack(SEEDS[0], {}), /inventory/, "throws when no inventory is passed");
});

if (!have) {
  console.log("⏭ skipping the real-data sections: apps/roads equipment.json / network.json missing");
} else {
  const inventory = JSON.parse(readFileSync(new URL("equipment.json", roads), "utf8"));
  const network = JSON.parse(readFileSync(new URL("network.json", roads), "utf8"));
  const links = linkInfoFrom(network);
  const [LON, , LTL] = SEEDS;
  const rate = (id) => inventory.items.find((i) => i.id === id).day_rate_aud;
  const stock = (id) => inventory.items.find((i) => i.id === id).qty;

  await sec("quote: Lonsdale (real inventory + real link length)", () => {
    const q = quote(LON, inventory, { links });
    const len = links.get(LON.links[0]).len_m;
    const barriers = Math.ceil(len / 2);
    eq([q.days, q.length_m], [5, len], `5 days · closure ${len} m`);
    const row = (id) => q.lines.find((l) => l.item === id);
    eq(row("barrier_water").qty, barriers, `water-filled barrier, 2 m per unit → ${barriers} units`);
    eq([row("vms_a").qty, row("arrow_board").qty, row("sign_lane_closed_right").qty], [1, 1, 1], "one each of VMS, arrow board and right-lane-closed sign");
    const expect = 5 * (rate("vms_a") + rate("arrow_board") + rate("sign_lane_closed_right") + barriers * rate("barrier_water"));
    eq(q.total_aud, expect, `total = quantity × day rate × days: A$${expect}`);
    eq([q.unmatched, q.over_stock, q.assumed], [[], [], true], "all matched, no over-stock, marked as assumed");
  });

  await sec("quote: explicit item / qty, over-stock, unmatched, unknown length", () => {
    const ws = { ...LON, equipment: [{ id: "V", type: "vms", at_m: 300, frames: [["A"]], item: "vms_c", qty: 2 }, { id: "B", type: "barrier", at_m: 0, item: "barrier_steel", qty: stock("barrier_steel") + 10 }, { id: "X", type: "barrier", at_m: 0, item: "crane_99" }] };
    const q = quote(ws, inventory, { links });
    eq(q.lines.find((l) => l.item === "vms_c").cost_aud, 2 * rate("vms_c") * 5, "vms_c × 2 at the class C day rate");
    eq(q.over_stock, [{ item: "barrier_steel", need: stock("barrier_steel") + 10, stock: stock("barrier_steel") }], "steel barrier over stock");
    eq(q.unmatched.map((u) => u.item), ["crane_99"], "an item not in the inventory → unmatched, not costed");
    const blind = quote(LON, inventory);
    eq([blind.length_m, blind.total_aud, blind.lines.find((l) => l.item === "barrier_water").unknown], [null, null, true], "no link lengths: barrier count unknown, total null");
    eq(blind.partial_total_aud, 5 * (rate("vms_a") + rate("arrow_board") + rate("sign_lane_closed_right")), "only an \"at least\" amount");
    eq(blind.notes, [{ code: "length_unknown", equipment: "B-1" }], "flags length_unknown");
  });

  await sec("shared inventory across worksites", () => {
    const vms2 = (id, from, to) => ({ ...LON, id, time: { from, to, hours: [7, 19] }, equipment: [{ id: "V1", type: "vms", at_m: 300, frames: [["A"]], qty: 2 }] });
    const three = [vms2("W-1", "2026-10-05", "2026-10-09"), vms2("W-2", "2026-10-07", "2026-10-12"), vms2("W-3", "2026-10-08", "2026-10-08")];
    const r = stockCheck(three, inventory, { links });
    eq(r, [{ item: "vms_a", date: "2026-10-08", need: 6, stock: stock("vms_a"), worksites: ["W-1", "W-2", "W-3"] }], "on 10-08 three worksites need 6 class A VMS with 4 in stock → reports the worst day");
    eq(stockCheck(three.slice(0, 2), inventory, { links }), [], "two worksites with 2 each = 4, just enough");
    eq(stockCheck([...three.slice(0, 2), { ...three[2], status: "withdrawn" }], inventory, { links }), [], "withdrawn worksites use no stock");
    eq(stockCheck(SEEDS, inventory, { links }), [], "the 3 seed worksites together fit the inventory");
  });

  await sec("execution pack: Little Bourke (full closure, unmatched sign)", () => {
    const impacts = { transit_pax_min: 120, blocked_vph: 35, peds_extra_min: 0 };
    const p = buildPack({ ...LTL, decision: { option: "o2", by: "council", reason: "shortest works", at: "2026-09-30T02:00:00.000Z" } }, { inventory, links, impacts, now: "2026-09-30T03:00:00.000Z" });
    eq([p.id, p.where.streets, p.when.days], ["W-LTLBOURKE", ["Little Bourke Street"], 6], "location, 6 days");
    const codes = p.checks.map((c) => c.code);
    ok(codes.includes("full_no_detour_info") && codes.includes("unmatched") && codes.includes("no_end_sign"), `full closure without detour information, ROAD CLOSED unmatched, no end-of-works sign: ${codes}`);
    eq(p.notify.map((n) => n.who), ["council", "frontage", "transit", "emergency"], "notify: council, frontage, transit (passenger delay), emergency (full closure)");
    const zh = packText(p, "zh");
    const en = packText(p, "en");
    console.log(zh.split("\n").map((l) => `    ${l}`).join("\n"));
    ok(/假设值，以 RPM Hire 正式报价为准/.test(zh) && /assumptions; RPM Hire's formal quote applies/.test(en), "negative: the texts always say day rates are assumptions");
    ok(/不是实测/.test(zh) && /not field measurements/.test(en), "states that the figures come from the simulation");
    ok(/选 o2（市政，2026-09-30）：shortest works/.test(zh), "the decision is included");
    ok(/ROAD CLOSED/.test(zh) && /没算进报价/.test(zh), "the unmatched sign is explicitly left out of the cost");
    ok(!/Yarra|PTV|Metro Trains|000|@|https?:/.test(zh + en), "negative: notifications name roles only, no organisations, phone numbers or URLs");
  });

  await sec("execution pack: Lonsdale text version + footpath", () => {
    const withFoot = { ...LON, closes: { lanes: 1, footpath: "left" } };
    const p = buildPack(withFoot, { inventory, links, now: "2026-09-30T03:00:00.000Z" });
    ok(p.checks.some((c) => c.code === "no_footpath_sign"), "footpath closed with no sign → check raised");
    ok(p.notify.some((n) => n.who === "pedestrians"), "footpath closed → notify pedestrians and people with disabilities");
    const fixed = buildPack({ ...withFoot, equipment: [...withFoot.equipment, { id: "S-9", type: "sign", at_m: 20, text: "FOOTPATH CLOSED" }] }, { inventory, links });
    ok(!fixed.checks.some((c) => c.code === "no_footpath_sign"), "a footpath-closed sign is placed → no check");
    const en = packText(buildPack(LON, { inventory, links }), "en");
    ok(/Frame 1: ROADWORK \/ AHEAD/.test(en) && /Frame 2: USE \/ RUSSELL ST/.test(en), "the VMS schedule lists every frame");
    ok(/Total: A\$[\d,]+ \(assumed rates\)/.test(en), "the total is marked assumed rates");
    ok(!/edit_token|[0-9a-f]{32}/.test(en), "negative: nothing token-like in the text version");
  });

  await sec("packDoc: sections for the web page layout (same wording table as packText)", () => {
    const p = buildPack({ ...LON, status: "decided", decision: { option: "C", by: "council", reason: "less delay", at: "2026-09-30T02:00:00.000Z" } }, { inventory, links, now: "2026-09-30T03:00:00.000Z" });
    const zh = packDoc(p, "zh"), en = packDoc(p, "en");
    eq([zh.lang, en.lang, packDoc(p, "fr").lang], ["zh", "en", "en"], "only zh / en; anything else falls back to English");
    eq([zh.title, zh.status.key, zh.status.text, en.status.text], ["Lonsdale St westbound lane closure", "decided", "已选定", "decided"], "title, status");
    eq([zh.decision, zh.reason], ["选 C（市政，2026-09-30）", "less delay"], "the decision line has no reason; the reason comes separately (the web page shows it as a quote)");
    ok(/假设值，以 RPM Hire 正式报价为准/.test(zh.quote.note) && /assumptions; RPM Hire's formal quote applies/.test(en.quote.note), "negative: the quote section always carries the assumption note");
    eq(zh.quote.total_aud, p.quote.total_aud, "the total is a number, the same as quote()");
    eq(zh.quote.lines.map((l) => l.qty), p.quote.lines.map((l) => l.qty), "quantities are numbers");
    eq(zh.vms[0].frames.map((f) => f.label), ["第 1 屏", "第 2 屏"], "VMS split by frame");
    eq(en.vms[0].frames[1].lines, ["USE", "RUSSELL ST"], "each frame's lines are given as is");
    eq(zh.labels.cols, { item: "设备", qty: "数量", rate: "日租价", days: "天数", cost: "金额" }, "column headers translated");
    ok(zh.checks.includes("没有「施工结束」牌") && zh.notify[0].who === "市政交通管理", "checks and notifications use the same wording as packText");
    const over = packDoc(buildPack({ ...LON, equipment: [{ id: "B", type: "barrier", at_m: 0, item: "barrier_steel", qty: stock("barrier_steel") + 1 }] }, { inventory, links }), "zh");
    ok(/超库存（库存 \d+）/.test(over.quote.lines[0].over || ""), "an over-stock line carries a note");
    const endSign = buildPack({ ...LON, equipment: [{ id: "S-9", type: "sign", at_m: -43, text: "END ROADWORK" }] }, { inventory, links });
    eq([packDoc(endSign, "zh").signs[0].at, packDoc(endSign, "en").signs[0].at], ["施工起点下游 43 米 · 标志牌", "43 m after the start of the works · sign"], "a negative at_m is written as downstream, not as -43 m upstream");
    ok(/S-9 · 施工起点下游 43 米 · 标志牌：END ROADWORK/.test(packText(endSign, "zh")), "same in the plain-text version");
  });

  await sec("browser-side loadInventory (fake fetch)", async () => {
    const inv = await loadInventory({ fetch: async (u) => ({ ok: u === "/roads/public/cbd/equipment.json", status: 200, json: async () => inventory }) });
    eq(inv.items.length, inventory.items.length, "fetches the inventory from the same-origin path");
    let err = null;
    try {
      await loadInventory({ fetch: async () => ({ ok: false, status: 404 }) });
    } catch (e) {
      err = e.message;
    }
    ok(/404/.test(err || ""), "throws if it cannot be fetched (the page decides how to tell the user)");
  });
}

done();
