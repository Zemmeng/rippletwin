// Execution pack + equipment hire quote: once a person has chosen a plan, they take away something they can act on
//   quote()      site equipment → RPM inventory items (equipment.json in apps/roads) × quantity × days = hire cost; over-stock and unmatched items are flagged
//   stockCheck() several worksites sharing one inventory on the same days: which item runs short on which day
//   buildPack()  the execution pack for one worksite: location, time, decision, equipment list and quote, VMS schedule, set-up checks, who to notify
//   packText()   execution pack → plain text (zh / en), for the web page's Copy and Print
// Pure functions that run in the browser (network, inventory and engine results are all there); not a new endpoint.
// 🔒 Day rates are assumptions (the sources in equipment.json say no public prices are published): quotes and texts always say so ("assumptions; RPM Hire's formal quote applies")
// 🔒 Notification targets are roles only (tram / bus operator, emergency services...), never specific organisations or contact details

const dayNum = (s) => Date.parse(`${s}T00:00:00Z`) / 86400000;
const fmtDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const daysOf = (time) => dayNum(time.to) - dayNum(time.from) + 1;
const pad = (h) => `${String(h).padStart(2, "0")}:00`;
const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Sign text → inventory item (first match wins)
const SIGN_RULES = [
  [/FOOTPATH CLOSED/, "sign_footpath_closed"],
  [/BIKE LANE CLOSED|BICYCLES MERGE/, "sign_bike_lane_closed"],
  [/END ROAD ?WORKS?/, "sign_end_roadwork"],
  [/ROAD ?WORKS? AHEAD/, "sign_roadwork_ahead"],
  [/LEFT LANE CLOSED/, "sign_lane_closed_left"],
  [/RIGHT LANE CLOSED/, "sign_lane_closed_right"],
  [/DETOUR.*LEFT|LEFT.*DETOUR/, "sign_detour_left"],
  [/DETOUR.*RIGHT|RIGHT.*DETOUR/, "sign_detour_right"],
  [/DETOUR/, "sign_detour_straight"],
];
const DEFAULT_ITEM = { vms: "vms_a", arrow: "arrow_board", barrier: "barrier_water" };

// One piece of site equipment → { item | null, how }. how: given (item set) / type (by type) / text (by sign text) / none (no match)
export function itemFor(e) {
  if (e.item) return { item: e.item, how: "given" };
  if (e.type === "sign") {
    const hit = SIGN_RULES.find(([re]) => re.test(e.text || ""));
    return hit ? { item: hit[1], how: "text" } : { item: null, how: "none" };
  }
  return DEFAULT_ITEM[e.type] ? { item: DEFAULT_ITEM[e.type], how: "type" } : { item: null, how: "none" };
}

// network.json → Map(link id → { len_m, name, lanes, tram }); the web page passes it in when it has the network, so barriers are counted from the closure length
export function linkInfoFrom(network) {
  const m = new Map();
  for (const l of network?.links || []) m.set(l.id, { len_m: l.len_m, name: l.name || null, lanes: l.lanes, tram: Boolean(l.tram) });
  return m;
}

const invIndex = (inventory) => new Map((inventory?.items || []).map((i) => [i.id, i]));

// Equipment list and hire cost for one worksite. links: the result of linkInfoFrom() (optional: without it the barrier count is unknown and flagged length_unknown)
export function quote(ws, inventory, { links } = {}) {
  const inv = invIndex(inventory);
  const days = daysOf(ws.time);
  const lenKnown = links && ws.links.every((id) => links.has(id));
  const length_m = lenKnown ? ws.links.reduce((s, id) => s + (links.get(id).len_m || 0), 0) : null;
  const byItem = new Map();
  const unmatched = [];
  const notes = [];
  for (const e of ws.equipment || []) {
    const { item, how } = itemFor(e);
    const it = item ? inv.get(item) : null;
    if (!it) {
      unmatched.push({ equipment: e.id, type: e.type, text: e.text ?? null, item });
      continue;
    }
    let qty = e.qty ?? null;
    if (qty === null && it.category === "barrier") {
      if (length_m !== null && it.unit_len_m > 0) qty = Math.max(1, Math.ceil(length_m / it.unit_len_m));
      else notes.push({ code: "length_unknown", equipment: e.id });
    }
    if (qty === null && it.category !== "barrier") qty = 1;
    const row = byItem.get(it.id) || { item: it.id, name: it.name, category: it.category, equipment: [], qty: 0, unknown: false, day_rate_aud: it.day_rate_aud, stock: it.qty, how };
    row.equipment.push(e.id);
    if (qty === null) row.unknown = true;
    else row.qty += qty;
    byItem.set(it.id, row);
  }
  const lines = [...byItem.values()].map((r) => {
    const cost = r.unknown || typeof r.day_rate_aud !== "number" ? null : r.qty * r.day_rate_aud * days;
    return { ...r, days, cost_aud: cost, over_stock: typeof r.stock === "number" && r.qty > r.stock };
  });
  const total = lines.every((l) => l.cost_aud !== null) ? lines.reduce((s, l) => s + l.cost_aud, 0) : null;
  return {
    currency: "AUD",
    days,
    length_m,
    lines,
    total_aud: total,
    partial_total_aud: lines.reduce((s, l) => s + (l.cost_aud || 0), 0),
    unmatched,
    over_stock: lines.filter((l) => l.over_stock).map((l) => ({ item: l.item, need: l.qty, stock: l.stock })),
    notes,
    assumed: true, // day rates and stock counts are both assumptions
  };
}

