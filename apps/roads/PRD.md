# T3 road network data PRD

*Original hackathon PRD (phase 1), written on 29 Sep 2026 during the FEIT Hackathon Festival. Translated from the original Chinese; superseded details are kept as they were, with later outcomes noted in brackets. For the module as built, see [README.md](README.md).*

> Owner: @louisxie316-dotcom · Module: `apps/roads/` · Branch: `louisxie316-dotcom/roads/T3-network`
> Written 2026-09-29 13:10 by the lead (@Zemmeng). If anything is unclear, ask the lead rather than guessing; if you change this file, add a row to the change log at the end.

## 1. In one sentence

Turn the Melbourne CBD's **real road network** and **real traffic flows** into three JSON files that the road network engine (T4) can read directly, to work out "after closing a stretch of road, where does traffic detour and how long are the delays". The web panel (T2) uses the same network to draw links on the map.

## 2. Where it sits in the system

The overall flow is in `docs/2-plan.md` (now [docs/hackathon/plan.md](../../docs/hackathon/plan.md)), with diagrams in `docs/arch/` (start with the "system flow" page; those diagrams have since been removed from the tree). T3 is the **input to step 4, "work out the impact"**:

```
T3 roads (this task) ──static JSON──▶ T4 engine (computes detours and delays, runs in the browser)
                     └─────────────▶ T2 web (draws links on the map, lets the user pick the works link)
```

T3's outputs are **static files prepared in advance and published with the web page**. Nothing calls an API in production and no key is needed.

## 3. Deliverables

| File | Contents | Used by |
|---|---|---|
| `public/cbd/network.json` | Road network: junctions (nodes) and directed links, with each link's length, lanes, speed limit and capacity | T4, T2 |
| `public/cbd/flows.json` | Base hourly traffic flow per link (24 numbers each for weekdays and weekends) | T4 |
| `public/cbd/signals.json` | SCATS signalised junctions in the area and the nodes they match | T2 (map labels), source checking |
| `tools/*.py` | Scripts that generate the three files above from raw data, re-runnable with one command | Changing district / refreshing data later |
| `tests/test_roads.py` | Checks for the three files (already written to section 7; they run automatically once the files exist) | `test.sh`, CI |
| `README.md` | How to re-run, data sources, field descriptions, gotchas | Everyone |

Both locally and in production the files are at `/roads/public/cbd/<file>` (the lead's deployment mounts each module's `public/` unchanged at `/<module>/public/`).

## 4. Scope

**Area**: the CBD grid. Default bounds (south, west, north, east) = `-37.8235, 144.9480, -37.8060, 144.9760`, passed as a script argument `--bbox`; **do not hard-code it**. The demo district is not final yet, and changing district should only mean re-running.

**In scope**:
- The drivable network (OSM `network_type="drive"`), one link per direction
- Lanes, speed limit, capacity and free-flow time for each link; flags for tram tracks and bike lanes
- Real traffic flows: DataVic SCATS signal data, 2026-08-01 to 09-27, averaged by hour for weekdays / weekends
- Matching signalised junctions to network nodes

**Out of scope** (other tasks, or later):
- Route choice, traffic assignment, delay calculation (T4)
- Walking network, public transport routes (a separate task later) *[Later: phase 2, [PRD-2.md](PRD-2.md), delivered `walk.json`, `peds.json` and `transit.json`, and later tasks added buildings, equipment, vector basemap and weather files: 11 files in total.]*
- The interface (T2)

## 5. File formats (contract v1, already in the "road data files" section of `docs/contract.md`, now [docs/reference/interfaces.md](../../docs/reference/interfaces.md))

Fields can be added at any time; **renaming or removing a field, or changing a unit, must go through the lead first**, and `version` goes up by 1.

### 5.1 `network.json`

