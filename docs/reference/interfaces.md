# Interface reference

The interfaces between RippleTwin's modules: the static data files, the sign-reading call, the plan format, the engine API and the HTTP API. During the event this was the one document the five team members had to agree on before working in parallel; every module codes against it.

- **Version:** v3.15 (final, 11 October 2026). The [changelog](#changelog) lists every revision.
- **Origin:** everything is served from one origin. The web page, `/engine/public/`, `/roads/public/`, `/params/public/`, `/sumo/public/` and `/api/*` sit under the same host, so no endpoint sends CORS headers.
- **Field paths:** when this document and the code disagree, the code wins. Check against the tests named in each section.

> **Status after the event.** The SUMO container and its `hackathon-sumo` Worker were deleted after the hackathon, so `/api/sumo/*` now answers 502 `sumo_down`. Step 02 then plays the pre-computed (baked) replay in `/sumo/public/real/`, and step 04's per-plan SUMO cells show "—". The `LLM_API_KEY` secret was also removed, so `/api/health` reports `llm.mode: "rules"`: the 92 pre-computed LLM readings in `apps/api/public/answers/demo.json` still ship, and any other wording is read by keyword rules. Everything else in this document is live. See [Deployment](../architecture/deployment.md).

## Who calls whom

| Caller | Callee | Interface | Section |
|---|---|---|---|
| web | api | HTTP | [HTTP API](#http-api) |
| engine, web | roads | Static JSON files, published with the site (no runtime data API) | [Road data files](#road-data-files-roads--engine-web) |
| engine | api | `readSigns()` in the browser (backed by `POST /api/read`) | [Sign reading](#sign-reading-api--engine) |
| web | engine | `connect()` from `backend.js`, then `be.run(plan)` and friends | [Worksite plan](#worksite-plan-web--engine), [Engine API](#engine-api-engine--web) |
| web | api | Worksite register `worksites.js` (backed by `/api/worksites`), AI explanation `explain.js` (backed by `POST /api/explain`), execution pack `pack.js` (pure functions, no HTTP) | [Worksite plan](#worksite-plan-web--engine), [HTTP API](#http-api) |
| web | sumo | `createSumoClient()` from `sumo-client.js` (backed by `/api/sumo/v1/*`, falling back to static replays) | [HTTP API](#http-api), [SUMO results](#sumo-results-format-v2-real-network) |

## Road data files (roads → engine, web)

Built offline by `apps/roads/tools/` and committed under `apps/roads/public/cbd/`. Locally and in production they are read from `/roads/public/cbd/<file>`: the site Worker mounts every module's `public/` directory at `/<module>/public/`. Field details and how each file is built are in [`apps/roads/PRD.md`](../../apps/roads/PRD.md) §5 and [`apps/roads/PRD-2.md`](../../apps/roads/PRD-2.md); the checks are in [`apps/roads/tests/`](../../apps/roads/tests/). Sources and licences are in [Data sources](../data/sources.md).

| File | Top-level fields | Notes |
|---|---|---|
| `network.json` | `version, area, bbox[S,W,N,E], generated, sources, assumptions, nodes[], links[]` | Links are directed. `links[]`: `id, from, to, name, highway, len_m, lanes, speed_kmh, cap_vph, t0_s, tram, bike_lane, osm_way, geometry[[lat,lon]]`. `nodes[]`: `id, lat, lon, osm, signal` |
| `flows.json` | `version, unit="veh/h", period, days_used, sources, assumptions, days{wd,we}{link id: 24 values}, method{link id}, coverage{links, measured, estimated}` | Array index = hour of day. `method` ∈ `detector_map / site_split / street_interp / class_default` |
| `signals.json` | `version, sites[{site, name, type, lat, lon, node, dist_m}]` | `node` is the nearest node within 30 m, otherwise `null` |
| `transit.json` | `version, sources, service_dates{wd,we}, assumptions, routes[], stops[], coverage` | PTV GTFS trams and buses. `routes[]`: `id, mode (tram / bus), short, dirs[{dir, headsign, links[], stops[], trips{wd,we}[24], offnet_m, geometry}]`; `links` are the matched link ids (sampled every 10 m, so very short links inside junctions can be missing). `stops[]`: `id, name, lat, lon, mode, road_link, routes[]`. Read by the engine's `transit.js` |
| `walk.json` | `version, area, bbox, sources, assumptions, nodes[{id, lat, lon}], links[]` | Footpath network (undirected). `links[]`: `id, a, b, len_m, kind (sidewalk / other / path / crossing / mall), crossing (null / signal / uncontrolled / zebra), road_link, side (left / right / null), geometry`. `side` is relative to the direction of travel on `road_link` |
| `peds.json` | `version, unit="ped/h", period, days{wd,we}{walk link id: 24 values}, method{walk link id}, sensors[{id, name, lat, lon, walk_link, road_link}], coverage` | `method` ∈ `sensor / street_interp / class_default`; only `sensor` is measured |
| `buildings.json` | `version, area, bbox, generated, sources, assumptions, buildings[]` | `buildings[]`: `id, name, use, height_m, levels, height_src, footprint[[lat,lon]], frontage[{link, dist_m}]`. Read by the web map |
| `equipment.json` | `version, sources, categories, effects, items[]` | Equipment catalogue: `items[]` carry `id, category, name, effect`, specifications, `qty, day_rate_aud, assumed[], url`. `qty` and `day_rate_aud` are assumptions. The VMS `chars_per_line` (10) must match the sign-text limit of `readSigns()`. Read by the engine's `options()` and by `pack.js` |
| `vectormap.json` | `version, area, bbox, generated, zoom, tile_source, sources, assumptions, polygons[{kind, polys}], lines[{kind, pts}]` | Basemap layers (water, green space, land use, rail and tram lines) in lat/lon, decoded from vector tiles at build time. Read by the web map; the page never contacts the tile server |
| `weather_hourly.json`, `weather_backtest.json` | — | Offline weather back-test only; no application code reads them. See [Assumptions and validation](../data/assumptions-and-validation.md#weather-back-test) |

- New fields can be added at any time. Renaming or removing a field, or changing a unit, is a breaking change: bump the file's `version` and follow [Changing an interface](#changing-an-interface).
- Link ids are derived from OSM ids and stay stable across rebuilds, because worksite plans store them.

## Sign reading (api → engine)

Decision D-0929-1435: the LLM only *reads* the words on a sign; the engine computes every share. The api module exports `readSigns(request) → Promise<reading>` from `apps/api/public/js/reader.js`, and the engine calls nothing else. Behind it, in order: the answers file shipped with the site → `POST /api/read` (Cloudflare Worker, cache first) → LLM → keyword rules (`src: "rule"`) if any step fails.

**Request** (one road-user type × an ordered list of signs):

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

- `persona` ∈ `commuter / local / tourist / delivery`. `signs` are in the order the driver passes them. `read_s` is the reading time the engine computes as legible distance ÷ speed; values above 120 are capped at 120 (a queue at 5 km/h gives about 137 s).
- `signs[].kind` ∈ `vms / sign / arrow`. An arrow board (`arrow`) may omit `text`. Barriers are never part of a request. Road names use the same characters as the engine's `cleanName()`: letters, digits, spaces and `. , ' & / ( ) -`.
- Limits (`LIMITS` in `apps/api/public/js/signs.js`): at most 8 signs and 8 roads; a VMS has at most 2 frames × 4 lines × 10 characters and 8 words in total; a static sign or arrow board message is at most 40 characters; `kmh` is 0–130.
- An invalid request makes `readSigns()` throw `SignError` (`.code` is a short machine-readable code). The engine records the throw as `failed` in `prepare()` and as `missing` in the result, counting that road-user type as "nobody persuaded", and the page must show it. While the user is typing sign text, the web page checks it first with `checkSigns()` from `apps/api/public/js/check.js`, which never throws and returns `{ ok, error?, warnings[] }`.
- `roads` = the current road plus the candidate detours. They are used only to map "which road the sign sends you to" onto road names.
- The request deliberately carries **no** travel times or queues: a reading depends only on the words and the reader, so each wording is asked once per road-user type and the cached reading stays valid.

**Reading**:

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

| Field | Meaning |
|---|---|
| `notice` | Share of this road-user type who notice the sign, 0–1 |
| `understand` | Share of those who noticed it who understand it, 0–1 |
| `advice` | Roads the sign tells you to take (`use`) or avoid (`avoid`); roads it does not mention are absent |
| `saving_min` / `delay_min` | Minutes the sign says the recommended road saves / the current road adds; `null` if the sign gives no number |
| `trust` | How far those who understood it believe it, 0–1 |
| `why` | A one-sentence reason (English; the page renders it with `textContent`) |
| `range` | Minimum to maximum over 3 samples; absent on rule readings |
| `src` | `file` (the shipped `demo.json`) / `kv` (the Worker's cache: memory, KV or Cache API) / `llm` (a fresh LLM call) / `rule` (keyword rules) |
| `model` | LLM model name (= Worker variable `LLM_MODEL`, e.g. `deepseek-flash`); `"rules"` for rule readings |
| `prompt_v` | Prompt version (`apps/api/prompts.md`, e.g. `r2`); for rule readings, the rule version (e.g. `k1`) |
| `note` | Optional; only on a rule fallback from `POST /api/read`: a short code saying why the LLM was not used (e.g. `llm_fallback: 1/3 valid (timeout)`, `llm_rate_limited`). `readSigns()` drops it, so the engine never sees it |

- The engine combines the reading with each road-user type's parameters to compute route shares (choice model and two-point calibration, see [Traffic engine](../architecture/engine.md)). **The LLM never returns shares.**
- New fields can be added at any time; renaming or removing a field, or changing a value range, is a breaking change.

## Worksite plan (web → engine)

One worksite is one object, drawn by the web page and handed to the engine. The worksite register (`/api/worksites`) stores exactly this format plus the register fields listed at the end of this section. The engine side is documented at the top of `apps/engine/public/js/worksite.js`.

```json
{
  "id": "A",
  "links": ["<network.json link ids, in the direction of travel>"],
  "closes": { "lanes": 1, "footpath": "left" },
  "time": { "from": "2026-10-05", "to": "2026-10-09", "hours": [7, 19] },
  "equipment": [
    { "id": "vms1", "type": "vms", "at_m": 300, "frames": [["USE", "RUSSELL ST", "SAVE 4 MIN"]], "char_mm": 320 },
    { "id": "s1", "type": "sign", "at_m": 100, "text": "RIGHT LANE CLOSED", "dir": "W" }
  ]
}
```

- Consecutive `links` in the same direction form one stretch; works in both directions list both directions. `closes.lanes` ≥ the link's lane count is a full closure; on a partial closure the remaining lanes' capacity is further multiplied by 0.9.
- `closes.footpath` (optional) ∈ `left / right / both`: which footpath is closed, relative to the direction of travel on the works links and with the same meaning as `side` in `walk.json` (traffic keeps left, so `left` is the kerb next to the closed lane). Absent, `null` or `"none"` means the footpath stays open. Any other value (`"LEFT"`, `"north"`, `1` …) fails `validatePlan()`, and `backend.run / advise` throw `code: "bad_plan"` with `.errors` listing each reason (the page can call `be.validate(plan)` first to get the list). It affects pedestrians only (`summary.peds`), not the vehicle numbers.
- `time.hours` = each day's `[start, end)`. `equipment[].at_m` = metres upstream of the start of the works (negative = downstream, e.g. an END ROADWORK sign at the far end; only signs with `at_m ≥ 0` are sent for reading, downstream ones only count towards the equipment list and hire cost). `type` ∈ `vms / sign / arrow / barrier` (barriers are never read). `dir` is optional and limits a sign to traffic in that direction.
- VMS text (`frames`): at most 2 frames × 4 lines × 10 characters, at most 8 words in total, upper case (validated by `signs.js` and the page).
- "When" = `when: { date: "YYYY-MM-DD", hour: 0–23, day?: "wd" | "we" }`; `hour` indexes the 24 values in `flows.json`.
- `equipment[].item` and `equipment[].qty` (optional): `item` is an `equipment.json` item id and `qty` a count (1–500), used for the hire quote and stock check (`quote()` / `stockCheck()` in `apps/api/public/js/pack.js`). **The engine ignores both fields.** Without them, items are matched to the catalogue by type and sign text; unmatched items are not priced.

Register fields (additive only; details and error codes in [`apps/api/README.md`](../../apps/api/README.md#worksite-register)):

| Field | Set by | Rules |
|---|---|---|
| `title` | Client | ≤ 80 characters; no `<`, `>` or control characters |
| `kind` | Client | `road / utility / building / event / other`, default `other` |
| `status` | Client | `draft / assessed / decided / exported / withdrawn`, default `draft`. `decided` and `exported` require a `decision`. There is no delete: set `withdrawn` instead |
| `decision` | Client (`at` is stamped by the server) | `{ option, by: "contractor" \| "council", reason ≤ 280 characters, at }` |
| `id` `seed` `created` `updated` | Server | Client values are ignored; fields outside the whitelist are dropped |

- The register does not store `options[]` (next section), only the `decision.option` someone chose.

### Equipment options: `options[]`

`be.options(worksite | plan, { n = 3, when?, worksite? })` in `apps/engine/public/js/backend.js` builds three equipment plans for one worksite and runs each through the engine for the same hour. `options()` itself never calls the LLM (the guidance frame uses the rule-based advisor's wording); each plan's signs are read through the same chain as `run()`, so identical readings give identical results. Wordings that `options()` generates (END ROADWORK, FOOTPATH CLOSED, DETOUR AHEAD, the guidance frame and so on) get an LLM reading only if they are in the shipped answers file; otherwise they go to `/api/read`, which since the event answers with keyword rules, so the numbers can differ from LLM-read ones. Engine details are in [`apps/engine/README.md`](../../apps/engine/README.md).

```json
{ "worksite": "B-12", "when": { "date": "2026-10-06", "hour": 8 }, "days": 5,
  "site": { "len_m": 43, "lanes": 2, "close_lanes": 1, "full": false, "footpath": "none" },
  "inventory": { "src": "fetched", "version": 1, "assumed": true },
  "options": [{
    "id": "o1", "label": "Minimum", "label_zh": "…",
    "plan": { "when": {}, "worksites": [{ "…": "the original worksite with this kit's equipment; every item carries item + qty" }] },
    "hire": { "lines": [{ "item": "barrier_water", "name": "…", "qty": 22, "day_rate_aud": 4, "days": 5, "cost_aud": 440 }],
              "days": 5, "per_day_aud": 103, "total_aud": 515, "unpriced": [], "assumed": true, "note": "…" },
    "stock": { "ok": true, "short": [], "shared_with": [] },
    "result": { "queue_m": 918, "delay_min": 10493, "affected_min": 4354, "mean_delay_s": 509, "detour_share": 0.14, "routes": [], "transit": {}, "peds": {} },
    "flags": { "ok": true, "stock_ok": true, "vms_text_ok": null, "vms_read": null, "guided": false, "inactive": false, "no_faster_detour": false, "assumed": ["hire.day_rate_aud", "stock.qty"] },
    "vs": null
  }]
}
```

- The ids are fixed (final revision of 1 October 2026):
  - `o1` Minimum: barriers and static signs, no VMS.
  - `o2` Standard: adds an arrow board and **two** VMS that announce the delay without naming a route, e.g. `EXPECT / DELAYS ▸ 10 MIN`. N is the whole number of minutes each vehicle loses on the original route under the Minimum kit; the option also carries `delay: { min, frames }`. Under one minute the text is `ROADWORK / AHEAD` and `flags.no_delay_min` is set. This is the most expensive kit.
  - `o3` Guided: adds an arrow board and **one** VMS that names the fastest detour the engine found and the minutes it saves; the option also carries `guide: { frames, at_m, why }`. It hires one VMS fewer than `o2`.
  - The page labels them A, B and C.
- `plan` is a complete [worksite plan](#worksite-plan-web--engine) that can go straight to `run / compare`. Every item carries `item` (an `equipment.json` id) and `qty`, with the same meaning as `equipment[].item / qty`.
- `hire.assumed` is always `true`: stock counts and day rates are assumptions, and the page must label them so (decision D-0929-1536). Days = calendar days from `time.from` to `time.to`, inclusive.
- For each item, the count in this plan plus the counts already held by other worksites in the same plan whose times overlap (`overlaps()`: both the dates and the daily hours intersect; counted from their `equipment[].item / qty`) must not exceed stock. When stock runs short, only what is left is placed, the shortfall goes into `stock.short[{ equipment, item, need, got, stock, why }]` and `flags.ok = false`. `stock.shared_with` lists the worksites sharing the stock.
- `flags.vms_read` says whether the VMS made it into the reading request (the reader takes at most the 6 signs nearest the works; if the VMS is crowded out, `vms_read`, `flags.guided` and `flags.ok` are `false`). `flags.inactive` means the works are not active at the `when` hour (all numbers 0, `flags.ok = false`).
- `vs` = the difference from `o1` (after − before): `{ id, delay_min, affected_min, queue_m, hire_aud }`. Which plan queues least is whatever the engine says; `o3` is not guaranteed to be best.
- Errors: an invalid plan, any link not in the network, no `time` and no `when`, `time.from` / `to` not real dates or `from` after `to`, `time.hours` not `[start, end)` with 0 ≤ start < end ≤ 24, or `when` not `{ date, hour: 0–23 }` → `code: "bad_plan"`. Inventory cannot be loaded → `code: "no_inventory"`.

## Engine API (engine → web)

Settled by decision D-0929-1435. **The web page imports only the wiring layer, `/engine/public/js/backend.js`** (decision D-0929-1540), which loads the road network, flows, parameters and the sign reader for it:

```js
const be = await (await import('/engine/public/js/backend.js')).connect();
const s = await be.run(plan);           // display-ready numbers: queue_m, mean_delay_s, routes, by_type, hot, flags …; the raw engine result (table below) is s.raw
const c = await be.compare(before, after);  // c.delta: negative = better. Also be.advise(plan) for advisor fixes, be.check(plan) for sign-text rules
```

`connect()` returns `{ engine, run, compare, advise, check, validate, options, clash, stagger, status, pedsReady, aiLog, onAiLog, readingsOf, lastReadings, demo, demos }`. It never throws except when the road network or flows cannot be loaded: parameters fall back to built-in assumptions, the sign reader to the engine's keyword rules and transit to "not computed", and `status()` reports what each part is using. The summary fields (`street, approaches, main, routes, detour_share, queue_m, vehicles, mean_delay_s, by_type, why, hot, blocked_vph, active, transit, peds, flags, raw` …) and how the page uses them are described in the archived wiring spec, [`docs/hackathon/specs/T13-web-wiring-PRD.md`](../hackathon/specs/T13-web-wiring-PRD.md) §5, and in the header of `backend.js`.

### Overlapping works: `be.clash` and `be.stagger`

Added in v3.8 (decision D-0929-2011):

```js
const k = await be.clash(a, b, { hours?, when? });   // a, b = one worksite (see Worksite plan) or a whole plan (worksites[0] is used)
// k = { a, b, ab, cost,                    // for display, never negative: D(A) / D(B) / D(A+B) / clash cost D(A+B) − D(A) − D(B), vehicle-minutes summed over the sampled hours
//       raw: { a, b, ab, cost },           // raw engine numbers (can be < 0)
//       whens, hours, truncated, overlap: { from, to, days },
//       flags: { reliable, negative_delay, substitutes, reading_src, failed } }
const g = await be.stagger(a, b, { maxDays = 7, hours?, back = false });
// g = { base: clash(a, b), best: { days, cost, ab, overlap_days, reliable }, tries: [{ days, cost, overlap_days, reliable }],
//       worksite: the shifted b, period: { from, to, whens, truncated, ab_before, ab_after, reliable, failed } }
```

- The window is the **days on which the two worksites overlap** × the morning and evening peaks (08:00 and 17:00) within the overlapping hours; if neither peak falls inside, the middle hour is used (the same rule as `advise()`). `opts.hours` changes the sampled hours; `opts.when` evaluates that single moment. No overlap → all zeros, `whens = 0`, and the engine is not run. Both worksites need a `time` (or pass `when`), otherwise it throws.
- The numbers come from `engine.conflict()` (see [Other engine functions](#other-engine-functions)); the wiring layer adds no algorithm of its own, and the same inputs give the same result.
- Display fields are never negative, and two kinds of "≈ 0" are flagged separately:
  - If any of `raw.a / raw.b / raw.ab` is below 0 (links whose baseline flow already exceeds capacity, such as Flinders St), then `flags.negative_delay = true`, `flags.reliable = false` and `cost` shows 0. The page says "≈ 0 · baseline flow on this street exceeds capacity; result not reliable".
  - If all three D values are ≥ 0 and only `raw.cost` is below 0 (two worksites on one corridor substitute for each other), then `flags.substitutes = true`, `cost` shows 0 and the result is still reliable. The page says "≈ 0 · both worksites are on one corridor; overlapping adds no delay".
- Any failed sign reading (`flags.failed > 0`, counted the same way as in `compare` and `advise`) sets `flags.reliable = false`. `a` and `b` are validated first and invalid input throws `bad_plan`.
- `stagger` moves only `b`: `+1 … +maxDays` days (with `back: true`: `+1, −1, +2, −2 …`). It stops at the first try that no longer overlaps, or whose clash cost is 0 and reliable. `best` prefers reliable tries, then the lowest clash cost, then the earliest try; the page should check `best.reliable` before showing it. `period` compares total network delay D(A+B) before and after the shift over the same span (earliest start to latest end of a, b and the shifted b, × the sampled hours), so both sides use the same yardstick. `period.reliable` needs both totals ≥ 0, no failed readings, and both `base` and `best` reliable.
- Readings use the same chain as `run()` (answers file → `/api/read` → rules). The answers file holds only the pre-computed demo requests; any other request, such as the signs of the register's seed worksites, is read by `/api/read`, which since the event answers with keyword rules. Clash numbers for those worksites are therefore rule-based.

### Trams and buses: `s.transit`

`apps/engine/public/js/transit.js`. `connect()` also loads `/roads/public/cbd/transit.json`. If that fails it does not throw: `status().transit = "none"`, `status().errors` gets an entry and `s.transit = { src: null }`. If the transit calculation throws, the result is `{ src: null, error }` and the vehicle numbers are still returned. `opts.transit` can supply the data directly.

```js
s.transit = {
  src: 'gtfs' | null, day: 'wd' | 'we', hour,
  routes: [{ id, short, mode: 'tram' | 'bus', dir, headsign,
             trips_h, pax_per_trip, pax_h,          // trips this hour (GTFS), riders per trip (assumed), riders per hour
             delay_s, pax_min,                      // extra seconds per trip (≥ 0), rider-minutes; null for blocked and edge routes
             diverted, blocked, edge,               // bus detoured around a full closure / tram stopped by a full closure (a bus with no in-network detour is also blocked) /
                                                    // edge: full closure within 400 m of where the route enters or leaves the network, with no in-network detour → it reroutes outside the map; minutes unknown, not counted as cancelled
             stops_closed: [{ id, name }],          // stops on fully closed links
             links: [link id],                      // links where this route slowed down or is fully closed
             detour_links: [link id], stops_skipped: [{ id, name }] }],  // the bus detour and the stops it skips ([] when there is no detour)
  trips_h, pax_h, pax_min, blocked_routes, blocked_pax_h,   // totals; pax_min excludes blocked and edge routes (≥ 0)
  edge_routes,                                              // number of edge routes (not included in blocked_routes / blocked_pax_h)
  assumed: { pax_per_trip: { tram, bus }, period: 'peak' | 'offpeak', range: { tram: [low, high], bus: [low, high] }, note },
}
c.delta.transit_pax_min   // after − before (negative = better); null if either side has no transit data
```

- Only routes with trips this hour whose links in this direction are fully closed, or whose whole trip is more than 0.1 s slower than without works, are listed. Some links get faster because traffic diverts away, so routes that are not slower overall are left out. Order: blocked routes first (by `pax_h`), then by `pax_min` descending, edge routes last (by `pax_h`).
- Buses follow their fixed route with general traffic. Extra seconds per trip = the sum over the route's links of (travel time with this plan − travel time in the same hour without works), both from the engine's `linkTime` (not `links[].delay_s`, which is relative to free flow). If a link is fully closed, the bus detours locally within 400 m either side of the closure: shortest path, arterials first, no lanes, choosing the turn-off and rejoin points by total trip time. Extra seconds = detoured trip − normal trip, **with a floor of 0**. A detour that skips a loop of the route does not count as faster, because a timetabled bus that arrives early waits; the skipped stops are listed in `stops_skipped`.
- Bus `edge`: routes in `transit.json` are clipped to the CBD network. If a full closure is less than 400 m from where the route enters or leaves the network and there is no detour inside the network, the bus would reroute outside the map: `diverted: true, edge: true`, `delay_s` / `pax_min` are `null`, and the route is not counted as cancelled. The page must not show this as "+0 s"; it says "detours outside the map".
- Trams: CBD trams are assumed to run in their own lanes, so a partial lane closure does not delay them (not listed). A full closure on a tram link makes the route `blocked`; only the cancelled trips and riders are reported, with no invented minutes.
- Riders per trip are **assumptions** (decision D-0929-1536: labelled "assumed" with a range on the page). Weekday peak hours 7–9 and 16–18 (`TRANSIT_PEAK_HOURS`, i.e. 07:00–10:00 and 16:00–19:00): tram 60, bus 25; other hours: tram 30, bus 12. `assumed` carries the values used and their range.

### Engine core

What the wiring layer does internally:

```js
import { createEngine } from '/engine/public/js/index.js';
import { readSigns } from '/api/public/js/reader.js';        // index.js also exports mockReadSigns, used as a fallback and in tests
const engine = createEngine({ network, flows, readSigns, params });  // network / flows = the two JSON files in /roads/public/cbd/; params = await loadParams() (optional)
await engine.prepare(plan);                                   // fetch every reading the plan needs (async; each wording once per road-user type, cached)
const result = engine.evaluate(plan, { seed });               // synchronous and pure: same input, same result; a few milliseconds on the real network
```

- `plan = { when, worksites: [worksite] }`; only worksites active at `when` count.
- The requests the engine sends to `readSigns` are described in [Sign reading](#sign-reading-api--engine): for each stretch and road-user type, one request with every sign, plus one per detour route with only the signs visible before its turn-off (a VMS placed after the turn-off does not count as naming that road).
- Readings not yet fetched count as "nobody persuaded" and `result.missing` reports how many; after `prepare()` it should be 0.
- Shares come from the engine's choice model. The per-type parameters (hurry, route familiarity, sign trust, queue aversion, trucks-only) are in `choice.js`. Two global parameters, detour inertia A and recommendation strength B, are set by two-point calibration: `ROADWORK / AHEAD` → 3 % detour (a working assumption) and `USE / RUSSELL ST` → 20 % (Erke, Sagberg & Hagman, 2007). See `result.calib`.
- As queues grow, the engine recomputes the choice from the queue drivers can see (6 rounds of successive averages) without asking the LLM again.
- Parameters: `loadParams()` reads `/params/public/params.json` from the same origin. If it is missing or invalid, each item falls back to the built-in assumption and nothing throws. Which fields the engine reads is listed in the "Parameters" section of [`apps/engine/README.md`](../../apps/engine/README.md). `engine.params` = `{ src: params | default, version, mix, personas, anchors, used: { mix, anchors, persona.<type>.<item> } (source of each item), ignored, errors, override }`, so the page can label each number "sourced" or "assumed".

### Result fields

All numbers are computed by the engine. Units: `*_min` = extra vehicle-minutes in this hour compared with the same hour without works; each vehicle counts as one person. Tram and bus riders are in the wiring layer's `s.transit` (above).

| Field | Meaning |
|---|---|
| `delay_min` | Total network delay (veh·min) |
| `by_type[type]` | `{ delay_min, vehicles, per_capita_min }`: total and per-vehicle delay for each road-user type (commuter / local / tourist / delivery) |
| `others_min` | Delay to background traffic that is not on the works approach but is slowed by diverted traffic |
| `approaches[]` | Each affected direction: `street dir to volume queue_m delay_min share routes[] by_type signs` |
| `approaches[].routes[]` | `{ id, name, usual_min, now_min, share, flow, truck, turn_m, extra_min }`; `id: "stay"` is the original route, `turn_m` = metres upstream of the works where the route turns off |
| `approaches[].by_type[type]` | `{ share, detour, extra_min, informed, told[], reading }`: `informed` = share persuaded by the signs, `reading` = the reading from `readSigns()` (render `why` with `textContent`) |
| `links[]` | Per link `{ id, v, cap, delay_s, queue_m, extra_min }`: flow in veh/h; `delay_s` = seconds above free flow (not above normal); `queue_m` = queue length in metres at the end of the hour (absolute, including any normal queue); `extra_min` = extra veh·min in this hour compared with no works, can be < 0, and sums over all links to `delay_min`. To draw slowdowns or queues caused by the works, use `extra_min`, not `delay_s` or `queue_m > 0` |
| `hot[]` | Up to 5 links with the most extra time |
| `blocked_vph` | Traffic stuck at a full closure with no detour (not included in `delay_min`; the page shows it separately) |
| `calib` | `{ A, B, method: two_point \| default, ok, target: { lo, hi }, lo_detour, hi_detour, src, model }`; `ok = false` means at least one target could not be reached |
| `missing` | Number of readings not yet fetched |

### Pedestrians: `summary.peds`

`connect()` also fetches `/roads/public/cbd/walk.json` and `peds.json` **in the background** (3.6 MB together; they can also be injected with `connect({ walk, peds })`). `connect()` does not wait for them: right after connecting `status().peds = "loading"`, which becomes `fetched / given / none`; `await be.pedsReady()` resolves to that final value. `run()` waits for them only when a footpath is actually closed in that hour, for at most 8 s (`connect({ pedsWaitMs })`); with no footpath closure, or outside the works hours, no data is needed and every number is 0. A failed fetch or bad format never throws: `status().peds = "none"` and `summary.peds = { src: null, footpath }`. A timeout gives `{ src: null, footpath, pending: true, error }` (the next run will have the data). In both cases `compare` returns `delta.peds_extra_min = null`. With data:

| Field | Meaning |
|---|---|
| `src` | `"peds"`; `null` if the data did not load (then no other fields) |
| `footpath` | The footpath closure declared in the plan: `none / left / right / both` (whether or not the works are active this hour) |
| `active` | Whether any worksite is closing a footpath this hour; if `false`, every number below is 0 |
| `day` `hour` | The `peds.json` day type (`wd / we`) and hour used |
| `closed[]` `closed_m` | Closed footpath links (`walk.json` link ids) and their total length in metres |
| `ped_h` | Pedestrians per hour on the busiest closed footpath; both sides added together when both are closed |
| `detour_m` | Extra metres walked per person = shortest path avoiding the closure − normal shortest path (both sides weighted by pedestrian volume) |
| `extra_min` | `ped_h × detour_m ÷ (walk_mps × 60)`, person-minutes per hour (same basis as the vehicle `delay_min`); waiting at signals is not included |
| `crossings` | Streets crossed on the detour (`kind = crossing` or non-null `crossing`). Consecutive crossing segments (a refuge island splits one crossing into several) count once unless they belong to differently named streets; with both sides closed, the larger count |
| `blocked` `blocked_ped_h` | No detour exists (both ends connect to the wider network but the closure cuts them apart); these people are not in `extra_min` and are reported separately in people per hour (like `blocked_vph`) |
| `dead_end` | The closed footpath is a dead end in `walk.json` (one end does not connect to other footpaths, or only to a small island of fewer than 60 nodes): nobody walks through, so there is no detour and it is **not** `blocked`; explained in `note` |
| `unmatched` `unmatched_sides[]` | No footpath at all was found on the side the plan closes (`[{ worksite, side }]`): `closed = []` and the numbers are 0, but this does **not** mean the footpath stays open, so the page must treat `unmatched` separately; explained in `note` |
| `note` `note_zh` | Explanation for the two cases above (English and Chinese); `null` otherwise |
| `step_free` | Always `null`: `walk.json` has no step or ramp data, so wheelchair access is not assessed |
| `measured` `method` | Whether any closed footpath has a real counter (`peds.json` `method = sensor`); `method` = the source of the link `ped_h` was taken from |
| `sensor` | The real counter `{ name, ped_h, id, dist_m, on_closed }`. A counter on a closed footpath is preferred (`on_closed = true`); otherwise it must be within 40 m of the closure (`peds.json assumptions.sensor_m`) **and on the same side of the works link's centreline** (one on the footpath across the road does not count); `null` if neither |
| `detour[]` | Links of the detour route (`walk.json` link ids); never includes `closed[]` |
| `stretches[]` | Details per stretch (worksite × side × a run of end-to-end works links whose headings differ by < 60°), with the fields above plus `from / to / base_m / path_m / base_crossings / dead_end` |
| `assumed` | `{ walk_mps: 1.3, note, note_zh }`: walking speed is an assumption; `note` states that everyone counted is assumed to walk the full stretch (an upper bound), signal waits are excluded and step-free access is not assessed |

- Right-hand footpaths: on CBD dual carriageways (two one-way lines in OSM, as on Lonsdale St and La Trobe St) the right-hand footpath belongs to the opposite carriageway and is recorded as its `left`. The engine finds the opposite carriageway by "same name, opposite direction, within 40 m", then takes those of its footpaths that run alongside the works link for at least min(5 m, half their own length), judged by parallel length rather than midpoints. A footpath link can only be closed whole, so `closed_m` can exceed the length of the works.
- `compare` returns `delta.peds_extra_min` = after − before (negative = better).

### Other engine functions

- `engine.window(worksites, whens)`: total delay over a set of hours.
- `engine.conflict(a, b, { whens?, hours? })` → `{ a, b, ab, cost, overlap, whens, truncated }`, with `cost = D(A+B) − D(A) − D(B)`. It is exactly 0 when the time windows do not overlap. By default it samples every day from the earliest start to the latest end (at most 31 days, then `truncated = true`) at 08:00 and 17:00 within each worksite's hours (otherwise the middle hour).
- `advise(engine, plan, { askAdvisor })`: suggested fixes, each re-run through the engine and marked `better`. The advisor is rule-based (`mockAdvise`); no LLM is involved.

### AI call log

Added in v3.10 (methods only). `connect({ onAiLog?, aiLogMax? })` wraps the sign reader and records one entry per call: `{ seq, t (ISO), persona, signs, roads, kmh, read_s (seconds per sign), src, model, ms, reading, fallback?, error? }`.

- `src` is taken from the reading (`file / kv / llm / rule`). If the reader throws an ordinary error and the engine falls back to its own rules, the entry has `src: "rule"` and `fallback` (the reason). An invalid request (`SignError`) is logged as `src: "error"` with `error` (the code) and `reading: null`.
- The log is in memory only, a ring buffer of at most `AI_LOG_MAX = 200` entries. It sends no extra requests and never changes a reading: the engine caches by wording and reader, so each wording is asked once and logged once.
- `be.aiLog()` → all entries (a copy, in time order). `be.onAiLog(fn)` calls `fn(entry)` for each new entry and returns an unsubscribe function (an error thrown by the callback does not affect readings).
- `be.readingsOf(summary)` → what each road-user type read on the main stretch in that `run()`: `{ when, worksite, entry, street, dir, personas: { <type>: { signs (in the order passed, far → near), roads, kmh, reading, src, model, ms, t, fallback } | null } }`; `null` for a summary that did not come from `run()`. `be.lastReadings()` = the same for the latest `run()`.
- The step 03 "AI road users" and "AI call log" panels use these (`apps/web/src/js/9-ai.js`).

Constraints:

- Same origin only: the web page, `/engine/public/`, `/roads/public/` and `/api/*` must be served from one host.
- Optional link field `truck: false` = no trucks. `network.json` does not have this field yet, so the trucks-only restriction currently has no effect.

## HTTP API

| Method and path | Request | Response | Module |
|---|---|---|---|
| `GET /api/health` | — | `{ "ok": true, "v": "<version>", "mock": bool, "llm": { "mode": "rules" \| "llm", "model", "key": bool, "cache": "kv" \| "cache-api" \| "memory", "prompt_v", "explain_v", "provider", "budget": bool, "per_day": int, "per_min": int, "error"? }, "register": bool }`. `key` only says whether a key is set and **never returns its value**. `register` = whether the worksite register Durable Object is bound. If the api Worker is not bound, the site answers `{ ok, v, mock: true, api: false }` itself | api |
| `POST /api/read` | The [sign-reading request](#sign-reading-api--engine) | `{ "ok": true, "reading": <reading> }` (`src` is `llm / kv / rule`). Invalid request: 400 `{ "ok": false, "error", "msg" }`; body over 8 KB (in bytes): 413; other methods: 405 | api |
| `GET /api/worksites?from&to&status` | `from` / `to` are `YYYY-MM-DD`; a worksite matches if its dates intersect the range | `{ "ok": true, "register": "do" \| "seed", "n", "worksites": [worksite] }`: seed and registered worksites, sorted by start date. If the Durable Object is unbound or fails, `register: "seed"` and only the seed worksites are returned. Bad query: 400 `bad_query` | api |
| `POST /api/worksites` | A [worksite](#worksite-plan-web--engine) plus register fields | 201 `{ "ok": true, "worksite", "edit_token" }`. The `edit_token` is **returned only this once**; the register stores only its SHA-256, and the page keeps the token (localStorage). Register full (200 entries): 409; global write cap (500 a day): 429; body over 16 KB: 413; register not bound: 503 `no_register` | api |
| `GET /api/worksites/<id>` | — | `{ "ok": true, "worksite" }`; 404 if absent | api |
| `PATCH /api/worksites/<id>` | Header `x-edit-token` + the fields to change | `{ "ok": true, "worksite" }`. The merged worksite is validated as a whole. Wrong token: 403 `bad_token`; seed worksite: 403 `locked`; daily write cap: 429. There is no `DELETE`: set `status: "withdrawn"` | api |
| `POST /api/explain` | `{ lang?, options: [{ id, label, metrics, per_capita_min?, flags? }] }` (1–5 options; numbers converted from `run()` results by `optionFromRun()`) | `{ "ok": true, "explain": { src, lang, options: [{ id, summary, pros, cons, hardest_hit, risks }], lean, decide, model?, prompt_v?, note? } }` (`src` is `llm / kv / rule`; `model` / `prompt_v` only for `llm / kv`; `note` only when an LLM attempt fell back to rules). Every number in the explanation must trace back to a number in the request; `hardest_hit` and the rule-based risks are always computed from the engine's numbers. Invalid: 400; over 8 KB: 413 | api |
| `GET /api/sumo/v1/health`, `POST /api/sumo/v1/runs`, `GET /api/sumo/v1/runs/<id>[/index.json \| /<scenario>/manifest.json \| /<scenario>/frames-NNN.json \| /frame?scenario&t]` | As in [`apps/web/tools/sumo/README.md`](../../apps/web/tools/sumo/README.md#api-v1) (API v1). POST accepts only whitelisted fields; `demand_scale` 0.1–1.2, `clearance_s` 600–2400; body ≤ 2 KB | As in that README (reading results before completion: 409). Errors are always `{ ok:false, error, msg }`: `sumo_off` 503 (the site has no `SUMO` binding), `sumo_down` 502 (no response from the SUMO Worker or container; **the current state**), `sumo_starting` 503, `sumo_rate` 429 (3 runs per IP per minute), `sumo_busy` 429 (2 or more jobs running), `not_found` 404, `too_big` 413. Completed index, manifest and frame files may be cached for a day | sumo |
| `POST /api/sumo/v1/runs` with `{"network":"real", "seed"?, "p_original"?, "p_ai"?, "scenarios"?}` | `p_*` 0–1 (detour share; defaults 0.14 and 0.53); `scenarios` ⊆ `baseline / original / ai` (default all) | As above; results in [format v2](#sumo-results-format-v2-real-network) | sumo |
| `POST /api/sumo/v1/runs` with `{"network":"real", "seed"?, "options": [{"id", "p"}], "frames"?}` (options mode) | 1–5 `options`, unique `id` ∈ `A–E`, `p` 0–1 (that plan's detour share, which the page takes from the engine's sign reading); `frames` defaults to `false`; cannot be combined with `p_original` / `p_ai` / `scenarios` | Format v2 with scenarios `baseline` plus one `opt-<id>` per option (one lane closed with that `p`; metrics as for `original` / `ai`). Options with the same `p` run once; the copies carry `reused_from`. With `frames:false`, `manifest.chunks` is empty and there are no `frames-NNN.json` files. **No baked fallback**: `runOptions()` in `sumo-client.js` returns `source:'none'` and a `reason` on failure | sumo |
| Static `/sumo/public/real/…` | — | Pre-computed SUMO run on the real network (format v2, seed 42, scenarios baseline / original / ai). Step 02 starts a live run and falls back to this copy when the cloud run fails, which since the event is always; the page labels it "SUMO · pre-computed" | sumo |
| Static `/sumo/public/baked/…` | — | Pre-computed runs on the synthetic 2×2 grid: `baked.json` (catalogue: generation time, source, SUMO version, `generator_sha256`, complete / failed state of the preset and the 15 grid points), `preset/` (index, manifests and frames for the 4 default scenarios at seed 42) and `grid/<key>.json` (index only). Only the legacy `run()` / `bakedFor()` path reads them; the current page does not. Any page that shows them **must** label them pre-computed | sumo |
| Static `/sumo/public/js/sumo-client.js` | — | `createSumoClient()` with `health, run, loadBaked, bakedFor, manifest, chunk, loadReal, runReal, runOptions, realManifest, realChunk`. It tries the cloud first; when the service is unreachable, rate-limited, busy, times out or the run fails, `run()` falls back to `/sumo/public/baked/` and `runReal()` to `/sumo/public/real/`. Every result carries `source: live \| baked \| none` and a `reason`, and the page picks its wording from them (`labels`, `realLabels`) | sumo |

- `llm.mode` is `llm` only when the Worker variable `MOCK` is `"0"` **and** the secret `LLM_API_KEY` is set. Otherwise `/api/read` uses keyword rules only and makes no external request (`apps/api/tests/llm.test.mjs` asserts this). After the event the secret was removed, so the live site is in `rules` mode.
- `POST /api/explain` has the same switch as `/api/read`. Each request makes at most 1 external call and reserves 1 from the same budget. Its fallback `note` can also be `llm_fallback: bad_json / invalid / empty / timeout / http_<status>`.
- Before a real `/api/read` call the Worker also reserves 3 calls against a global daily counter (Durable Object binding `BUDGET`). Over `LLM_MAX_CALLS_PER_DAY` (`llm.per_day`), with no binding, or on a counter error, it makes no call and returns a rule reading with a `note` (`llm_daily_cap` / `llm_no_budget` / `llm_budget_error`).
- `llm.cache`: `kv` = a KV binding `READINGS` exists (shared across instances); `cache-api` = the Workers Cache API (only on a custom domain); `memory` = per-instance memory only (what `*.workers.dev` gets without KV).
- `/api/*` is forwarded by the site Worker over the service binding `API` to the api Worker (`hackathon-api`, which has no `workers.dev` URL of its own). `/api/public/*` serves the static files in `apps/api/public/` and is not forwarded.
- `/api/sumo` and `/api/sumo/*` are intercepted by the site before the `/api/*` rule and forwarded over the service binding `SUMO` to `hackathon-sumo` (no `workers.dev` URL of its own), which passed them to the container's `/sumo/v1/*`. The container ran a single instance and could restart; after a restart old run ids return 404, and the page falls back to the pre-computed results (decision D-0930-1700). The Worker and container were deleted after the event, while the site still declares the binding, so these paths now return 502 `sumo_down`.

### SUMO results, format v2 (real network)

Produced by `apps/web/tools/sumo/build_real.py` (live runs) and committed under `apps/sumo/public/real/` (baked copy). Read by `sumo-client.js` and the web page's step 02, 03 and 04.

- **`index.json`**: `version: 2, network: "real", engine` (e.g. `"Eclipse SUMO sumo 1.27.1"`), `generator_sha256` (SHA-256 of `build_real.py`; a web test fails if the script changes without a re-bake), `seed, hour, works { link, lanes_closed }, params, assumptions { en[], zh[] }, scenarios[{ id, label { en, zh }, diversion_share, manifest, metrics }], timing`. `params` records the run settings, including `p_original`, `p_ai`, `hour_window [8, 9]`, `warmup_s` (180), `sample_s` (2), `step_s` (0.5), `cycle_s` (90) and `engine_capacity_vph` (810).
- **`<scenario>/manifest.json`**: `version, network, scenario, duration_s` (3600), `sample_s` (**2**: one frame every 2 simulated seconds), `clock0_s, agent_columns, agents[{ id, type, length_m, width_m }], signal_heads[{ id, tls, idx, lon_e6, lat_e6 }], chunks[{ file, start, end, frames, bytes, sha256 }], works, metrics, per_minute, engine, seed, diversion_share`. Each chunk holds 60 frames (120 s); the client checks each chunk's SHA-256 before using it (where the browser offers WebCrypto). The baseline scenario has a manifest but no frames.
- **`<scenario>/frames-NNN.json`**: `{ frames: [{ t, a, tls, q }] }`. `a` holds one row per vehicle, `[i, lon×1e6, lat×1e6, angle, speed in cm/s]`, where `i` indexes `agents`, the position is the centre of the vehicle body and the angle is in degrees clockwise from north. `tls` maps each signal to its state string, and `q` is the works queue in metres.

The synthetic 2×2 format (v1, local metres) is described in [`apps/web/tools/sumo/README.md`](../../apps/web/tools/sumo/README.md).

## Error format

`{ "ok": false, "error": "<machine-readable code>", "msg": "<human-readable message>" }`, with HTTP status codes following REST conventions. Clients branch on `error`, never on `msg`.

- In this repository most `msg` texts are English. Sign-text validation messages (`SignError` in `signs.js`, warnings from `check.js`) are Chinese on purpose: the Chinese UI shows them verbatim, and the English UI maps them by `error` code.
- The deployed Workers predate the English translation, so live responses can still carry Chinese `msg` text (for example the `sumo_down` message).

## Removed template sections

Earlier versions of this file still carried sections from the pre-event project template that were never implemented: a WebSocket endpoint (`/ws?room=<CODE>` with `join` / `act` / `state` / `err` messages), a shared room-state shape with per-user views (`viewFor()`), `POST /api/create` (room codes) and a "Mock" mode that ran `reduce()` from a `logic.js` file in the browser. None of these exist in the code, so they were removed in v3.15. They remain readable in the git history (`docs/contract.md` at tag `hackathon-final`). The `mock` flag in `/api/health` is unrelated: it is `true` unless the api Worker's `MOCK` variable is `"0"` (`llm.mode` says whether the LLM is actually used).

## Changing an interface

Prefer backward-compatible changes: add fields, do not rename or remove them. A breaking change (rename, removal, new unit or value range) updates every caller in the same pull request, bumps the version at the top of this file and adds a row to the changelog below. During the event such pull requests were titled `contract:`, merged by the team lead, and announced to the modules that depend on them.

## Changelog

Newest first. Decision ids (D-…) refer to [`docs/decisions.md`](../decisions.md).

| Version | Date | Change | By |
|---|---|---|---|
| v3.15 | 2026-10-11 | Post-event English edition, no interface change. Translated from Chinese; fixed the version header (it said v3.11); removed the unimplemented template sections (see above); corrected the real-network frame interval (`sample_s = 2`, not 1 s) and step 02's behaviour (live run first, baked replay as fallback); added rows for `buildings.json`, `equipment.json`, `vectormap.json` and the weather files, the SUMO format v2 summary, and the post-event status | @Zemmeng |
| v3.14 | 2026-10-01 | D-1001-0045, HTTP API: options mode for `POST /api/sumo/v1/runs` (`options: [{ id, p }]`, `frames`, scenarios `opt-A…E`, `reused_from`, no baked fallback) and `runOptions()` in `sumo-client.js`. Additive only. Not logged at the time | @Zemmeng |
| v3.13 | 2026-09-30 | D-0930-2200, HTTP API: `POST /api/sumo/v1/runs` accepts `network:'real'` (scenarios baseline / original / ai, results format v2 in lat/lon) and the static `/sumo/public/real/…`; real-network methods in `sumo-client.js`. Additive only | @Zemmeng |
| v3.12 | 2026-09-30 | D-0930-1700, HTTP API: `/api/sumo/v1/*` (site → `hackathon-sumo` → container) and the static `/sumo/public/baked/…` and `/sumo/public/js/sumo-client.js`. Paths added only | @Zemmeng |
| v3.11 | 2026-09-30 | Result `links[]` gains `extra_min` (additive). `delay_s` is now described as "above free flow" (it was wrongly described as "above normal"), and `queue_m` is documented as absolute | @Zemmeng |
| v3.10 | 2026-09-29 | Engine API: AI call log (backward compatible; methods and optional arguments only): `be.aiLog()`, `be.onAiLog(fn)`, `be.readingsOf(summary)`, `be.lastReadings()`, `connect({ onAiLog, aiLogMax })`. Summary fields unchanged | @Zemmeng |
| v3.9 | 2026-09-29 | D-0929-2307 (backward compatible): `POST /api/explain` uses the LLM, so `src` gains `llm / kv`, with optional `model` / `prompt_v` (for `llm / kv`) and `note` (on fallback); `/api/health` `llm` gains `explain_v` | @Zemmeng |
| v3.8 | 2026-09-29 | D-0929-2011, engine API: `be.clash(a, b)` and `be.stagger(a, b)`: clash cost D(A+B) − D(A) − D(B) and one-click staggering, display fields never negative, `flags.reliable`. Methods only | @Zemmeng |
| v3.7 | 2026-09-29 | D-0929-2011, worksite plan: equipment options `options[]`: `be.options()` returns plans `o1 / o2 / o3`, each with an engine result, hire cost (`hire.assumed = true`) and stock check (never above stock). Additive; builds on `equipment[].item / qty` from v3.6 | @Zemmeng |
| v3.6 | 2026-09-29 | D-0929-2011 (backward compatible, additive): register fields on the worksite plan (`title / kind / status / decision`; server-set `id / seed / created / updated`) and optional `equipment[].item / qty` (ignored by the engine); HTTP API gains the four `/api/worksites` endpoints and `POST /api/explain`; `/api/health` gains `register` | @Zemmeng |
| v3.5 | 2026-09-29 | LLM interface prepared (backward compatible, additive): `/api/health` gains `llm` (with the daily cap fields `budget` / `per_day` / `per_min` and `cache` ∈ `kv / cache-api / memory`); readings document `src` / `model` / `prompt_v` and gain an optional `note`; site service binding `API` → `hackathon-api` | @Zemmeng |
| v3.4 | 2026-09-29 | Engine API `summary.peds` (after review): `connect()` no longer waits for walk / peds data (`status().peds = loading`, `be.pedsReady()`, `pending`); added `dead_end`, `unmatched` / `unmatched_sides`, `note` / `note_zh`, `sensor.on_closed`; `crossings` now counts streets crossed; right-hand footpaths chosen by parallel length | @Zemmeng |
| v3.3 | 2026-09-29 | Worksite plan gains optional `closes.footpath` (`left / right / both`) and plan validation (`bad_plan`); engine API gains `summary.peds` (pedestrian detours around closed footpaths), `status().peds` and `delta.peds_extra_min` in `compare`; `connect()` also fetches `walk.json` / `peds.json` and does not throw if they fail | @Zemmeng |
| v3.2 | 2026-09-29 | Road data files gain `transit.json`; engine API: `run()` gains `summary.transit` (affected tram and bus routes, rider-minutes) and `compare()` gains `delta.transit_pax_min`. Additive only | @Zemmeng |
| v3.1 | 2026-09-29 | Sign reading: `kind` gains `arrow`, `read_s` capped at 120, road-name characters, `SignError` and `failed` / `missing` (aligning the api module with the engine); HTTP API gains `POST /api/read`; engine API: the page uses only `backend.js` (D-0929-1540) | @Zemmeng |
| v3 | 2026-09-29 | Added the worksite plan; settled the engine API (`createEngine` / `prepare` / `evaluate` / `conflict` / `advise` and result fields); parameters via `loadParams()` from `params.json`, `calib.target` | @Zemmeng |
| v2 | 2026-09-29 | Added sign reading (api → engine, D-0929-1435) and a draft engine API (engine → web) | @Zemmeng |
| v1 | 2026-09-29 | Added the road data files section (roads → engine, web); the HTTP and WebSocket sections were still template placeholders | @Zemmeng |
| v0 | 2026-09-26 | Template placeholders: health / create / WebSocket skeleton | @Zemmeng |