// Several worksites sharing inventory on the same days (dates only, not hours: equipment left on site counts as in use) → [{ item, date, need, stock, worksites }], reporting only the worst day per item
export function stockCheck(worksites, inventory, opts = {}) {
  const inv = invIndex(inventory);
  const use = new Map(); // "item|day" → { need, ids }
  for (const ws of worksites) {
    if (ws.status === "withdrawn") continue;
    const q = quote(ws, inventory, opts);
    for (let d = dayNum(ws.time.from); d <= dayNum(ws.time.to); d++) {
      for (const l of q.lines) {
        const k = `${l.item}|${d}`;
        const u = use.get(k) || { need: 0, ids: [] };
        u.need += l.qty;
        u.ids.push(ws.id);
        use.set(k, u);
      }
    }
  }
  const worst = new Map();
  for (const [k, u] of use) {
    const [item, d] = k.split("|");
    const stock = inv.get(item)?.qty;
    if (typeof stock !== "number" || u.need <= stock) continue;
    const w = worst.get(item);
    if (!w || u.need > w.need || (u.need === w.need && Number(d) < dayNum(w.date))) worst.set(item, { item, date: fmtDay(Number(d)), need: u.need, stock, worksites: [...new Set(u.ids)] });
  }
  return [...worst.values()].sort((a, b) => (a.item < b.item ? -1 : 1));
}

// Set-up checks (only what the inventory and equipment list can show; no standard clauses are cited) → [{ code, ... }]
function checksFor(ws, q, links) {
  const out = [];
  const has = (re) => (ws.equipment || []).some((e) => re.test(itemFor(e).item || ""));
  if (ws.closes.lanes > 0 && !has(/^barrier_/)) out.push({ code: "no_barrier" });
  if (ws.closes.footpath && !has(/^sign_footpath_closed$/)) out.push({ code: "no_footpath_sign" });
  if (ws.closes.lanes > 0 && !has(/^sign_end_roadwork$/)) out.push({ code: "no_end_sign" });
  const full = links && ws.links.length && ws.links.every((id) => links.has(id) && ws.closes.lanes >= links.get(id).lanes);
  if (full && !has(/^sign_detour_/) && !(ws.equipment || []).some((e) => e.type === "vms")) out.push({ code: "full_no_detour_info" });
  for (const o of q.over_stock) out.push({ code: "over_stock", ...o });
  for (const u of q.unmatched) out.push({ code: "unmatched", ...u });
  for (const n of q.notes) out.push(n);
  return out;
}

// Who to notify (roles, not organisations) → [{ who, why: { code, ... } }]. impacts = explain.js metrics (from optionFromRun), optional
function notifyFor(ws, links, impacts) {
  const m = impacts || {};
  const out = [{ who: "council", why: { code: "road_occupation" } }, { who: "frontage", why: { code: "access", lanes: ws.closes.lanes, footpath: ws.closes.footpath } }];
  const tramLink = links && ws.links.some((id) => links.get(id)?.tram);
  if (m.transit_pax_min > 0 || m.transit_blocked_pax_h > 0 || tramLink) {
    out.push({ who: "transit", why: { code: "transit", pax_min: m.transit_pax_min ?? null, blocked_pax_h: m.transit_blocked_pax_h ?? null, tram_link: Boolean(tramLink) } });
  }
  const full = links && ws.links.length && ws.links.every((id) => links.has(id) && ws.closes.lanes >= links.get(id).lanes);
  if (full || m.blocked_vph > 0) out.push({ who: "emergency", why: { code: "full_closure", blocked_vph: m.blocked_vph ?? null } });
  if (ws.closes.footpath || m.peds_extra_min > 0) out.push({ who: "pedestrians", why: { code: "footpath", footpath: ws.closes.footpath, peds_extra_min: m.peds_extra_min ?? null } });
  return out;
}