```json
{
  "version": 1,
  "area": "cbd",
  "bbox": [-37.8235, 144.9480, -37.8060, 144.9760],
  "generated": "2026-09-29T16:30:00+10:00",
  "sources": ["© OpenStreetMap contributors (ODbL)"],
  "assumptions": { "sat_flow_vph_per_lane": 1800, "green_ratio_signal": 0.5, "default_speed_kmh": 40 },
  "nodes": [
    { "id": "n1", "lat": -37.8096, "lon": 144.9638, "osm": 12345678, "signal": "2921" }
  ],
  "links": [
    {
      "id": "l1", "from": "n1", "to": "n2",
      "name": "La Trobe Street", "highway": "primary",
      "len_m": 118.4, "lanes": 2, "speed_kmh": 40,
      "cap_vph": 1800, "t0_s": 10.7,
      "tram": true, "bike_lane": true,
      "osm_way": 987654,
      "geometry": [[-37.8096, 144.9638], [-37.8099, 144.9651]]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `nodes[].id` / `links[].id` | String, unique, **as stable as possible across re-runs** (derive from OSM ids, not row numbers); T2 uses them to store the works link the user picked |
| `nodes[].signal` | The matched SCATS site number (string); `null` if none |
| `links[]` | **Directed**: a two-way road becomes two links, and `from → to` is the direction of traffic |
| `lanes` | Lanes in this direction, ≥ 1. On two-way roads OSM `lanes` is the total: use `lanes:forward` / `lanes:backward` if present; otherwise half the total rounded up; if neither, a road-class default (primary / secondary 2, others 1) |
| `speed_kmh` | OSM `maxspeed`; if missing, 40 (a common CBD limit), recorded in `assumptions` |
| `cap_vph` | Maximum vehicles per hour in this direction = `lanes × 1800 ×` (end node is a signalised junction ? 0.5 : 0.9); both factors recorded in `assumptions` |
| `t0_s` | Free-flow time = `len_m / (speed_kmh / 3.6)` |
| `tram` / `bike_lane` | Booleans. Bike lanes from OSM `cycleway*` tags; trams from whether the same street has `railway=tram` (P1: if there is no time, fill `false` everywhere and say so in the README) |
| `geometry` | Polyline from `from` to `to`, `[latitude, longitude]`, 5 decimal places is enough |

### 5.2 `flows.json`

```json
{
  "version": 1,
  "unit": "veh/h",
  "period": "2026-08-01..2026-09-27 (excluding 08-31, missing data, and the 09-25 public holiday)",
  "days": {
    "wd": { "l1": [120, 80, "…24 in total"] },
    "we": { "l1": [150, 110, "…24 in total"] }
  },
  "method": { "l1": "site_split" },
  "coverage": { "links": 820, "measured": 310, "estimated": 510 }
}
```

- Every link in `network.json` must have both `wd` and `we`, each 24 non-negative numbers (index = hour, 0 = 00:00–01:00)
- `method` records how each link's numbers were produced: `detector_map` (mapped to lanes via the configuration sheet, most accurate) / `site_split` (junction total split across approaches) / `street_interp` (interpolated from upstream and downstream on the same street) / `class_default` (road-class default, least accurate)

### 5.3 `signals.json`

```json
{ "version": 1, "sites": [ { "site": "2921", "name": "SWANSTON/LATROBE", "type": "INT", "lat": -37.8096, "lon": 144.9638, "node": "n1", "dist_m": 6.2 } ] }
```

`node` is the nearest network node (within 30 m); `null` if there is no match.

## 6. Data sources and how to get them

| Data | Entry point | Licence | How to get it |
|---|---|---|---|
| Road network | OpenStreetMap, via the Python package OSMnx | ODbL; pages must show "© OpenStreetMap contributors" | `uv pip install osmnx` or `pip install osmnx` |
| Signal traffic volumes | https://discover.data.vic.gov.au/dataset/traffic-signal-volume-data | CC BY 4.0 | One statewide zip per month (about 120–135 MB), two for August and September; download into `apps/roads/raw/` (gitignored) |
| Signal site list | https://discover.data.vic.gov.au/dataset/victorian-traffic-signals | CC BY 4.0 | One CSV (about 300 KB), columns `SITE_NO, SITE_NAME, TYPE, MUNICIPALITY, LATITUDE, LONGITUDE` |
| Detector configuration sheets | https://discover.data.vic.gov.au/dataset/traffic-signal-configuration-data-sheets | CC BY 4.0 | Packed by site-number range, about 2 GB per bundle; **extract single junctions only as needed** with `tools/fetch_scats.py --sheet <site>` |

**Gotchas already hit** (full text in the "external APIs" section of `apps/sim/README.md` at the time):
- SCATS CSV: one row = one detector at one site for one day; `V00`–`V95` are 96 fifteen-minute slots; **negative = fault or missing, treat as empty**; at most 24 detectors per site
- Detector numbers carry no direction or lane; check them against the plan on page 2 of the configuration sheet. Some detectors are bikes, trams or pedestrian push-buttons (the mapping for Swanston/La Trobe 2921 is already in `DET` in `apps/sim/tools/build_demand.py`)
- The August bundle is missing 08-31; 09-25 is a public holiday; City of Melbourne sites have `MUNICIPALITY = MBN`
- The server supports HTTP Range: `tools/fetch_scats.py --day 2026-09-22` extracts a single day remotely (about 4.6 MB); use it to look at the format before deciding whether to download everything
- The lead already has an extract of the 131 CBD sites for August–September on their machine (40 MB CSV) and can share it through a cloud drive to save the download *[Note: an internal arrangement during the event; the raw extracts are not in the repository.]*
- **Do not name a directory `data/`**: the repository `.gitignore` ignores every `data/`
- The parameter order of `graph_from_bbox` in OSMnx 2.x differs from 1.x: confirm with a minimal request first rather than copying old examples from the web

## 7. Acceptance criteria (`tests/test_roads.py` is already written and runs automatically once the files appear)

Run `bash apps/roads/test.sh`; it passes only when the last line is `N passed, 0 failed`:

1. `network.json`: `version` is an integer; node ids and link ids are each unique; every link's `from` / `to` is an existing node
2. Every link has `len_m > 0`, `lanes ≥ 1`, `5 ≤ speed_kmh ≤ 110`, `cap_vph > 0`, and `t0_s` within 5% of `len_m / speed`
3. Every node lies inside the `bbox` (with a 300 m margin, since edge links stick out a little)
4. The network is connected: the largest group of mutually reachable nodes (strongly connected component) holds at least 90% of all nodes, otherwise T4's detours will fail to find a path
5. `flows.json`: every link has 24 non-negative numbers each for `wd` and `we`; the three `coverage` numbers add up
6. Sanity check: among links whose name contains La Trobe, at least one has a weekday 17:00 flow of 100–2,000 vehicles per hour (in the sim, the Swanston junction eastbound measures about 450)
7. `signals.json`: site numbers are unique; `node` is either `null` or an existing node
8. Each of the three files is under 2 MB (the page has to load on a phone)

## 8. Steps and time boxes

| Time | What to do | What to hand over |
|---|---|---|
| 13:30–14:15 | Install OSMnx, download the CBD network, save it to `raw/` | The network can be plotted in Python |
| 14:15–15:30 | Write `tools/build_network.py`: lanes, speed limit, capacity, free-flow time → `network.json` | Tests 1–4 pass |
| **17:00 integration point** | **Open a draft PR with a minimal `network.json` first** (no flows is fine), so T4 can switch to the real network straight away | Draft PR |
| 17:00–19:00 | `tools/build_flows.py`: match SCATS sites to nodes → `signals.json`; split junction totals across approach links (`site_split`) → `flows.json` | Tests 5–7 pass |
| 19:00–20:30 | Links without detectors: interpolate along the same street, otherwise use the road-class default; document each method in the README | `coverage` numbers |
| **21:00 integration point** | Mark the PR ready, `check.sh --quick` all green, ask the lead to merge | Merged into main |
| Bonus (if there is time) | Map a few key junctions to lanes via their configuration sheets (`detector_map`); tram track flags | Number of `detector_map` entries in `method` |

## 9. Ground rules

- Change only `apps/roads/`, plus your own section of `docs/3-tasks.md` (now [docs/hackathon/task-board.md](../../docs/hackathon/task-board.md)); anything elsewhere goes in section 2 of the handoff note
- Raw data goes in `apps/roads/raw/` (gitignored); **do not commit large files**; `public/cbd/` holds only the three generated JSON files
- Run `bash scripts/check.sh --quick` after each step; paste the summary line before opening a PR
- This task needs no key and costs nothing
- Write a handoff note before sleeping or handing over (`handoff/README.md`, now [docs/hackathon/handoff/README.md](../../docs/hackathon/handoff/README.md))

## 10. Open questions

- The demo district may move from the CBD to somewhere else: parameterising `--bbox` is enough, no need to plan for it now
- Walking network, tram and bus routes: a separate task later
- The two capacity factors (1800, 0.5) are common rules of thumb; adjust them together if T4's results look clearly wrong

## Change log

| Time | Who | What changed |
|---|---|---|
| 09-29 13:10 | Lead (@Zemmeng) | First version |
