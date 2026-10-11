# 模块之间的接口契约

> 并行开发唯一需要协调的东西。改它 = 改所有调用方：PR 标题以 `contract:` 开头，lead 合并，合并后通知依赖方。优先向后兼容（加字段不删字段）。
> 版本号：**v3**（每改一次加 1，写进「变更记录」；现在 v3.11）。

## 谁调谁

| 调用方 | 被调方 | 接口 | 见节 |
|---|---|---|---|
| web | api | HTTP + WebSocket | §HTTP、§WS |
| engine、web | roads | 静态 JSON 文件（随网页一起发布，线上不调接口） | §路网数据文件 |
| engine | api | 浏览器里的 `readSigns()`（背后是 `POST /api/read`） | §路人读数 |
| web | engine | 浏览器里的 `createEngine(...).evaluate(方案)`（T9 骨架） | §施工方案、§evaluate |
| web | api | 施工登记表 `worksites.js`（背后是 `/api/worksites`）、AI 解读 `explain.js`（背后是 `POST /api/explain`）、执行包 `pack.js`（纯函数，不走接口） | §施工方案、§HTTP API |

## 路网数据文件（roads → engine、web）

T3 产出，放在 `apps/roads/public/cbd/`，本地和线上都从 `/roads/public/cbd/<文件>` 读（lead 部署时把每个模块的 `public/` 原样挂到 `/<模块>/public/`）。字段细则和生成方法见 `apps/roads/PRD.md` 第 5 节，校验见 `apps/roads/tests/test_roads.py`。

| 文件 | 顶层字段 | 要点 |
|---|---|---|
| `network.json` | `version, area, bbox[南,西,北,东], generated, sources, assumptions, nodes[], links[]` | 路段有方向；`links[]`：`id, from, to, name, highway, len_m, lanes, speed_kmh, cap_vph, t0_s, tram, bike_lane, osm_way, geometry[[lat,lon]]`；`nodes[]`：`id, lat, lon, osm, signal` |
| `flows.json` | `version, unit="veh/h", period, days{wd,we}{路段 id: 24 个数}, method{路段 id}, coverage{links, measured, estimated}` | 下标 = 小时；`method` ∈ `detector_map / site_split / street_interp / class_default` |
| `signals.json` | `version, sites[{site, name, type, lat, lon, node, dist_m}]` | `node` 是 30 米内最近的节点，没有就 `null` |
| `transit.json` | `version, sources, service_dates{wd,we}, assumptions, routes[], stops[], coverage` | PTV GTFS 电车 / 公交。`routes[]`：`id, mode (tram / bus), short, dirs[{dir, headsign, links[], stops[], trips{wd,we}[24], offnet_m, geometry}]`，`links` 是匹配到的路段 id（按 10 米采样，路口里的短路段可能缺）；`stops[]`：`id, name, lat, lon, mode, road_link, routes[]`。引擎的 `transit.js` 读它（T16） |
| `walk.json` | `version, area, bbox, sources, assumptions, nodes[{id, lat, lon}], links[]` | 人行道路网（不分方向）：`links[]`：`id, a, b, len_m, kind (sidewalk / other / path / crossing / mall), crossing (null / signal / uncontrolled / zebra), road_link, side (left / right / null), geometry`；`side` 相对 `road_link` 的行车方向 |
| `peds.json` | `version, unit="ped/h", period, days{wd,we}{walk link id: 24 个数}, method{walk link id}, sensors[{id, name, lat, lon, walk_link, road_link}], coverage` | `method` ∈ `sensor / street_interp / class_default`；只有 `sensor` 是实测 |

- 加字段随时可以；改名、删字段、改单位要开 `contract:` PR，并把文件里的 `version` 加 1
- 路段 id 从 OSM id 派生，重跑时保持稳定（T2 会用它存用户选的施工路段）

## 路人读数（api → engine）

D-0929-1435：大模型只「读懂」屏上的字，比例由引擎算。T5 在 `apps/api/public/js/reader.js` 导出 `readSigns(请求) → Promise<读数>`，引擎只调这一个函数。背后按顺序：随网页发布的答案文件 → `POST /api/read`（Cloudflare Worker，先查 KV）→ 大模型 → 任何一步失败都用关键词规则（`src: "rule"`）。

**请求**（一类人 × 一串标志）：

```json
{
  "persona": "commuter",
  "kmh": 40,
  "signs": [
    { "kind": "vms",  "frames": [["USE", "RUSSELL ST", "SAVE 8 MIN"]], "read_s": 9 },
    { "kind": "sign", "text": "RIGHT LANE CLOSED", "read_s": 3 }
  ],
  "roads": ["La Trobe St", "Russell St", "Elizabeth St"]
}
```

- `persona` ∈ `commuter / local / tourist / delivery`；`signs` 按经过的先后顺序；`read_s` 是引擎按「可读距离 ÷ 车速」算好的秒数，超过 120 按 120 算（排队时车速 5 km/h 会算出约 137 秒）
- `signs[].kind` ∈ `vms / sign / arrow`；`arrow`（箭头板）的 `text` 可以省；护栏 `barrier` 不进请求。路名字符和引擎的 `cleanName()` 一致（字母、数字、空格和 `. , ' & / ( ) -`）
- 请求不合规范时 `readSigns()` 抛 `SignError`（`.code` 是短码）。引擎把抛错记成 `prepare()` 的 `failed` 和 `evaluate` 结果的 `missing`（那一类人按「没人被说动」算），界面要显示出来；T2 在用户输入屏上文字时先用 `apps/api/public/js/check.js` 的 `checkSigns()` 挡住（不抛错，回 `{ ok, error?, warnings[] }`）
- `roads` = 当前路 + 候选绕行路的名字，只用来把「叫你走哪条」对到路名
- 请求里**没有**各条路的耗时和排队：读数只取决于「字 + 人」，所以同一句话每类人只问一次，缓存一直有效

**读数**：

```json
{
  "persona": "commuter",
  "notice": 0.85,
  "understand": 0.9,
  "advice": { "Russell St": "use", "La Trobe St": "avoid" },
  "saving_min": 8,
  "delay_min": null,
  "trust": 0.7,
  "why": "Sign says Russell saves 8 min and I'm late",
  "range": { "notice": [0.8, 0.9], "understand": [0.85, 0.95], "trust": [0.6, 0.75] },
  "src": "file",
  "model": "deepseek-flash",
  "prompt_v": "r2"
}
```