// Execution pack for one worksite (a register worksite object, or an engine-format worksite plan)
// opts: { inventory (required), links (from linkInfoFrom), impacts (metrics of the chosen plan), now (ISO, fixed in tests) }
export function buildPack(ws, { inventory, links, impacts, now } = {}) {
  if (!inventory || !Array.isArray(inventory.items)) throw new Error("buildPack needs inventory (apps/roads/public/cbd/equipment.json)");
  const q = quote(ws, inventory, { links });
  const streets = links ? [...new Set(ws.links.map((id) => links.get(id)?.name).filter(Boolean))] : [];
  return {
    id: ws.id ?? null,
    title: ws.title ?? ws.name ?? null,
    status: ws.status ?? null,
    decision: ws.decision ?? null,
    where: { links: [...ws.links], streets, length_m: q.length_m, closes: { lanes: ws.closes?.lanes ?? 0, footpath: ws.closes?.footpath ?? null } },
    when: { from: ws.time.from, to: ws.time.to, days: q.days, hours: ws.time.hours || [0, 24] },
    quote: q,
    vms: (ws.equipment || []).filter((e) => e.type === "vms").map((e) => ({ id: e.id, at_m: e.at_m, frames: e.frames || [], from: ws.time.from, to: ws.time.to, hours: ws.time.hours || [0, 24] })),
    signs: (ws.equipment || []).filter((e) => e.type === "sign" || e.type === "arrow").map((e) => ({ id: e.id, type: e.type, at_m: e.at_m, text: e.text ?? null })),
    checks: checksFor(ws, q, links),
    notify: notifyFor(ws, links, impacts),
    impacts: impacts ? { ...impacts } : null,
    generated: now || new Date().toISOString(),
  };
}

// ---- Text versions ----

