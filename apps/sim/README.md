# sim: Swanston St × La Trobe St junction micro-simulation

Owner: @Zemmeng (engine, data and tests) · UI: @unicornnnnnny (`public/index.html`, `public/style.css`, `public/js/ui.js`; see decision D-0929-1226 in [docs/decisions.md](../../docs/decisions.md))

The team's first prototype for Challenge 5 (RPM Hire: digital tool for temporary infrastructure), built on 29 Sep 2026 before the main RippleTwin app. It simulates one Melbourne CBD junction, Swanston St × La Trobe St (SCATS site 2921), with cars, bikes, trams and pedestrians driven by real open data, and replays one hour in 20 seconds. A work-zone toggle closes 40 m of the westbound bike lane so you can compare queues and conflicts with and without the works.

It is a static page with no back end and no cost. The `hackathon-site` Worker serves it at `/sim/public/`; the main app does not link to it.

## Run

```bash
python3 -m http.server 4174 -d apps/sim/public   # then open http://localhost:4174
```

- Opening `index.html` directly (`file://`) does not work, because `ui.js` fetches the data file.
- Single-file build, for sharing a page that opens directly on a phone: `python3 apps/sim/tools/build_single.py` writes `out/sim-single.html` (`out/` is gitignored).
- After changing CSS, JS or data, run `bash apps/sim/bump.sh` to increment every `?v=N` cache-busting number in `index.html` and `js/*.js`.

## Model

- **Frame.** Metres, origin at the junction centre, x east, y north; the view covers ±90 m (`HALF`). One step is 0.25 s (`DT`); each run warms up for 300 s and then scores one hour (`HOUR` = 3600 s).
- **Streams.** 11 vehicle streams (La Trobe St eastbound and westbound cars, Swanston St left turners into La Trobe St eastbound, bikes and trams in both directions on both streets) and 8 pedestrian streams along the four footpaths. Arrivals are Poisson at the hourly rate from the data; trams arrive at timetable intervals (mean headway ±25%), and Swanston St trams dwell 8–18 s at far-side stops.
- **Signals.** A fixed 100 s plan simplified from the site's phasing diagram: phase A, Swanston through, 30 s green + 3 s amber; Swanston left turners keep their green from 0 to 45 s, so the exclusive left-turn phase B is about 12 s; phase C, La Trobe, 44 s green + 4 s amber. Walk signals: the east crosswalk (crossed by the left turners) walks for the first 21 s of phase A, the west crosswalk 0–31 s, north and south 50–81 s. The real junction is SCATS-adaptive; these timings are assumed.
- **Car following.** IDM for cars, bikes and trams, with per-mode parameters (for cars: length 4.5 m, desired speed 11.1 m/s, time headway 1.2 s, jam gap 2.0 m). Leaders are found by arc length on the same route; other routes count only when nearly parallel (dot product ≥ 0.9), with merges listed separately in `MERGE_FROM`.
- **Giving way.** Left turners give way to southbound through bikes (zone z1) and to pedestrians on the east crosswalk (zone z2). 10% of drivers are inattentive and give way only to someone who will reach the zone within 0.8 s; drivers who have waited more than 15 s in the junction behave the same way.
- **Conflicts.** PET (time between two road users passing through the same zone) and TTC (a car closing on a bike in the same lane, at current speeds). An event is recorded when either is under 1.5 s and counted as severe under 0.5 s.
- **Work zone.** Barriers between x = 20 m and 60 m on the east leg close the westbound bike lane; westbound bikes merge into the traffic lane from x = 62 m to −18 m, and the westbound car queue then includes them.
- **Determinism.** Each stream has its own `mulberry32` random-number stream seeded with `seed ^ hashStr(streamId)`, and every agent's attributes come from its stream. The same seed gives exactly the same result, and the normal and work-zone runs see identical arrivals, so the comparison is fair.

## API

There is no cross-module interface. Inside the module, the UI (`ui.js`) uses the engine only through these `sim.js` exports, so UI changes do not require reading the engine internals:

| Export | Use |
|---|---|
| `new Sim({ data, hour, day, wz, seed })` | `data` = `demand_2921.json`; `hour` 0–23; `day` `'wd'` (weekday) or `'we'` (weekend); `wz` work-zone mode; the same `seed` always gives the same result |
| `sim.step()` | Advances `DT` = 0.25 s. `sim.t` is the current second: 0 to `HOUR` = 3600 is the scored hour, and the constructor starts at `t` = −300 for warm-up |
| `sim.agents` | Every road user on screen: `mode` (car / bike / tram / ped), `P` (path), `s` (front position along the path, m), `sPrev`, `v`, `len`, `w` |
| `pathAt(P, s, out)` | `{x, y, hx, hy}` at distance `s` along a path |
| `sim.events` | Conflicts: `{ t, kind, label, x, y, val }`, where `val` is the PET or TTC in seconds (< 0.5 is severe) |
| `sim.summary()` | `{ spawned, expected, delay, qEB, qWB, delayCarEB, delayCarWB, outside, conflicts, severe, byLabel }`: `qEB` / `qWB` are the longest La Trobe queues in the hour (m); `delayCarEB` / `delayCarWB` are average La Trobe car delays (s), excluding cars still queued off-screen; `outside` counts cars queued off-screen that have not yet entered |
| `sigState(phase, t)` / `walkOn(crosswalk, t)` | Signal state `'G'`, `'Y'` or `'R'`; whether a walk signal is on |
| `HALF`, `WARM`, `HOUR`, `DT`, `WZ`, `SIG`, `WALK`, `hashStr`, `mulberry32` | Half-width of the view (90 m), warm-up, hour length, step, work-zone extent, signal plan, walk windows, seed hash, RNG |

## Data sources

All free, no keys needed.

| Data | Where | Licence | Used |
|---|---|---|---|
| Traffic Signal Volume Data (SCATS) | https://discover.data.vic.gov.au/dataset/traffic-signal-volume-data | CC BY 4.0 | Site 2921, 2026-08-01 to 09-27 |
| Victorian Traffic Signals (site list) | https://discover.data.vic.gov.au/dataset/victorian-traffic-signals | CC BY 4.0 | Site coordinates; `MUNICIPALITY = MBN` is the City of Melbourne |
| Traffic Signal Configuration Data Sheets | https://discover.data.vic.gov.au/dataset/traffic-signal-configuration-data-sheets | CC BY 4.0 | Site 2921 sheet: detector plan (page 2), phasing diagram (page 3), detector function table (page 4) |
| Pedestrian Counting System (hourly) | https://data.melbourne.vic.gov.au, dataset `pedestrian-counting-system-monthly-counts-per-hour` | Not stated on the dataset page (companion City of Melbourne datasets are CC BY); unresolved | Sensors 3, 66, 62, 187 |

Detectors used at site 2921: 7 = La Trobe eastbound cars, 5 = westbound cars, 3 = Swanston north approach cars, 1 = Swanston northbound bikes, 4 = La Trobe westbound bikes, 11 / 13 = Swanston southbound / northbound trams, 22 = La Trobe westbound trams. Pedestrian sensors: 3 (Melbourne Central), 66 (QV2, 300 Swanston St), 62 (La Trobe St North), 187 (RMIT Building 22).

Streams with no data, filled by assumption: La Trobe eastbound bikes use the westbound counts (detector 6 is faulty); Swanston southbound bikes, which have no detector, use the northbound counts; La Trobe eastbound trams use the westbound counts; the south footpath of La Trobe St uses the north footpath counts.

**Formats as checked on 29 Sep 2026.**

- SCATS comes as one statewide zip per month (about 120–135 MB) holding one `VSDATA_YYYYMMDD.csv` per day (about 30 MB). Each row is one detector at one site for one day: `NB_SCATS_SITE, QT_INTERVAL_COUNT (date), NB_DETECTOR, V00…V95 (96 15-minute bins), NM_REGION, CT_RECORDS, QT_VOLUME_24HOUR, CT_ALARM_24HOUR`.
- The server supports HTTP Range requests, so a single day can be extracted from the remote zip without downloading all of it.
- Pedestrian API: `https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/<id>/exports/csv`, a rolling two years updated daily; columns `location_id, sensing_date, hourday, direction_1, direction_2, pedestriancount`. The meaning of the two directions (for example North / South) comes from `direction_1 / direction_2` in the sensor locations table.