| 字段 | 含义 |
|---|---|
| `notice` | 这类人里注意到标志的比例，0–1 |
| `understand` | 注意到的人里看懂的比例，0–1 |
| `advice` | 标志叫你走（`use`）或别走（`avoid`）的路；没提到的路不出现 |
| `saving_min` / `delay_min` | 标志上说走推荐路能省几分钟 / 原路要多堵几分钟；没写就 `null` |
| `trust` | 看懂的人里相信这句话的程度，0–1 |
| `why` | 一句理由（英文，界面显示用 `textContent`） |
| `range` | 问 3 次的最小到最大；规则兜底时没有这个字段 |
| `src` | `file`（随网页发布的 `demo.json`）/ `kv`（Worker 的缓存：内存、KV 或 Cache API）/ `llm`（刚问的大模型）/ `rule`（关键词规则） |
| `model` | 大模型名（= Worker 变量 `LLM_MODEL`，例 `deepseek-flash`）；规则读数是 `"rules"` |
| `prompt_v` | 提示词版本（`apps/api/prompts.md`，例 `r2`）；规则读数是规则版本（例 `k1`） |
| `note` | 可选，只在 `POST /api/read` 的规则兜底时出现：为什么没用大模型的短码（例 `llm_fallback: 1/3 valid (timeout)`、`llm_rate_limited`）。`readSigns()` 会丢掉它，引擎看不到 |

- 引擎拿读数 + 每类人的参数算各条路的比例（选择模型和两点校准归 T4）；**大模型不回比例**
- 加字段随时可以；改名、删字段、改取值范围要开 `contract:` PR

## 施工方案（web → engine）

一条施工 = 一个对象，web 画出来交给引擎。存进登记表 `/api/worksites` 时原样用这个格式，另加登记表字段（见本节末「登记表字段」）。引擎侧见 `apps/engine/public/js/worksite.js` 开头。

```json
{
  "id": "A",
  "links": ["<network.json 的路段 id，按行车方向>"],
  "closes": { "lanes": 1, "footpath": "left" },
  "time": { "from": "2026-10-05", "to": "2026-10-09", "hours": [7, 19] },
  "equipment": [
    { "id": "vms1", "type": "vms", "at_m": 300, "frames": [["USE", "RUSSELL ST", "SAVE 4 MIN"]], "char_mm": 320 },
    { "id": "s1", "type": "sign", "at_m": 100, "text": "RIGHT LANE CLOSED", "dir": "W" }
  ]
}
```

- `links` 同方向连着的算一段；双向施工两个方向都列。`closes.lanes` ≥ 车道数 = 全封；没全封时剩下车道的通行能力再 × 0.9
- `closes.footpath`（T17，可选）∈ `left / right / both`：封哪一侧人行道。相对施工路段的行车方向，和 `walk.json` 的 `side` 同口径（靠左行驶，`left` = 挨着被封车道那边的路缘）；不写 / `null` / `"none"` = 人行道不封。别的值（`"LEFT"`、`"north"`、`1` …）`validatePlan()` 报错，`backend.run / advise` 抛 `code: "bad_plan"`（`.errors` 是每条原因；页面可先调 `be.validate(方案)` → 错误列表）。只影响行人（`summary.peds`），不改车的数字
- `time.hours` = 每天 `[开始, 结束)`；`equipment[].at_m` = 在施工起点上游多少米（负数 = 施工起点下游，如摆在施工段末端的 END ROADWORK；引擎只把 `at_m ≥ 0` 的牌交给读屏，下游的牌只进清单和租金）；`type` ∈ `vms / sign / arrow / barrier`（`barrier` 不进读数请求）；`dir` 可选，只给这个方向的车看
- 屏上文字（`frames`）：≤ 2 帧 × ≤ 4 行 × ≤ 10 字符、合计 ≤ 8 个词、大写（校验归 T5 / T2）
- 「什么时候」= `when: { date: "YYYY-MM-DD", hour: 0–23, day?: "wd" | "we" }`；`hour` 是 `flows.json` 的下标
- `equipment[].item`、`equipment[].qty`（#55，可选）：`item` = `apps/roads` 的 `equipment.json` 条目 id，`qty` = 件数（1–500），给报价和库存检查用（`apps/api/public/js/pack.js` 的 `quote()` / `stockCheck()`）；**引擎不看这两个字段**。不写时按类型和牌上的字自动对到库存条目，对不上的不算钱

登记表字段（#53，只加不改；细节和错误短码见 `apps/api/README.md`「施工登记表」）：

| 字段 | 谁给 | 说明 |
|---|---|---|
| `title` | 客户端 | ≤ 80 字，不许有 `< >` 和控制字符 |
| `kind` | 客户端 | `road / utility / building / event / other`，默认 `other` |
| `status` | 客户端 | `draft / assessed / decided / exported / withdrawn`，默认 `draft`；`decided` / `exported` 必须有 `decision`；没有删除，要撤就改成 `withdrawn` |
| `decision` | 客户端（`at` 由服务端盖） | `{ option, by: "contractor" \| "council", reason ≤ 280 字, at }` |
| `id` `seed` `created` `updated` | 服务端 | 客户端给的不算；白名单以外的字段一律丢掉 |

- `options[]`（D-0929-2011 ③，按库存出的 3 套方案）的形状见下一小节（T22）；登记表现在不存它，只存人选定后的 `decision.option`

### 按库存出方案 `options[]`（T22，v3.7，只加字段）

`be.options(施工 | 方案, { n = 3, when?, worksite? })`（`apps/engine/public/js/backend.js`）→ 一处施工配 3 套方案，每套都用引擎跑同一个小时。`options()` 本身不调大模型（引导那一帧用规则顾问的写法）；每套的读数走 `run()` 同一条读屏链（T5 答案文件 → `/api/read` → 规则），读数一样时结果逐字一样。演示前要把 `options()` 生成的屏上文字（END ROADWORK、FOOTPATH CLOSED、DETOUR AHEAD、引导帧等）预算进 T5 答案文件，否则正式环境会现场问 `/api/read`，数字也可能和规则读数不同。引擎侧见 `apps/engine/README.md`「按库存出方案」。