const T = {
  zh: {
    head: "施工执行包",
    colon: "：",
    status: "状态",
    st: { draft: "草稿", assessed: "已评估", decided: "已选定", exported: "已导出", withdrawn: "已撤回" },
    where: "地点",
    lanes: (n) => (n > 0 ? `封 ${n} 条车道` : "车道照常"),
    foot: { null: "人行道照常", left: "封施工侧人行道", right: "封对侧人行道", both: "两侧人行道都封" },
    seg: (n, m) => `${n} 段路${m === null ? "" : `，共 ${commas(m)} 米`}`,
    when: "时间",
    span: (a, b, d) => `${a} 至 ${b}（${d} 天）`,
    daily: (h) => `每天 ${pad(h[0])}–${pad(h[1])}`,
    decision: "决定",
    decided: (d) => `选 ${d.option}（${d.by === "council" ? "市政" : "施工方"}${d.at ? `，${d.at.slice(0, 10)}` : ""}）${d.reason ? `：${d.reason}` : ""}`,
    quote: "设备清单和报价（日租价、库存件数是假设值，以 RPM Hire 正式报价为准）",
    line: (l) => `${l.name} × ${l.unknown ? "?" : l.qty} · A$${l.day_rate_aud}/天 × ${l.days} 天 = ${l.cost_aud === null ? "算不出" : `A$${commas(l.cost_aud)}`}${l.over_stock ? `  ⚠ 超库存（库存 ${l.stock}）` : ""}`,
    total: (q) => (q.total_aud === null ? `合计：至少 A$${commas(q.partial_total_aud)}（有的件数算不出，见检查）` : `合计：A$${commas(q.total_aud)}（假设值）`),
    vms: "VMS 排程",
    vmsLine: (v) => `${v.id} · 施工起点上游 ${v.at_m} 米 · ${v.from} 至 ${v.to} ${`每天 ${pad(v.hours[0])}–${pad(v.hours[1])}`}`,
    frame: (i, f) => `  第 ${i + 1} 屏：${f.join(" / ")}`,
    signs: "标志牌和箭头板",
    signLine: (s) => `${s.id} · ${s.at_m < 0 ? `施工起点下游 ${-s.at_m} 米` : `上游 ${s.at_m} 米`} · ${s.type === "arrow" ? "箭头板" : "标志牌"}${s.text ? `：${s.text}` : ""}`,
    checks: "检查",
    check: {
      no_barrier: () => "封了车道，但清单里没有护栏",
      no_footpath_sign: () => "封了人行道，但没摆「人行道封闭」牌",
      no_end_sign: () => "没有「施工结束」牌",
      full_no_detour_info: () => "全封，但没有绕行牌也没有 VMS 告诉司机怎么走",
      over_stock: (c) => `${c.item} 要 ${c.need} 件，库存只有 ${c.stock} 件`,
      unmatched: (c) => `${c.equipment}${c.text ? `（${c.text}）` : ""}在库存里没有对应的设备，没算进报价`,
      length_unknown: (c) => `${c.equipment}：不知道封闭段多长，护栏节数算不出`,
    },
    notify: "要通知",
    who: { council: "市政交通管理", frontage: "沿街商户和居民", transit: "电车 / 公交运营方", emergency: "应急服务（救护、消防、警察）", pedestrians: "行人和无障碍出行者（现场告示）" },
    why: {
      road_occupation: () => "施工占用道路，要审批",
      access: (w) => `${w.lanes > 0 ? `封 ${w.lanes} 条车道` : "车道照常"}${w.footpath ? "、封人行道" : ""}，出入受影响`,
      transit: (w) => [w.pax_min > 0 ? `乘客多花 ${commas(w.pax_min)} 人·分钟` : "", w.blocked_pax_h > 0 ? `每小时约 ${commas(w.blocked_pax_h)} 名乘客的线路停运` : "", w.tram_link ? "封闭路段上有电车" : ""].filter(Boolean).join("；"),
      full_closure: (w) => `全封${w.blocked_vph > 0 ? `，每小时约 ${commas(w.blocked_vph)} 辆车无路可绕` : ""}，应急通道要另行安排`,
      footpath: (w) => `${w.footpath ? "人行道封闭" : "行人要绕行"}${w.peds_extra_min > 0 ? `，行人多花 ${commas(w.peds_extra_min)} 人·分钟` : ""}`,
    },
    none: "无",
    foot2: "数字来自仿真引擎，不是实测；租金是假设值。",
    vmsAt: (m) => `施工起点上游 ${m} 米`,
    frameN: (i) => `第 ${i + 1} 屏`,
    signAt: (s) => `${s.at_m < 0 ? `施工起点下游 ${-s.at_m} 米` : `上游 ${s.at_m} 米`} · ${s.type === "arrow" ? "箭头板" : "标志牌"}`,
    cols: { item: "设备", qty: "数量", rate: "日租价", days: "天数", cost: "金额" },
    perDay: "/天",
    quoteHead: "设备清单和报价",
    quoteNote: "日租价和库存件数是假设值，以 RPM Hire 正式报价为准。",
    totalLbl: "合计",
    atLeast: "至少",
    overStock: (l) => `超库存（库存 ${l.stock}）`,
    reasonLbl: "理由",
  },
  en: {
    head: "Worksite execution pack",
    colon: ": ",
    status: "Status",
    st: { draft: "draft", assessed: "assessed", decided: "decided", exported: "exported", withdrawn: "withdrawn" },
    where: "Where",
    lanes: (n) => (n > 0 ? `${n} lane${n > 1 ? "s" : ""} closed` : "no lanes closed"),
    foot: { null: "footpath open", left: "works-side footpath closed", right: "far-side footpath closed", both: "both footpaths closed" },
    seg: (n, m) => `${n} road segment${n > 1 ? "s" : ""}${m === null ? "" : `, ${commas(m)} m in total`}`,
    when: "When",
    span: (a, b, d) => `${a} to ${b} (${d} day${d > 1 ? "s" : ""})`,
    daily: (h) => `daily ${pad(h[0])}–${pad(h[1])}`,
    decision: "Decision",
    decided: (d) => `chose ${d.option} (${d.by}${d.at ? `, ${d.at.slice(0, 10)}` : ""})${d.reason ? `: ${d.reason}` : ""}`,
    quote: "Equipment and hire quote (day rates and stock are assumptions; RPM Hire's formal quote applies)",
    line: (l) => `${l.name} × ${l.unknown ? "?" : l.qty} · A$${l.day_rate_aud}/day × ${l.days} days = ${l.cost_aud === null ? "unknown" : `A$${commas(l.cost_aud)}`}${l.over_stock ? `  ⚠ over stock (${l.stock} in stock)` : ""}`,
    total: (q) => (q.total_aud === null ? `Total: at least A$${commas(q.partial_total_aud)} (some quantities unknown, see checks)` : `Total: A$${commas(q.total_aud)} (assumed rates)`),
    vms: "VMS schedule",
    vmsLine: (v) => `${v.id} · ${v.at_m} m before the works · ${v.from} to ${v.to} daily ${pad(v.hours[0])}–${pad(v.hours[1])}`,
    frame: (i, f) => `  Frame ${i + 1}: ${f.join(" / ")}`,
    signs: "Signs and arrow boards",
    signLine: (s) => `${s.id} · ${s.at_m < 0 ? `${-s.at_m} m after the start of the works` : `${s.at_m} m before`} · ${s.type === "arrow" ? "arrow board" : "sign"}${s.text ? `: ${s.text}` : ""}`,
    checks: "Checks",
    check: {
      no_barrier: () => "Lanes are closed but no barriers are listed",
      no_footpath_sign: () => "Footpath is closed but there is no 'Footpath closed' sign",
      no_end_sign: () => "No 'End roadwork' sign",
      full_no_detour_info: () => "Full closure with no detour sign and no VMS to guide drivers",
      over_stock: (c) => `${c.item}: need ${c.need}, only ${c.stock} in stock`,
      unmatched: (c) => `${c.equipment}${c.text ? ` (${c.text})` : ""} has no matching item in the inventory and is not in the quote`,
      length_unknown: (c) => `${c.equipment}: closure length unknown, barrier count not computed`,
    },
    notify: "Notify",
    who: { council: "Council traffic management", frontage: "Businesses and residents on the street", transit: "Tram / bus operator", emergency: "Emergency services (ambulance, fire, police)", pedestrians: "Pedestrians and people with disabilities (on-site notices)" },
    why: {
      road_occupation: () => "Works occupy the road and need approval",
      access: (w) => `${w.lanes > 0 ? `${w.lanes} lane${w.lanes > 1 ? "s" : ""} closed` : "lanes open"}${w.footpath ? ", footpath closed" : ""}; access affected`,
      transit: (w) => [w.pax_min > 0 ? `passengers lose ${commas(w.pax_min)} passenger-min` : "", w.blocked_pax_h > 0 ? `routes carrying about ${commas(w.blocked_pax_h)} passengers an hour stop` : "", w.tram_link ? "tram tracks on the closed road" : ""].filter(Boolean).join("; "),
      full_closure: (w) => `Full closure${w.blocked_vph > 0 ? `; about ${commas(w.blocked_vph)} vehicles an hour have no detour` : ""}; plan emergency access`,
      footpath: (w) => `${w.footpath ? "Footpath closed" : "Pedestrians detour"}${w.peds_extra_min > 0 ? `; pedestrians lose ${commas(w.peds_extra_min)} person-min` : ""}`,
    },
    none: "none",
    foot2: "Figures come from the simulation engine, not field measurements; hire rates are assumptions.",
    vmsAt: (m) => `${m} m before the works`,
    frameN: (i) => `Frame ${i + 1}`,
    signAt: (s) => `${s.at_m < 0 ? `${-s.at_m} m after the start of the works` : `${s.at_m} m before`} · ${s.type === "arrow" ? "arrow board" : "sign"}`,
    cols: { item: "Item", qty: "Qty", rate: "Day rate", days: "Days", cost: "Cost" },
    perDay: "/day",
    quoteHead: "Equipment and hire quote",
    quoteNote: "Day rates and stock are assumptions; RPM Hire's formal quote applies.",
    totalLbl: "Total",
    atLeast: "at least",
    overStock: (l) => `over stock (${l.stock} in stock)`,
    reasonLbl: "Reason",
  },
};