**Pitfalls.**

- Negative counts mean a faulty or missing detector and are treated as missing; about 2.7% of site 2921's cells in August–September are negative.
- Detector numbers carry no lane or direction; map them with the configuration sheet. At site 2921, detectors 1, 2, 4, 6 and 8 are bike detectors and 11, 13 and 22 are tram detectors.
- Detector 6 (La Trobe eastbound bikes) reads 0 on all 57 days, so it is broken; the pedestrian push-button detectors 24–28 also read 0, so they give no pedestrian counts.
- The August file is missing 31 Aug; 25 Sep is a public holiday and is left out of the averages.
- To rebuild `public/demand/demand_2921.json` from fresh downloads: `python3 apps/sim/tools/build_demand.py --scats … --ped … --sensors …` (arguments are documented at the top of the script). The raw inputs are not in the repository.

## Testing

```bash
bash apps/sim/test.sh   # Node >= 18, no npm install
```

`tests/sim.test.mjs` runs full simulated hours headless in Node and makes 14 assertions: arrivals within 12% of the data (20% for trams), finite and non-negative states, an identical summary for the same seed, no same-lane car–bike events and no off-screen queue in the normal run, more off-screen queueing and no fewer conflicts with the work zone while pedestrian arrivals stay identical, a near-empty 03:00, and the signal and walk timings. The last line is `N passed, M failed`.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | Page structure; `?v=N` cache-busting numbers |
| `public/style.css` | Styles; all colours are tokens with light and dark sets |
| `public/js/sim.js` | Simulation engine: geometry, signals, IDM car following, giving way, conflict detection; pure logic with no DOM |
| `public/js/ui.js` | Canvas drawing, controls, readouts and the normal vs work-zone comparison |
| `public/demand/demand_2921.json` | Hourly demand profile (generated by `build_demand.py`) |
| `tests/sim.test.mjs` | Full-hour assertions run in Node |
| `tools/build_demand.py` | Raw open data → `demand_2921.json` |
| `tools/build_single.py` | Inlines everything into one HTML file |
| `bump.sh` | Increments every `?v=` after CSS / JS changes |

## Conventions

- The data directory is `public/demand/`, not `data/`: the repository `.gitignore` ignores every `data/` directory.
- Keep the engine and the UI apart: the UI uses only the exports above, and the engine must not touch the DOM, so `test.sh` can run it in Node.
- The same seed must give exactly the same result: arrivals and agent attributes come from each stream's own random-number stream, which keeps the normal vs work-zone comparison fair.
- Leader search: by arc length on the same route; on other routes only near-parallel headings (dot product ≥ 0.9), with merges listed in `MERGE_FROM`. Searching along a heading ray made left turners and through bikes wait for each other and deadlocked the junction (see [docs/pitfalls.md](../../docs/pitfalls.md)).
- `build_single.py` matches the `import … from './sim.js?v=N';` line and the start of the `const DATA = await fetch(` line in `ui.js`, and literal `<head>` and `<body>` lines in `index.html`; keep those shapes.

## Limitations

- The signal timing is assumed (see Model); the real junction is SCATS-adaptive.
- Four streams are filled by assumption from other streams (see Data sources).
- The pedestrian route shares (60% straight across, 25% turn without crossing, 15% turn and cross the other street) and the 10% of inattentive drivers are assumptions.
- Only cars turning left from the Swanston north approach into La Trobe St are modelled; turning traffic on La Trobe St is not.
- In work-zone mode cars cannot overtake bikes, so westbound capacity drops more sharply than it would in practice.
- The module uses no code from the pre-event `starters/` templates, which were deleted under decision D-0929-1311.