```json
{ "worksite": "B-12", "when": { "date": "2026-10-06", "hour": 8 }, "days": 5,
  "site": { "len_m": 43, "lanes": 2, "close_lanes": 1, "full": false, "footpath": "none" },
  "inventory": { "src": "fetched", "version": 1, "assumed": true },
  "options": [{
    "id": "o1", "label": "Minimum", "label_zh": "最省",
    "plan": { "when": {}, "worksites": [{ "…": "原施工，equipment 换成这一套；每件带 item + qty" }] },
    "hire": { "lines": [{ "item": "barrier_water", "name": "…", "qty": 22, "day_rate_aud": 4, "days": 5, "cost_aud": 440 }],
              "days": 5, "per_day_aud": 103, "total_aud": 515, "unpriced": [], "assumed": true, "note": "…" },
    "stock": { "ok": true, "short": [], "shared_with": [] },
    "result": { "queue_m": 918, "delay_min": 10493, "affected_min": 4354, "mean_delay_s": 509, "detour_share": 0.14, "routes": [], "transit": {}, "peds": {} },
    "flags": { "ok": true, "stock_ok": true, "vms_text_ok": null, "vms_read": null, "guided": false, "inactive": false, "no_faster_detour": false, "assumed": ["hire.day_rate_aud", "stock.qty"] },
    "vs": null
  }]
}
```

- `id` 固定 `o1` Minimum（护栏 + 静态标志，没有 VMS）/ `o2` Standard（+ 箭头板 + **两块** VMS 报延误、不点名路线，如「EXPECT / DELAYS ▸ 10 MIN」，N = 最省那套走原路每车多等的整分钟，另带 `delay: { min, frames }`，不到 1 分钟写「ROADWORK / AHEAD」、`flags.no_delay_min`；最贵）/ `o3` Guided（+ 箭头板 + **一块** VMS 点名引擎算出的最快绕行和省几分钟，另带 `guide: { frames, at_m, why }`；比 `o2` 少租一块 VMS）（T50）
- `plan` 是完整的 §施工方案 方案，可以直接交给 `run / compare`；每件设备带 `item`（`equipment.json` 的 id）和 `qty`，和 `equipment[].item / qty` 同口径
- `hire.assumed` 恒为 `true`：库存件数和日租价是假设值，界面要标「假设值」（D-0929-1536）；天数 = `time.from`–`time.to` 日历天数含两头
- 每种设备件数 + 同一份方案里时间重叠（`overlaps()`：日期和每天时段都有交集）的其他施工已经带的件数（按它们 `equipment[].item / qty` 数）≤ 库存；不够的只摆剩下的，缺口进 `stock.short[{ equipment, item, need, got, stock, why }]`，`flags.ok = false`；`stock.shared_with` = 共用库存的那些施工 id
- `flags.vms_read` = VMS 有没有进读数请求（T5 一次最多读离施工最近的 6 块，被挤掉就是 `false`，`flags.guided` 和 `flags.ok` 跟着 `false`）；`flags.inactive` = 这处施工在 `when` 那个小时不施工（数字都是 0，`flags.ok = false`）
- `vs` = 和 `o1` 比（后 − 前）：`{ id, delay_min, affected_min, queue_m, hire_aud }`；哪套更少堵以引擎结果为准，不保证 `o3` 最好
- 错误：方案不合格 / 有路段不在路网（哪怕只一条）/ 没 `time` 又没 `when` / `time.from`、`to` 不是真实日期或 `from` 晚于 `to` / `time.hours` 不是 `[开始, 结束)`（0 ≤ 开始 < 结束 ≤ 24）/ `when` 不是 `{ date, hour: 0–23 }` → `code: "bad_plan"`；库存取不到 → `code: "no_inventory"`

## evaluate（engine → web）

D-0929-1435 定稿（T9 骨架）。**网页只 import 接线层 `/engine/public/js/backend.js`**（D-0929-1540，lead 接好了路网 + 车流 + 参数 + T5 读屏）：

```js
const be = await (await import('/engine/public/js/backend.js')).connect();
const s = await be.run(方案);          // 能直接显示的数字：queue_m mean_delay_s routes by_type hot flags …；引擎原始结果（下表）在 s.raw
const c = await be.compare(前, 后);     // 前后对比，c.delta 负数 = 变好；be.advise(方案) 顾问改法；be.check(方案) 屏上文字规范
```

**叠加冲突 `be.clash` / `be.stagger`**（T21，v3.8，只加方法；D-0929-2011 ②）：

```js
const k = await be.clash(a, b, { hours?, when? });   // a、b = §施工方案的一条施工，或整份方案（取 worksites[0]）
// k = { a, b, ab, cost,                    // 显示用，永远 ≥ 0：D(A) / D(B) / D(A+B) / 冲突成本 D(A+B) − D(A) − D(B)，单位 车·分钟，按采样小时加总
//       raw: { a, b, ab, cost },           // 引擎原始数（可能 < 0）
//       whens, hours, truncated, overlap: { from, to, days },
//       flags: { reliable, negative_delay, substitutes, reading_src, failed } }
const g = await be.stagger(a, b, { maxDays = 7, hours?, back = false });
// g = { base: clash(a, b), best: { days, cost, ab, overlap_days, reliable }, tries: [{ days, cost, overlap_days, reliable }],
//       worksite: 挪好的 b, period: { from, to, whens, truncated, ab_before, ab_after, reliable, failed } }
```