// Execution pack → translated text grouped by section (for the web page to lay out as a document; same wording table as packText). Amounts and quantities stay numbers for the page to format
export function packDoc(p, lang = "en") {
  const t = T[lang] || T.en;
  const place = [p.where.streets.join(", "), t.seg(p.where.links.length, p.where.length_m), t.lanes(p.where.closes.lanes), t.foot[p.where.closes.footpath ?? "null"]].filter(Boolean);
  return {
    lang: T[lang] ? lang : "en",
    head: t.head,
    id: p.id,
    title: p.title || p.id || "",
    status: p.status ? { key: p.status, text: t.st[p.status] || p.status } : null,
    labels: { status: t.status, where: t.where, when: t.when, decision: t.decision, reason: t.reasonLbl, quote: t.quoteHead, vms: t.vms, signs: t.signs, checks: t.checks, notify: t.notify, total: t.totalLbl, cols: t.cols, none: t.none },
    where: place.join(" · "),
    when: `${t.span(p.when.from, p.when.to, p.when.days)} · ${t.daily(p.when.hours)}`,
    decision: p.decision ? t.decided({ ...p.decision, reason: "" }).replace(/[：:]\s*$/, "") : null,
    reason: p.decision && p.decision.reason ? p.decision.reason : "",
    quote: {
      note: t.quoteNote,
      per_day: t.perDay,
      lines: p.quote.lines.map((l) => ({ name: l.name, item: l.item, qty: l.unknown ? null : l.qty, rate: l.day_rate_aud, days: l.days, cost: l.cost_aud, over: l.over_stock ? t.overStock(l) : null })),
      total_aud: p.quote.total_aud,
      partial_aud: p.quote.partial_total_aud,
      at_least: t.atLeast,
    },
    vms: p.vms.map((v) => ({ id: v.id, at: t.vmsAt(v.at_m), when: `${t.span(v.from, v.to, p.when.days)} · ${t.daily(v.hours)}`, frames: v.frames.map((f, i) => ({ label: t.frameN(i), lines: [...f] })) })),
    signs: p.signs.map((s) => ({ id: s.id, at: t.signAt(s), text: s.text || "" })),
    checks: p.checks.map((c) => (t.check[c.code] || (() => c.code))(c)),
    notify: p.notify.map((n) => ({ who: t.who[n.who], why: (t.why[n.why.code] || (() => ""))(n.why) })),
    foot: t.foot2,
    generated: p.generated,
  };
}