- 时间窗 = 两处施工**重叠的那几天** × 重叠时段里的早晚高峰（8、17 点；都不在就取时段中间那个小时，和 `advise()` 同一口径）；`opts.hours` 换采样小时，`opts.when` 只算那一个时刻。不重叠 → 全 0、`whens = 0`，不跑引擎。两处施工都要写 `time`（或给 `when`），否则抛错
- 数由 `engine.conflict()` 算（下文「其他」），接线层不另写算法；同样输入同样结果
- 🔒 显示字段不出现负数，两种「≈ 0」分开标：`raw.a / raw.b / raw.ab` 有 < 0 的（基线车流本来就超过通行能力的路段，如 Flinders St，#58）→ `flags.negative_delay = true`、`flags.reliable = false`、`cost` 显示 0，页面写「≈ 0 · 这段路的基线车流超出通行能力，结果不可信」；三个 D 都 ≥ 0、只有 `raw.cost` < 0（同一走廊的两处施工互相替代）→ `flags.substitutes = true`、`cost` 显示 0、仍可信，页面写「≈ 0 · 两处施工在同一走廊，叠加不额外增加延误」
- 读屏有失败（`flags.failed > 0`，和 `compare` / `advise` 同一口径）→ `flags.reliable = false`；a、b 先过 `validate()`，不合格抛 `bad_plan`
- `stagger` 只挪 `b`：`+1 … +maxDays` 天（`back: true` 时 `+1, −1, +2, −2 …`），碰到第一个「不再重叠」或「冲突成本 0 且可信」就停；`best` 先取可信的尝试，同样可信时取冲突成本最小的（一样时取先试的），页面显示前看 `best.reliable`。`period` 是挪前、挪后在同一段时间（a、b、挪后的 b 从最早开工到最晚完工 × 采样小时）里的全网总延误 D(A+B)，同一把尺子比；`period.reliable` 要两个总和 ≥ 0、没有读屏失败、`base` 和 `best` 都可信
- 读数和 `run()` 走同一条读屏链（T5 答案文件 → `/api/read` → 规则）。登记表 3 条预置施工的屏上文字（`ROAD CLOSED` / `USE RUSSELL ST` / `RIGHT LANE CLOSED`）还不在 T5 答案文件里：正式环境 MOCK=0 时第 3 步一打开就会现场问 `/api/read`，数和规则读数算的（测试里 27,783）不一样。演示前要预算进答案文件，或在 pitch 里说明这个数用的是规则读数

**电车公交 `s.transit`**（T16，`apps/engine/public/js/transit.js`；`connect()` 同时读 `/roads/public/cbd/transit.json`，读不到不抛：`status().transit = "none"`、`status().errors` 记一条、`s.transit = { src: null }`；这一块算的时候抛错 → `{ src: null, error }`，车的数字照出；`opts.transit` 可以直接给）：

```js
s.transit = {
  src: 'gtfs' | null, day: 'wd' | 'we', hour,
  routes: [{ id, short, mode: 'tram' | 'bus', dir, headsign,
             trips_h, pax_per_trip, pax_h,          // 这个小时的车次（GTFS）、每趟人数（假设值）、乘客/小时
             delay_s, pax_min,                      // 每趟多的秒数（≥ 0）、乘客·分钟；停掉的（blocked）和路网外换路的（edge）都是 null
             diverted, blocked, edge,               // 公交全封要绕 / 电车全封停（公交在路网里绕不过去也算 blocked）/
                                                    // edge：全封在线路进出路网 400 米内、路网里绕不过去 → 在路网外换路，分钟数算不出，不算停运
             stops_closed: [{ id, name }],          // 在全封路段上的站
             links: [路段 id],                      // 这条线路变慢了或全封的路段
             detour_links: [路段 id], stops_skipped: [{ id, name }] }],  // 公交绕的路、绕开的站（没绕 = []）
  trips_h, pax_h, pax_min, blocked_routes, blocked_pax_h,   // 合计；pax_min 不含停掉的和 edge 的（≥ 0）
  edge_routes,                                              // edge 的线路数（不算进 blocked_routes / blocked_pax_h）
  assumed: { pax_per_trip: { tram, bus }, period: 'peak' | 'offpeak', range: { tram: [低, 高], bus: [低, 高] }, note },
}
c.delta.transit_pax_min   // 后 − 前（负数 = 变好）；任何一边没有公交数据 = null
```

- 只列「这个方向经过的路段被全封」或「整趟比没施工时慢 > 0.1 秒」、这个小时有车次的线路（有的路段因为车流绕走反而变快，整趟加起来不慢的不列）；排序：停掉的在前（按 `pax_h`），其余按 `pax_min` 从大到小，`edge` 的放最后（按 `pax_h`）
- 公交：跟车流走固定线路，每趟多的秒数 = 线路上每个路段（这个方案的通行时间 − 同一小时没施工时的通行时间）之和，都用引擎的 `linkTime`（不是 `links[].delay_s`，那是比自由流多的）。有路段全封 → 在封闭段前后 400 米内就近绕（最短路，先只走主干道，不走小巷；从哪拐出去、在哪回来按全程时间挑最快的），多的秒数 = 绕完的全程 − 平时全程，**最少记 0**（绕行跳过了线路上本来绕的一圈也不算「变快」：按时刻表跑，早到要等；跳过的站在 `stops_skipped`）
- 公交 `edge`：`transit.json` 的线路只截到 CBD 路网里；全封离线路进 / 出路网不到 400 米、路网里又绕不过去 → 公交在路网外就换路了：`diverted: true, edge: true`，`delay_s` / `pax_min` 为 `null`，不算停运。界面别显示成「+0 秒」，写「在地图外绕行」
- 电车：假设 CBD 电车走自己的车道，封部分车道不耽误电车（不列）；全封电车经过的路段 → `blocked`，只报停掉的车次和乘客，不编分钟数
- 每趟载客人数是**假设值**（D-0929-1536：界面标「假设值」+ 区间）：工作日 7–9、16–18 点高峰电车 60 / 公交 25，其余电车 30 / 公交 12；`assumed` 里给当时用的数和区间

字段表见 `docs/arch/T13-web-wiring-PRD.md` 第 5 节。下面是引擎核心的用法（接线层内部就是这么调的）：

```js
import { createEngine } from '/engine/public/js/index.js';
import { readSigns } from '/api/public/js/reader.js';        // T5 的；没好之前用 index.js 导出的 mockReadSigns
const engine = createEngine({ network, flows, readSigns, params });  // network / flows = /roads/public/cbd/ 的两个 JSON；params = await loadParams()（可省）
await engine.prepare(方案);                                   // 先把要的读数问好（异步，同一句话每类人只问一次，一直缓存）
const 结果 = engine.evaluate(方案, { seed });                 // 同步、纯计算，同样输入同样结果；真路网上约 7 毫秒
```

- `方案 = { when, worksites: [施工方案] }`；只有在 `when` 生效的施工才算
- 引擎向 `readSigns` 要的请求见 §路人读数：每段路每类人一份「全部标志」，另外每条绕行路线一份「拐口之前看得到的标志」（屏摆在拐口之后不算点名那条路）
- 还没问到的读数按「没人被说动」算，`结果.missing` 报缺几条；`prepare` 之后应为 0
- 比例由引擎的选择模型算：每类人参数（赶时间 · 熟路 · 信屏 · 怕堵 · 只能走货车路）在 `choice.js`；两个全局参数（绕行惯性 A、推荐力度 B）由两点校准定（ROADWORK / AHEAD → 3%，USE / RUSSELL ST → 20%，都［待核］），见 `结果.calib`
- 排队变长 → 引擎按「看得到的排队」自己重算选择（逐次平均 6 轮），不再问大模型
- 参数：`loadParams()` 读同源的 `/params/public/params.json`（T12），读不到、不合格逐项回退到假设值、不抛错；引擎认哪些字段见 `apps/engine/README.md`「参数」一节；`engine.params` = `{ src: params | default, version, mix, personas, anchors, used: { mix, anchors, persona.<类型>.<项> } 每项来源, ignored, errors, override }`，界面可以标「参数有出处 / 假设值」

**结果**（数字全由引擎算；单位：`*_min` = 这一小时比「没有施工」多出来的车·分钟；每车按 1 人算；公交电车乘客在接线层的 `s.transit`，见上）：

| 字段 | 含义 |
|---|---|
| `delay_min` | 全网总延误（veh·min） |
| `by_type[类型]` | `{ delay_min, vehicles, per_capita_min }`：每类人（commuter / local / tourist / delivery）的总延误和人均延误 |
| `others_min` | 没受影响、但被绕行车流拖慢的背景车流的延误 |
| `approaches[]` | 每段受影响的方向：`street dir to volume queue_m delay_min share routes[] by_type signs` |
| `approaches[].routes[]` | `{ id, name, usual_min, now_min, share, flow, truck, turn_m, extra_min }`；`id: "stay"` 是原路，`turn_m` = 在施工起点上游多少米拐出去 |
| `approaches[].by_type[类型]` | `{ share, detour, extra_min, informed, told[], reading }`：`informed` = 被标志说动的比例，`reading` = T5 给的读数（界面显示 `why`，用 `textContent`） |
| `links[]` | 每个路段 `{ id, v, cap, delay_s, queue_m, extra_min }`：流量 veh/h；`delay_s` = 比自由流多的秒数（不是比平时）；`queue_m` = 一小时末排队米数（绝对值，含平时就有的排队）；`extra_min`（T28 #79）= 这一小时比不施工多出的车·分钟，可 < 0，全部路段加起来 = `delay_min`。页面画「施工造成的变慢 / 排队」用 `extra_min`，不要用 `delay_s` 或 `queue_m > 0` |
| `hot[]` | 多出时间最多的 ≤ 5 个路段 |
| `blocked_vph` | 全封又无路可绕、卡住的车流（不算进 `delay_min`，界面单独标） |
| `calib` | `{ A, B, method: two_point | default, ok, target: { lo, hi }, lo_detour, hi_detour, src, model }`；`ok = false` = 两个目标至少有一个够不着 |
| `missing` | 还没问到的读数条数 |

**行人（T17，`summary.peds`）**：`backend.js` 的 `connect()` 另外在**后台**取 `/roads/public/cbd/walk.json` + `peds.json`（3.6 MB；也可以 `connect({ walk, peds })` 注入）。`connect()` 不等它们：刚连上时 `status().peds = "loading"`，取完变 `fetched / given / none`；`await be.pedsReady()` → 取完后的那个值。`run()` 只有在这个小时真的封了人行道时才等它们，最多 8 秒（`connect({ pedsWaitMs })` 可改）；没封 / 不在施工时段 = 不用数据、直接全 0。取不到、格式不对都不抛：`status().peds = "none"`，`summary.peds = { src: null, footpath }`；等超时 = `{ src: null, footpath, pending: true, error }`（下次 run 数据到了就有）；两种情况 `compare` 的 `delta.peds_extra_min = null`。拿到了时：

| 字段 | 含义 |
|---|---|
| `src` | `"peds"`；数据没加载上是 `null`（其余字段都没有） |
| `footpath` | 方案里声明封的人行道：`none / left / right / both`（不管这个小时在不在施工） |
| `active` | 这个小时有没有正在封人行道的施工；`false` 时下面的数字全是 0 |
| `day` `hour` | 用的是 `peds.json` 的哪一天类型（`wd / we`）、哪个小时 |
| `closed[]` `closed_m` | 封掉的人行道（`walk.json` 的 link id）和总长（米） |
| `ped_h` | 这一段封掉的人行道里这个小时人最多的那条（人/小时）；两侧都封时两侧加起来 |
| `detour_m` | 每人多走的米数 = 避开封闭段的最短路 − 平时最短路（两侧按人数加权） |
| `extra_min` | `ped_h × detour_m ÷ (walk_mps × 60)`，人·分钟 / 小时（和车的 `delay_min` 同口径）；等红灯没算 |
| `crossings` | 绕行路线上要过几条街（`kind = crossing` 或 `crossing` 非空）：连着的几段过街（安全岛把一条过街切成几段）算一次，除非前后两段是不同名字的街；两侧都封时取多的那侧 |
| `blocked` `blocked_ped_h` | 没路可绕（两头都连着像样的路网、中间被切断）；这些人不算进 `extra_min`，单独报人/小时（和 `blocked_vph` 一样） |
| `dead_end` | 封掉的人行道在 `walk.json` 里是死胡同（一头连不到别的人行道，或者只连着 < 60 个节点的小孤岛）：没有穿过去的人，不算绕行、**不算** `blocked`；`note` 写明 |
| `unmatched` `unmatched_sides[]` | 方案要封的那一侧在 `walk.json` 里一条人行道都找不到（`[{ worksite, side }]`）：这时 `closed = []`、数字是 0，但**不等于**「人行道照常通行」，页面要按 `unmatched` 区分；`note` 写明 |
| `note` `note_zh` | 上面两种情况的说明；正常时 `null` |
| `step_free` | 一律 `null`：`walk.json` 没有台阶 / 坡道数据，不判断轮椅能不能走 |
| `measured` `method` | 封掉的人行道里有没有真计数器实测的（`peds.json` 的 `method = sensor`）；`method` = `ped_h` 取的那条的来源 |
| `sensor` | 真计数器 `{ name, ped_h, id, dist_m, on_closed }`：先认装在封掉的人行道上的（`on_closed = true`）；否则要离封闭段 ≤ 40 米（`peds.json assumptions.sensor_m`）**而且在施工路段中心线的同一侧**（马路对面那条人行道上的不算）；都没有就 `null` |
| `detour[]` | 绕行路线（`walk.json` link id），一定不经过 `closed[]` |
| `stretches[]` | 每一段（施工 × 哪一侧 × 一串首尾相接、方向差 < 60° 的施工路段）的明细，字段同上加 `from / to / base_m / path_m / base_crossings / dead_end` |
| `assumed` | `{ walk_mps: 1.3, note, note_zh }`：步速是假设值；`note` 写明「数到的人都走完整段（上限）、不含等红灯、不判断无障碍」 |