export function packText(p, lang = "en") {
  const t = T[lang] || T.en;
  const out = [];
  out.push(`${t.head} · ${[p.id, p.title].filter(Boolean).join(" · ")}`);
  const c = t.colon;
  if (p.status) out.push(`${t.status}${c}${t.st[p.status] || p.status}`);
  const place = [p.where.streets.join(", "), t.seg(p.where.links.length, p.where.length_m), t.lanes(p.where.closes.lanes), t.foot[p.where.closes.footpath ?? "null"]].filter(Boolean);
  out.push(`${t.where}${c}${place.join(" · ")}`);
  out.push(`${t.when}${c}${t.span(p.when.from, p.when.to, p.when.days)} · ${t.daily(p.when.hours)}`);
  if (p.decision) out.push(`${t.decision}${c}${t.decided(p.decision)}`);
  out.push("", `${t.quote}${c.trim()}`);
  for (const l of p.quote.lines) out.push(`- ${t.line(l)}`);
  out.push(t.total(p.quote));
  out.push("", `${t.vms}${c.trim()}`);
  if (!p.vms.length) out.push(`- ${t.none}`);
  for (const v of p.vms) {
    out.push(`- ${t.vmsLine(v)}`);
    v.frames.forEach((f, i) => out.push(t.frame(i, f)));
  }
  if (p.signs.length) {
    out.push("", `${t.signs}${c.trim()}`);
    for (const s of p.signs) out.push(`- ${t.signLine(s)}`);
  }
  out.push("", `${t.checks}${c.trim()}`);
  if (!p.checks.length) out.push(`- ${t.none}`);
  for (const c of p.checks) out.push(`- ${(t.check[c.code] || (() => c.code))(c)}`);
  out.push("", `${t.notify}${c.trim()}`);
  for (const n of p.notify) out.push(`- ${t.who[n.who]}${c}${(t.why[n.why.code] || (() => ""))(n.why)}`);
  out.push("", t.foot2);
  return out.join("\n");
}

// Browser side: fetch the inventory (same origin, the static file published by apps/roads)
export async function loadInventory({ fetch, base = "" } = {}) {
  const f = fetch || globalThis.fetch;
  const r = await f(`${base}/roads/public/cbd/equipment.json`);
  if (!r.ok) throw new Error(`could not load equipment.json (${r.status})`);
  return r.json();
}