- 右侧人行道：CBD 的双幅路（OSM 里两个方向是两条线，Lonsdale / La Trobe 都是）右边那条挂在对面那幅路上、记作它的 `left`，引擎按「同名、方向相反、40 米内」找对面那幅路，再取它的人行道里「和施工路段并排走了 ≥ min(5 米, 自身长度一半)」的那几条（按并排长度，不按中点；一条人行道只能整条封，所以 `closed_m` 可以比施工路段长）
- `compare` 的 `delta.peds_extra_min` = 后 − 前（负数 = 变好）

其他：`engine.window(worksites, whens)` 一段时间的总延误；`engine.conflict(a, b, { whens?, hours? })` → `{ a, b, ab, cost, overlap, whens, truncated }`，`cost = D(A+B) − D(A) − D(B)`（时段不重叠时正好是 0；默认采样每个施工时段里的 8 点、17 点，没有就取时段中间那个小时，最多 31 天）；`advise(engine, 方案, { askAdvisor })` 第 ⑦ 步，每个改法都重算、标 `better`（MOCK 顾问 `mockAdvise`）。

**AI 调用日志（v3.10，只加方法）**：`connect({ onAiLog?, aiLogMax? })` 把读屏函数包一层，每次调用记一条 `{ seq, t（ISO）, persona, signs, roads, kmh, read_s（每块屏几秒）, src, model, ms, reading, fallback?, error? }`：`src` 照读数给的（`file / kv / llm / rule`）；读屏抛普通错改用引擎规则时记 `src: "rule"` + `fallback`（原因），请求不合规范（`SignError`）记 `src: "error"` + `error`（code）、`reading: null`。只在内存里，环形最多 `AI_LOG_MAX = 200` 条；不多发请求、不改读数（引擎按「字 + 人」缓存，同一句话只问一次，也只记一次）。`be.aiLog()` → 全部记录（拷贝，时间顺序）；`be.onAiLog(fn)` → 每来一条调 `fn(记录)`，回退订函数（回调抛错不影响读数）；`be.readingsOf(summary)` → 这次 `run()` 主路段上每类人读到了什么 `{ when, worksite, entry, street, dir, personas: { <类型>: { signs（按经过顺序，远 → 近）, roads, kmh, reading, src, model, ms, t, fallback } | null } }`，不是 `run()` 出的 summary → `null`；`be.lastReadings()` = 最近一次 `run()` 的。网页第 3 步「AI 路人」和「AI 调用日志」用它们（`apps/web/src/js/9-ai.js`）

- 🔒 只支持同源：网页、`/engine/public/`、`/roads/public/`、`/api/*` 挂在同一个域名下
- 路段可选字段 `truck: false` = 禁货车（T3 现在没有这个字段，没有时禁货车不生效）

## HTTP API

| 方法 + 路径 | 请求 | 响应 | 负责模块 |
|---|---|---|---|
| `GET /api/health` | — | `{ "ok": true, "v": "<版本>", "mock": bool, "llm": { "mode": "rules"\|"llm", "model", "key": bool, "cache": "kv"\|"cache-api"\|"memory", "prompt_v", "explain_v", "provider", "budget": bool, "per_day": int, "per_min": int } }`（`explain_v` v3.9 加）；`key` 只说有没有，**永远不给值**；`register`（#53）= 登记表的 Durable Object 绑上没有；api 没绑上时 site 自己回 `{ ok, v, mock: true, api: false }` | api |
| `POST /api/read` | 同 §路人读数 的请求 | `{ "ok": true, "reading": <读数> }`（`src` 是 `llm / kv / rule`）；不合规范 400 `{ "ok": false, "error", "msg" }`；> 8KB（按字节）413 | api |
| `POST /api/create` | `{}` | `{ "code": "ABCDE" }` | api |
| `GET /api/worksites?from&to&status` | `from` / `to` 是 `YYYY-MM-DD`，和工期有交集就算 | `{ "ok": true, "register": "do"\|"seed", "n", "worksites": [施工] }`：预置 + 登记的，按开工日期排；DO 没绑或出错时 `register: "seed"`，只回预置的 | api |
| `POST /api/worksites` | §施工方案 + 登记表字段 | 201 `{ "ok": true, "worksite", "edit_token" }`；`edit_token` **只回这一次**，库里只存 SHA-256，页面自己存（localStorage） | api |
| `GET /api/worksites/<id>` | — | `{ "ok": true, "worksite" }`；没有 404 | api |
| `PATCH /api/worksites/<id>` | 请求头 `x-edit-token` + 要改的字段 | `{ "ok": true, "worksite" }`；合并后整份重新校验；token 不对 403 `bad_token`、预置的 403 `locked`、满 200 条 409、全局每天写 500 次 429 | api |
| `POST /api/explain` | `{ lang?, options: [{ id, label, metrics, per_capita_min?, flags? }] }`（1–5 套，数字从 `optionFromRun()` 转） | `{ "ok": true, "explain": { src, lang, options: [{ id, summary, pros, cons, hardest_hit, risks }], lean, decide, model?, prompt_v?, note? } }`（`src` 是 `llm / kv / rule`；`model` / `prompt_v` 只在 `llm / kv`；`note` 只在大模型兜底成规则时）；解读里的每个数都要能追溯到请求里的数，`hardest_hit` 和规则风险永远按引擎的数算；不合规范 400，> 8KB 413 | api |
| `GET /api/sumo/v1/health`、`POST /api/sumo/v1/runs`、`GET /api/sumo/v1/runs/<id>[/index.json \| /<情景>/manifest.json \| /<情景>/frames-NNN.json \| /frame?scenario&t]` | 同 `apps/web/tools/sumo/README.md` §接口 v1；POST 只收白名单字段，`demand_scale` 0.1–1.2、`clearance_s` 600–2400，body ≤ 2KB | 同 README（完成前读结果 409）；错误一律 `{ ok:false, error, msg }`：`sumo_off` 503（site 没绑 `SUMO`）、`sumo_down` 502（容器没响应）、`sumo_starting` 503、`sumo_rate` 429（每 IP 每分钟 3 次运行）、`sumo_busy` 429（同时 ≥ 2 个任务）、`not_found` 404、`too_big` 413；完成的 index / manifest / frames 可缓存一天 | sumo |
| 静态 `/sumo/public/baked/…` | — | 预跑结果：`baked.json`（目录：生成时间、来源、SUMO 版本、`generator_sha256`、预设和 15 个格点各自 complete / failed）+ `preset/`（seed 42 默认 4 种情景的 index / manifest / frames）+ `grid/<key>.json`（只有 index）；页面用它时**必须**标「预先跑好」 | sumo |
| 静态 `/sumo/public/js/sumo-client.js` | — | `createSumoClient()`（T40 加 `loadReal()` / `realManifest()` / `realChunk()` / `runReal()`，真实路网，失败回 `/sumo/public/real/`）：先试云端，连不上 / 限流 / 忙 / 超时 / 运行失败都回预跑结果；返回值带 `source: live \| baked` 和 `reason`，页面按它选文案（`labels`） | sumo |
| `POST /api/sumo/v1/runs` 带 `{"network":"real", "seed"?, "p_original"?, "p_ai"?, "scenarios"?}` | `p_*` 0–1（绕行比例，默认 0.14 / 0.53），`scenarios` ⊆ `baseline / original / ai`（默认全部） | 同上；结果目录格式 v2：`index.json`（情景列表、指标、假设）+ `<情景>/manifest.json`（车辆目录、`signal_heads`、分块、指标）+ `<情景>/frames-NNN.json`（每秒 `[i, lon×1e6, lat×1e6, 角度, 速度 cm/s]`、各信号机状态、施工排队 m）；位置是车身中心、经纬度，角度 0 = 正北顺时针 | sumo |
| 静态 `/sumo/public/real/…` | — | 真实路网 SUMO 预跑（同上 v2 格式，seed 42，三个情景）；页面第 2 步默认播放它，必须标「SUMO · 预先跑好」 | sumo |
| `POST /api/sumo/v1/runs` 带 `{"network":"real", "seed"?, "options": [{"id", "p"}], "frames"?}`（T49 方案模式） | `options` 1–5 个，`id` ∈ `A–E` 不重复，`p` 0–1（这个方案的绕行比例，页面用引擎读牌得出）；`frames` 默认 `false`；不能和 `p_original` / `p_ai` / `scenarios` 混用 | 同上 v2 目录，情景 = `baseline` + 每个方案一个 `opt-<id>`（封一条车道 + 这个 p，指标字段和 `original` / `ai` 一样）；p 相同的方案只跑一次，后面的照抄并带 `reused_from`；`frames:false` 时 `manifest.chunks` 为空、没有 `frames-NNN.json`；**没有预跑兜底**，`sumo-client.js` 的 `runOptions()` 失败回 `source:'none'` + `reason` | sumo |

- `llm.mode` 是 `llm` 只在 Worker 变量 `MOCK` 为 `"0"` **且**有 secret `LLM_API_KEY`；否则 `/api/read` 只用关键词规则、不发任何外部请求（`apps/api/tests/llm.test.mjs` 反向断言）
- `POST /api/explain` 开关同 `/api/read`，每个请求最多 1 次外部调用、预留 1 次（和读屏同一本账），兜底 `note` 另有 `llm_fallback: bad_json / invalid / empty / timeout / http_<码>`
- 真调用前还要向全局每日计数（Durable Object 绑定 `BUDGET`）预留 3 次：超了 `LLM_MAX_CALLS_PER_DAY`（`llm.per_day`）、没绑上或出错都不调用，读数回规则并带 `note`（`llm_daily_cap` / `llm_no_budget` / `llm_budget_error`）
- `llm.cache`：`kv` = 有 KV 绑定 `READINGS`（跨实例）；`cache-api` = Workers 自带的 Cache API（只在自己的域名上生效）；`memory` = 只有每个实例的内存缓存（`*.workers.dev` 上就是这个）
- `/api/*` 由 site 用服务绑定 `API` 转给 api Worker（`hackathon-api`，不开自己的 `workers.dev` 网址）；`/api/public/*` 是 `apps/api/public/` 的静态文件，不转发
- `/api/sumo` 和 `/api/sumo/*` 在上一条之前被 site 截走，经服务绑定 `SUMO` 转给 `hackathon-sumo`（不开自己的 `workers.dev` 网址），它再转进容器的 `/sumo/v1/*`；容器只开 1 个实例、会重启，重启后旧的运行 id 一律 404，页面要回预跑结果（D-0930-1700）

## WebSocket 消息（`/ws?room=<CODE>`）

| type | 方向 | 字段 |
|---|---|---|
| `join` | 客户端 → 服务端 | `token`, `nick` |
| `act` | 客户端 → 服务端 | `kind`, `payload` |
| `state` | 服务端 → 客户端 | `v`, `view`（按本人裁剪后的状态） |
| `err` | 服务端 → 客户端 | `msg` |

## 共享状态形状

```json
{
  "v": 12,
  "code": "ABCDE",
  "phase": "lobby",
  "members": [{ "id": "m1", "nick": "甲", "secret": "🔒只给本人" }],
  "log": []
}
```

- `v` 单调递增，客户端用它判断广播新旧
- 标 🔒 的字段必须按用户裁剪后再下发（`viewFor()`）

## 错误格式

`{ "ok": false, "error": "<机器可读短码>", "msg": "<给人看的中文>" }`，HTTP 状态码照 REST 常规。

## Mock

`MOCK=1` 时：`/api/health` 的 `mock` 为 true；前端 `/api/*` 不通时在本地用 `logic.js` 的 `reduce()` 跑同一套逻辑。fixtures 放各模块 `fixtures/`。

## 变更流程

开 `contract:` PR → lead 批准 → 群里通知依赖方 → 依赖方各自适配。**字段路径以实测为准**，别照文档猜。

## 变更记录（最新在上）

| 版本 | 时间 | 改了什么 | 谁 |
|---|---|---|---|
| v3.13 | 2026-09-30 | T40（D-0930-2200）§HTTP API：`POST /api/sumo/v1/runs` 加 `network:'real'`（情景 baseline / original / ai，结果格式 v2，经纬度）和静态 `/sumo/public/real/…`；`sumo-client.js` 加真实路网方法（只加字段 / 方法） | lead |
| v3.12 | 2026-09-30 | T37（D-0930-1700）§HTTP API 加 `/api/sumo/v1/*`（经 site → `hackathon-sumo` → 容器）和两处静态文件 `/sumo/public/baked/…`、`/sumo/public/js/sumo-client.js`（只加路径） | lead |
| v3.11 | 2026-09-30 | §引擎原始结果 `raw.links` 加 `extra_min`（T28 #79，只加字段）；`delay_s` 的说明改成「比自由流多」（原来误写「比平时多」），并写明 `queue_m` 是绝对值 | lead |
| v3.10 | 2026-09-29 | §evaluate 加 AI 调用日志（向后兼容，只加方法 / 可选参数）：`be.aiLog()` / `be.onAiLog(fn)` / `be.readingsOf(summary)` / `be.lastReadings()`，`connect({ onAiLog, aiLogMax })`；summary 字段不变 | lead |
| v3.9 | 2026-09-29 | D-0929-2307（向后兼容，只加字段 / 取值）：`POST /api/explain` 接上大模型，`src` 多了 `llm / kv`，另加可选 `model` / `prompt_v`（`llm / kv` 时）和 `note`（兜底时）；`/api/health` 的 `llm` 加 `explain_v` | lead |
| v3.8 | 2026-09-29 | T21（D-0929-2011 ②）§evaluate 加 `be.clash(a, b)` / `be.stagger(a, b)`：叠加冲突成本 D(A+B) − D(A) − D(B) 和一键错开，显示字段永远 ≥ 0、`flags.reliable`；只加方法 | lead |
| v3.7 | 2026-09-29 | T22（D-0929-2011 ③）§施工方案 加「按库存出方案 `options[]`」：`be.options()` 出 `o1 / o2 / o3` 三套方案，每套带引擎结果、租金（`hire.assumed = true`）、库存检查（不超库存）；只加字段。依赖 v3.6（#57）的 `equipment[].item / qty` | lead |
| v3.6 | 2026-09-29 | T24（D-0929-2011 ⑤，向后兼容，只加字段）：§施工方案加登记表字段（`title / kind / status / decision`，服务端 `id / seed / created / updated`，#53）和可选的 `equipment[].item / qty`（#55，引擎不看）；§HTTP API 加 `/api/worksites` 四个接口（#53）、`POST /api/explain`（#54），`/api/health` 加 `register`；`options[]` 等 T22 | lead |
| v3.5 | 2026-09-29 | T19 大模型接口留好（向后兼容，只加字段）：`/api/health` 加 `llm`（含每日上限 `budget` / `per_day` / `per_min`，`cache` ∈ `kv / cache-api / memory`）；读数说明 `src` / `model` / `prompt_v`，加可选 `note`；site 服务绑定 `API` → `hackathon-api` | lead |
| v3.4 | 2026-09-29 | §evaluate `summary.peds`（T17 复审）：`connect()` 不再等 walk / peds（`status().peds = loading`、`be.pedsReady()`、`pending`）；加 `dead_end`、`unmatched` / `unmatched_sides`、`note` / `note_zh`、`sensor.on_closed`；`crossings` 改按「过几条街」数；右侧人行道按并排长度选 | lead |
| v3.3 | 2026-09-29 | §施工方案加可选的 `closes.footpath`（`left / right / both`）和方案校验（`bad_plan`）；§evaluate 加 `summary.peds`（封人行道的行人绕行，T17）、`status().peds`、`compare` 的 `delta.peds_extra_min`；`connect()` 另取 `walk.json` / `peds.json`，取不到不抛 | lead |
| v3.2 | 2026-09-29 | §路网数据文件加 `transit.json`；§evaluate：接线层 `run()` 加 `summary.transit`（电车公交受影响的线路、乘客·分钟，T16），`compare()` 加 `delta.transit_pax_min`；只加字段 | lead |
| v3.1 | 2026-09-29 | §路人读数：`kind` 加 `arrow`、`read_s` 上限 120、路名字符、`SignError` 和 `failed` / `missing`（T5 #29 对齐引擎）；HTTP API 加 `POST /api/read`；§evaluate：网页只接 `backend.js`（D-0929-1540） | lead |
| v3 | 2026-09-29 | 加「施工方案」；「evaluate」定稿（createEngine / prepare / evaluate / conflict / advise 和结果字段，T9 骨架）；参数入口 `loadParams()` 读 T12 的 `params.json`，`calib.target` | lead |
| v2 | 2026-09-29 | 加「路人读数」（api → engine，D-0929-1435）和「evaluate」草案（engine → web） | lead |
| v1 | 2026-09-29 | 加「路网数据文件」一节（roads → engine、web）；HTTP / WS 节还是模板预置，T5 定了再改 | lead |
| v0 | 2026-09-26 | 模板预置：health / create / ws 骨架 | lead |
