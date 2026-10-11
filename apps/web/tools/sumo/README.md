# SUMO tools: job API and network builders

Native Eclipse SUMO 1.27.1 behind a small HTTP job API, plus the two scenario builders it runs.

| File | What it does |
|---|---|
| `serve.py` | Threaded, standard-library HTTP job API `/sumo/v1/*`: health, submit, status, output files, single frame. Runs one job at a time. |
| `build_demo.py` | Synthetic 2×2 grid of four junctions: `baseline` / `closure` / `guided` / `footpath`. |
| `build_real.py` | Real Melbourne CBD network (contract v2): `baseline` / `original` / `ai`, plus options mode `opt-A` … `opt-E`. |
| `smoke.py` | End-to-end check of a running `serve.py` on the synthetic network: submits a run, verifies every chunk and the `/frame` endpoint. |
| `requirements.txt` | `eclipse-sumo==1.27.1`, `sumolib==1.27.1`. The real network also needs `numpy` and `scipy`. |
| `examples/` | Metrics and one frame exported from the real API (synthetic network). Documentation samples, not a fallback. |

Every job re-runs native SUMO; the browser never computes vehicle movement for these runs. The web page reaches this API only through `apps/sumo/public/js/sumo-client.js`, which drives steps 02 and 03 (real network) and step 04 (options mode) of the workbench. The synthetic backend started as a standalone backend by @jinmingq (PR #96); @Zemmeng added the cloud deployment, the real network and options mode.

> **Post-event status.** During the hackathon this same `serve.py` ran in a Cloudflare Container behind the `hackathon-sumo` Worker (`apps/sumo`). Both were deleted after the event. The live site's `/api/sumo/v1/*` now answers `502 sumo_down`, and the page replays the pre-computed run in `apps/sumo/public/real/`. Everything below still runs locally.

> **Provenance.** The SHA-256 of `build_real.py` is stamped into `apps/sumo/public/real/index.json` as `generator_sha256`, and `apps/web/tests/test_sumo_real.py` fails if the file changes without a re-bake. Do not edit it, not even its comments, unless you re-bake the replay (see [Re-baking the replay](#re-baking-the-replay)). The SHA-256 of `build_demo.py` is likewise recorded in the provenance of `apps/sumo/public/baked/`.

## Running locally

Run from the repo root with Python ≥ 3.9. SUMO is pinned to 1.27.1; verified on macOS arm64 with Python 3.14.

```bash
python3 -m venv /tmp/rippletwin-sumo-venv
/tmp/rippletwin-sumo-venv/bin/python -m pip install -r apps/web/tools/sumo/requirements.txt numpy scipy
/tmp/rippletwin-sumo-venv/bin/python apps/web/tools/sumo/serve.py \
  --data-dir /tmp/rippletwin-sumo-jobs --port 8021 \
  --allow-origin http://127.0.0.1:8001
```

By default the server listens on `127.0.0.1` only. Set `--allow-origin` to the page's actual origin; it can be repeated. A request that carries an `Origin` header not on the list gets `403`.

| Environment variable | Flag | Default | Notes |
|---|---|---|---|
| `HOST` | `--host` | `127.0.0.1` | `0.0.0.0` in the container |
| `PORT` | `--port` | `8021` | `8080` in the container |
| `SUMO_DATA_DIR` | `--data-dir` | required | `/data` in the container |
| `ALLOW_ORIGINS` | `--allow-origin` (repeatable) | empty | comma-separated; flags are appended after the environment value |
| `SUMO_KEEP_RUNS` | `--keep-runs` | `20` | keep only the newest N complete or failed runs (about 21 MB of replay per default synthetic run); pruned at start-up and after each run |
| `SUMO_POSTS_PER_MIN` | `--posts-per-min` | `0` (no limit) | maximum POSTs per client IP per minute, otherwise `429 sumo_rate`; only for a server exposed directly |
| `SUMO_API_KEY` | none (environment only) | empty (not checked) | when set, every request except `/health` needs the header `X-Sumo-Key`, otherwise `401`; the IP rate limit then trusts the caller's `X-Client-IP`. Not used in the cloud set-up |

`build_real.py` reads four more variables; see [Real CBD network](#real-cbd-network-contract-v2-build_realpy).

The server stops on `SIGTERM`: it accepts no new requests, drops queued jobs (they are marked failed on the next start) and lets the running job finish before exiting. A request that is idle for more than 30 s while reading or writing is disconnected. Under an unsupported locale (for example `LANG=xx_YY.UTF-8`) the first line of `sumo --version` is `Warning: Could not set locale`, so the version check uses the line that starts with `Eclipse SUMO`.

Offline batch run (the output and audit directories must be empty):

```bash
/tmp/rippletwin-sumo-venv/bin/python apps/web/tools/sumo/build_demo.py \
  --seed 42 --output /tmp/sumo-output-42 --work-dir /tmp/sumo-raw-42
```

### In the cloud (during the hackathon)

The same `serve.py` ran in a Cloudflare Container (`standard-4`, one instance) built from `apps/sumo/Dockerfile`, with `HOST=0.0.0.0 PORT=8080 SUMO_DATA_DIR=/data SUMO_KEEP_RUNS=20 SUMO_REAL_JOBS=4`, `SUMO_ROADS_DIR=/app/roads/public/cbd`, `SUMO_REAL_CACHE=/app/real-cache` and `ALLOW_ORIGINS` empty. In front of it sat the Worker `hackathon-sumo` (`apps/sumo`, no `workers.dev` URL of its own). The public could reach it only through the site's `/api/sumo/v1/*`: the site forwarded over the `SUMO` service binding to `hackathon-sumo`, which allowed only the paths in the [API table](#api-v1), stripped `Origin` / `Cookie` / `Authorization`, allowed at most 3 POSTs per IP per minute, answered `429` while the container already had 2 or more jobs, and only then forwarded to the container's `/sumo/v1/*`. The container therefore had no IP rate limit of its own (every request came from the proxy). Containers sleep and restart and the disk is not persistent: after a restart every old run id answers `404`, and the page falls back to the pre-computed results (always labelled as pre-computed). See `apps/sumo/README.md` for the Worker, the image and how to redeploy.

## API v1

| Method and path | Purpose |
|---|---|
| `GET /sumo/v1/health` | verified SUMO version, queue state (`active_jobs` = queued + running) and available `networks`; no `X-Sumo-Key` needed |
| `POST /sumo/v1/runs` | start a native simulation; returns `202` and an `id` |
| `GET /sumo/v1/runs/{id}` | `queued → running → complete / failed` |
| `GET /sumo/v1/runs/{id}/index.json` | metrics, parameters and data paths for every scenario |
| `GET /sumo/v1/runs/{id}/{scenario}/manifest.json` | network geometry, signal mapping, agent catalogue, metrics and chunk index |
| `GET /sumo/v1/runs/{id}/{scenario}/frames-NNN.json` | complete compressed trajectory chunk, suited to client-side cached replay |
| `GET /sumo/v1/runs/{id}/frame?scenario=closure&t=118.9` | snapshot already converted to metres and m/s, ready for the UI (synthetic runs only) |

Example request (synthetic network):

```bash
curl http://127.0.0.1:8021/sumo/v1/runs \
  -H 'Content-Type: application/json' \
  -d '{"seed":42,"scenarios":["baseline","closure","guided","footpath"],"demand_duration_s":600,"clearance_s":1200,"demand_scale":1,"diversion_share":0.45}'
```

Every field is optional; the defaults are as above. Only whitelisted fields are accepted. `seed` is an integer in 0–2147483647; the demand window is an integer of 10–600 s; the clearance window is an integer of 600–2400 s; the demand scale is 0.1–1.2; the diversion compliance share is 0–1. The upper limits were tightened from testing (seed 42): a demand scale of 1.5 or more failed every time (collisions or the network not clearing), and a 60 s demand window with 300 s of clearance left pedestrians on the network, while 600 s passed. `baseline` is always added so there is a control. At most four unfinished jobs, run serially; beyond that the server returns `429`. Every GET endpoint also supports `HEAD` (headers only). Real-network and options-mode bodies are described below.

Polling about once a second is enough. A failed run publishes no results, and reading an unfinished result returns `409`; `failed.error` gives the reason. After a successful run `data-dir/{id}/raw/` is deleted (about 300 MB of SUMO XML for a default synthetic run) and only `output/` stays. After a failure `output/` and any XML over 1 MB in `raw/` are deleted, while the logs, the exact commands and the shared demand stay for diagnosis. Only the newest `SUMO_KEEP_RUNS` (default 20) complete or failed runs are kept; older run directories are deleted and then answer `404`. After a restart the same service can still serve the completed results that remain, and unfinished jobs are marked failed. If heavy demand fails to clear, create a new job with a larger `clearance_s`; vehicles or pedestrians that have not arrived must never be treated as gone.

Every error is `{ "ok": false, "error": "<code>", "msg": "<explanation>" }` (see `docs/reference/interfaces.md`, error format; the Worker passes it through unchanged): `400 bad_request / bad_config / bad_json`, `401 bad_key`, `403 bad_origin`, `404 not_found`, `409 not_ready`, `413 too_big`, `415 bad_type`, `429 sumo_busy` (queue full) / `sumo_rate` (IP rate limit), `500 sumo_error`. The Workers' own codes (`sumo_off`, `sumo_down`, `sumo_starting` and so on) are listed in `apps/sumo/README.md`.

## Synthetic 2×2 network (`build_demo.py`)

### Data for the front end

Load `manifest.json` first to build the scene, then the trajectory chunks; `/frame` can also be requested on demand. The API is independent of the DOM, Canvas or any rendering library.

- `/frame` returns `time_s` (the actual sample time), `requested_time_s`, `done`, `agents[]`, `signals`, `queues[]` and `counts`. A request for 118.9 s returns the 118 s snapshot; intermediate positions are never invented. After the end, `done=true` and the agent list is empty.
- An agent has `id / kind / x_m / y_m / angle_deg / speed_mps / length_m / width_m / lane_id`, with kind `car / bus / ped`. Coordinates are local metres, x east and y north; the angle is clockwise from north. They are not latitude and longitude. **Vehicle front-bumper positions are already converted to the body centre, so the front end must not subtract half a vehicle length again.**
- The four junction centres are A(140,300), B(340,300), C(140,140) and D(340,140); the values returned in `geometry.junctions` are authoritative. `geometry.lanes` holds SUMO polylines, lane width, length, kind and closure state; internal connections, crossings and walking areas are included.
- `signals` holds the raw SUMO signal strings. Map them to lanes with `geometry.signals[].junction/index/lane`: `G/g` = go (different priority), `y` = amber, `r` = red. Do not invent signal timing in the front end.
- `queues[]` is the maximum continuous queue length per lane from the detectors, not the sum along a whole road. `counts.running/waiting/ended/halting` count motor vehicles; pedestrians are told apart by `kind` in `agents`.
- Each chunk row `a` is `[agentIndex, x cm, y cm, heading, speed cm/s, laneIndex]`; the indices point into the manifest's `agents` and `geometry.lanes`, and `-1` means an unknown lane. `q` is `[laneIndex, queue metres]`. The field order is also given in `agent_columns`. Every chunk has a SHA-256 for integrity checks.
- Geometry, positions and sizes share one scale: do not enlarge vehicles while keeping the original spacing, and do not interpolate in straight lines through curves. Sampling is currently 1 s with a native physics step of 0.2 s; the exact trajectories follow SUMO's rules, and display interpolation must not be used to re-judge collisions.

`metrics.mean_journey_s` includes waiting before a vehicle enters the network; `mean_extra_journey_s` compares the same complete trips with the no-works run. `mean_ped_journey_s` is the walking trip time; `sidewalk_users` is the number of distinct people who used that footpath during the whole run, **not an instantaneous density**. Metrics are published only after every vehicle and pedestrian has finished.

### Scenarios and assumptions

The four scenarios share desired departure times, agent ids, vehicle types and destinations:

- `baseline`: no works.
- `closure`: the inner lane of A → B is closed; the other lane stays open.
- `guided`: the same closure; eligible cars pre-select A → C → D → B according to a fixed seed and `diversion_share`. Buses go straight. This is not dynamic optimisation or an AI prediction.
- `footpath`: the same closure, plus the A → B footpath closed, so SUMO re-plans walkable routes. Closing a footpath rebuilds the pedestrian network; changing permissions after generation is not enough, because SUMO's walking-area connections would break.

Block size 200 × 160 m, 140 m approach links, two 3.2 m lanes per direction, 2.4 m footpaths, a 40 km/h speed limit and automatically generated fixed signal plans are all **model assumptions**. Default flows are 1,150 veh/h on the main direction and 300–580 veh/h elsewhere; a bus every 60 s; three pedestrian groups of 720 / 500 / 360 people per hour. Car and pedestrian demand are generated as Poisson processes; the default seed 42 produces 483 vehicles and 276 pedestrians. No measured traffic counts are used, so the results must not be called a prediction for real Melbourne.

The model covers car following, lane choice, right of way, signals, queueing and spill-back caused by finite lane space, pedestrian counter-flow interaction and legal detours. It does not cover bicycles, trams, weather, understanding VMS text or field calibration. It uses the default `Krauss` car-following and `striping` pedestrian models; vehicle teleporting is off, the pedestrian forced-escape time is far longer than the run, and junction collision checks are on. A collision, teleport, emergency stop, emergency braking, stuck pedestrian or failure to clear fails the job; the error stays in the audit log and no successful result is faked. Zero collisions only means this model run passed its checks.

Background and output references: [SUMO safety checks](https://sumo.dlr.de/docs/Simulation/Safety.html), [junctions and right of way](https://sumo.dlr.de/docs/Simulation/Intersections.html), [pedestrian models](https://sumo.dlr.de/docs/Simulation/Pedestrians.html), [FCD trajectory coordinates](https://sumo.dlr.de/docs/Simulation/Output/FCDOutput.html), [trip metrics](https://sumo.dlr.de/docs/Simulation/Output/TripInfo.html), [E2 queue detectors](https://sumo.dlr.de/docs/Simulation/Output/Lanearea_Detectors_%28E2%29.html).

## Real CBD network (contract v2, `build_real.py`)

The vehicles on the step 02 map are computed by SUMO on the **real network**. `build_real.py` reads `network.json` (OSM links), `signals.json` (SCATS junctions) and `flows.json` (weekday 08:00–09:00 flows per link) from `apps/roads/public/cbd/`. SUMO runs the **whole 08:00–09:00 hour** and computes the 09:00 queue itself; the works link's discharge capacity matches the engine's assumption, so the result can be compared fairly with the engine's 918 m queue.

- **Network**: Elizabeth–Spring × Bourke–La Trobe (+35 m margin, covering 16 SCATS junctions and pedestrian signal 2935 at the works), plus room for the queue: east of Russell St to the eastern edge of `network.json` (Albert St east of Spring, to Gisborne St, Nicholson St and Victoria Pde), south to Collins St, and about 170 m north of La Trobe (`AREA_BOXES`; 197 nodes / 356 links). The westbound Lonsdale → Albert St chain upstream of the works is 849 m long (Spring St at 437 m). Cutting only the Albert St corridor and dropping the large merged OSM junctions in the north-east corner was tried: routeSampler then chose a different route set, southbound Russell St locked up turning right at Russell × Lonsdale, and even without works nearly 200 vehicles bound through the works were waiting to enter the network at 09:00. That was worse, so the north-east corner stays.
- **Time**: the network starts empty at 07:57:00 with 08:00 demand and **no works yet**; the 180 s warm-up is not shown. **The lane closes at 08:00:00** (`works.add.xml`: a rerouter `closingLaneReroute` closes the median-side lane and a speed sign sets the remaining lane to 30 km/h). Shown and measured: 08:00–09:00 (`clock0_s = 0`, `duration_s = 3600`, `sample_s = 2`).
- **Capacity**: signal 2935 gives Lonsdale traffic **50%** green + amber (42 s green / 3 s amber / 45 s red). That gives about 1,800 veh/h on two lanes and about 800 with one closed, matching the engine's 1,800 × ½ × 0.9 = **810 veh/h**. The discharge SUMO actually achieves is reported as `metrics.works_throughput_vph` (baked copy: original 805, AI plan 788, no works 1,161 = demand).
- **Jams and deadlocks**: vehicles are never deleted. `--ignore-junction-blocker 60` (crossing traffic stops yielding to a vehicle that has blocked a junction for 60 s) + `--time-to-teleport 300` (SUMO's default: only a vehicle that has not moved at all for 300 s is moved ahead along its route). Turning teleporting off entirely was tried: in the no-works scenario, from 07:03 a right-turning vehicle at Little Bourke × Swanston could not find space downstream, a loop of Swanston / La Trobe / Elizabeth locked up, and more than 500 vehicles were stationary at 09:00. That is a deadlock of SUMO's junction model, not an effect of the works. Vehicles queued behind the works move up every 90 s cycle and are never teleported; every teleport is counted and located (`teleports_in_hour`, `teleports_works_bound`, `teleport_edges`; 0–2 in the baked copy, none on the works route).
- **Replay**: frames are written only for `original` / `ai` (`baseline` has `chunks: []` and `agents: []`: metrics only, not played by the page), and only for vehicles inside the page's view: `VIEW_BOX` = the 16 junctions + 12 m, extended 140 m east towards Spring St. One frame every 2 s, 60 frames (2 minutes) per chunk, 30 chunks.

| id | Works | Diversion share | Notes |
|---|---|---|---|
| `baseline` | none | 0 | control (metrics only) |
| `original` | from 08:00 the right lane of Lonsdale St westbound `l595594354_9756035316` (42 m) is closed; the remaining lane runs at 30 km/h | `p_original`, default 0.14 | the engine's reading of "ROADWORK AHEAD" |
| `ai` | as above | `p_ai`, default 0.53 | the engine's reading of "USE RUSSELL / SAVE 9 MIN" |

Directory format (identical for the baked copy and live runs): `index.json` + `<id>/manifest.json` + `<id>/frames-NNN.json`; the fields are documented under contract v2 in `docs/reference/interfaces.md`. Key points: positions are the **vehicle centre** (converted from FCD's front bumper), with longitude and latitude × 1e6 rounded to integers. `angle_deg` follows the SUMO convention (0 = north, clockwise, rounded to 1°); in page coordinates (x east, y north) the heading is `[sin a, cos a]`. Each frame's `tls` holds the raw signal strings of the controllers with signal heads in view (19), and `signal_heads[].idx` points into the string (any `G/g` = green, otherwise any `y/Y` = amber, otherwise red). `q` is the continuous queue in metres upstream of the start of the works with gaps ≤ 60 m (vehicles slower than 1.5 m/s). `index.params` adds `hour_window: [8, 9]`, `green_2935`, `network_extent` (Chinese text in `network_extent_zh`), `sim_s` (3,780), `warmup_s` (180, before 08:00), `sample_s`, `chain_m`, `engine_capacity_vph`, `time_to_teleport_s` and `ignore_junction_blocker_s`.

### Re-baking the replay

```bash
# The baked copy must be produced in the same linux/amd64 image as the cloud: routeSampler picks different demand on macOS and Linux
docker build --platform linux/amd64 -f apps/sumo/Dockerfile -t hackathon-sumo:hour apps
mkdir -p ~/.cache/t48bake && rm -rf ~/.cache/t48bake/bake42   # colima mounts only the home directory, not /tmp
docker run --rm --platform linux/amd64 --cpus 4 -e SUMO_REAL_SOURCE=docker-linux-amd64 -v ~/.cache/t48bake:/bake hackathon-sumo:hour \
  python web/tools/sumo/build_real.py --seed 42 --output /bake/bake42 --work-dir /bake/bake42-raw
rm -rf apps/sumo/public/real && cp -R ~/.cache/t48bake/bake42 apps/sumo/public/real
# Local trial run (results differ from Linux; only for shape / timing); cache-only build (network + demand), used to warm the image at build time
/tmp/rippletwin-sumo-venv/bin/python apps/web/tools/sumo/build_real.py --seed 42 --output /tmp/sumo-real-42 --work-dir /tmp/sumo-real-raw-42
/tmp/rippletwin-sumo-venv/bin/python apps/web/tools/sumo/build_real.py --prepare-only
```

Beyond `requirements.txt`, the first cache build also needs `numpy scipy` (for SUMO's bundled `routeSampler.py`). Python interface: `build_real.build(args)` (`args.seed / p_original / p_ai / scenarios / output / work_dir`; raises on failure) and `build_real.validate_real(payload)` (whitelist: `seed` an integer in 0–2147483647, `p_original` / `p_ai` in 0–1, `scenarios` a non-empty subset of `baseline / original / ai` without duplicates; may carry `"network": "real"`; any other field raises `ValueError`). `build()` starts one subprocess per scenario (`build_real.py --job`, which runs SUMO and parses the FCD), so the scenarios run truly in parallel. Any change to `build_real.py` requires a re-bake; `test_sumo_real.py` checks `generator_sha256`.

| Environment variable | Default | Notes |
|---|---|---|
| `SUMO_ROADS_DIR` | the repo's `apps/roads/public/cbd` | `/app/roads/public/cbd` in the container |
| `SUMO_REAL_CACHE` | `rippletwin-sumo-real-cache/` in the system temp directory | one subdirectory per hash of "this script + SUMO version + the three input files + 2935 green share"; atomic rename, safe across processes |
| `SUMO_REAL_JOBS` | `min(3, CPU count)` | how many scenarios run at once (`4` in the container) |
| `SUMO_REAL_SOURCE` | `local-macos-arm64` on macOS arm64, otherwise `<platform>-<arch>` | written to `index.params.source`; the baked copy says `docker-linux-amd64` |

**Measured run time** (seed 42, three scenarios, warm cache): 32–35 s locally on Apple silicon (per scenario SUMO 20–27 s + FCD parsing 6–8 s, 3 in parallel); colima linux/amd64 (Rosetta) 50 s with `--cpus 4` and 99 s with `--cpus 1`. The committed bake records its wall time in `timing.total_s` of `index.json` (about 27–32 s). The cloud container was a `standard-4` instance (4 vCPU, native amd64, no translation), and the page waits up to 180 s. A cold cache adds about 6 s (the image already contains it). Replay size: original 15.1 MB, AI plan 16.1 MB (30 chunks each, largest 0.58 MB); `baseline` is an 11 KB manifest only.

**Demand**: all 207 links have SCATS counts (97 measured, the rest interpolated). routeSampler picks about 150 routes and about 15,700 veh/h, of which 1,143 veh/h pass through the works (SCATS count 1,144). Each seed redraws departure times as Poisson arrivals (the three scenarios share the same vehicles and the same diversion draw). Cars only. Note that SCATS shows 1,144 veh/h at the works but only 513 on westbound Lonsdale St at Russell St. routeSampler brings part of the difference in from Russell St and lets part depart mid-link from the Lonsdale links either side of Russell (equivalent to traffic leaving car parks or laneways); once the queue reaches them, these vehicles cannot enter the network and count as "waiting to enter". Entries in the north-east corner (Nicholson St / Victoria Pde) and northern Swanston St cannot insert vehicles under netconvert's default signal plans even without works (a backlog of about 900 at 09:00). This is unrelated to the works; it is reported as `insertion_backlog_end` and raises `mean_timeloss_s` equally in all three scenarios (`mean_extra_s` subtracts the same vehicles, so it cancels out). **Safety**: a collision on a lane fails the run. "Collisions" inside junctions (overlapping internal lane geometry of large merged OSM junctions, plus vehicles released by ignore-junction-blocker) are logged as `warn` without changing the dynamics and reported separately as `metrics.junction_collisions` (66–67 in the baked copy).

**Metrics** (all earlier ones are kept): `mean_timeloss_s` = time loss accumulated by 09:00 by the cohort departing 08:00–09:00 (including waiting to enter); `mean_extra_s` = the same vehicles' excess over `baseline`; `works_traffic_extra_s` = the same for vehicles whose original route passes through the works; `detour_vehicles` / `eligible_vehicles` = vehicles that actually detoured / were eligible to detour during the hour; `per_minute.halting` / `harsh` = mean number of stopped vehicles in view / harsh-braking events per minute (sampled every 2 s). Added for the full-hour run:

| Field | Meaning |
|---|---|
| `works_queue_end_m` | **physical queue** at 09:00: how far upstream of the works the stopped vehicles (< 1.5 m/s, gaps ≤ 60 m) reach on the westbound Lonsdale / Albert St chain; the longest over the last 90 s cycle |
| `works_queue_equiv_end_m` | **engine method** at 09:00: vehicles bound through the works that are queued behind it (distance to the works along each route, gaps ≤ 60 m joined into one queue, including spill-back onto Russell / Exhibition / Spring St) + those still waiting to enter; mean vehicle count over the last cycle × 7 m ÷ 2 |
| `works_queue_equiv_end_vehicles` | that vehicle count split into `lonsdale_albert` / `side_streets` / `waiting_to_enter` |
| `queue_series` | `[[minute, physical queue m, engine method m], …]`, one entry per minute from 0 to 60, same rules as above |
| `works_queue_vs_baseline_end_m` | baseline-comparison method (only when the same run also ran `baseline`): vehicles of the same cohort that had passed the works by 09:00 without works but had not with works, × 3.5 m, i.e. the D/D/1 queue count |
| `works_throughput_vph` / `works_demand_vph` | vehicles actually passing the detector at the end of the works during the hour / vehicles departing during the hour whose route passes through the works (not detoured) |
| `works_capacity_assumption_vph` | 810 (the engine's assumption, not a SUMO input; see the previous row for what SUMO actually discharges) |
| `insertion_backlog_end`, `teleports_in_hour`, `teleports_works_bound`, `teleport_edges`, `works_queue_equiv_max_m` | see above |

**Baked copy (linux/amd64, seed 42)**:

| | Physical queue 09:00 / max | Engine method 09:00 | Baseline-comparison method | Discharge veh/h | Demand veh/h | Where those vehicles are at 09:00 (chain / side streets / not yet entered) | Detoured | Teleports |
|---|---|---|---|---|---|---|---|---|
| No works | 23 / 152 m | 15 m | — | 1,161 | 1,173 | 3.5 / 0 / 0.8 | 0 | 1 |
| Original plan | 246 / 373 m | **973 m** | 991 m | 805 | 1,100 | 22 / 15 / 241 | 73 / 538 | 0 |
| AI plan | 260 / 278 m | **305 m** | 312 m | 788 | 886 | 8 / 1 / 78 | 287 / 538 | 2 |

Compared with the engine's 918 m: engine demand = 1,144 − 513 × 0.14 = 1,072 veh/h against a capacity of 810, so 262 extra vehicles per hour → 918 m. SUMO uses the same capacity assumption (discharging 805); this draw has slightly higher demand (1,100, from Poisson sampling, with 73 vehicles detoured), so 295 extra vehicles → 973 m by the engine method and 991 m by the baseline-comparison method, 6–8% longer than 918 m. The difference comes from demand sampling. But the queue **standing on the road** is only about 250 m (longest 373 m, short of Exhibition St), not a queue all the way along Lonsdale St to Spring St as on the engine's map: Russell St is only about 100 m from the works and the upstream links cannot hold it. Most of the delayed vehicles should have entered mid-link from the Lonsdale links either side of Russell St (SCATS 513 → 1,144) and are held out by the queue; a few spill back onto Russell St. On macOS the same seed samples different demand: original 1,065 m, AI plan 394 m. This is a cross-check between models, not a measurement.

### Options mode (`options`)

Same network, same works (one lane closed); each option changes only the diversion share p. `POST /sumo/v1/runs` with `{"network":"real","seed":42,"options":[{"id":"A","p":0.14},{"id":"B","p":0.14},{"id":"C","p":0.607}]}` (1–5 `options`, unique `id` in A–E, `p` in 0–1; optional `"frames":true`, default `false`; cannot be combined with `p_original` / `p_ai` / `scenarios`, otherwise 400 `bad_config`). One job runs `baseline` + `opt-A` / `opt-B` / `opt-C` over the full hour (lane closed at 08:00, run to 09:00). The directory is still contract v2 (`index.json` + `<id>/manifest.json`), with the same metric fields as `original` / `ai`, including every full-hour metric such as `works_queue_equiv_end_m`, `works_queue_end_m`, `queue_series`, `works_throughput_vph`, `works_traffic_extra_s` and `detour_vehicles`; `label` is bilingual (`Option A` in English). `frames:true` writes frames only for `opt-<id>`; `baseline` stays metrics-only. Options with the same p (same seed, same vehicles, same draw, so identical results) run once; later ones copy the manifest and carry `reused_from: "opt-A"` (they are absent from `index.timing.sumo_s`). With `frames:false` the manifest has `chunks: []` and no `frames-NNN.json` is written. Command line: `build_real.py --options A=0.14 B=0.14 C=0.607 [--frames] --output …`. An option with p = 0.14 matches `original` metric for metric (`test_sumo_real.py` checks this with a real run).

Measured (one-hour version, 10-core Apple silicon, seed 42, A 0.14 / B 0.14 / C 0.605 + baseline, metrics only, 3 SUMO processes actually run): 16.6–18.3 s with 3 in parallel (18.3 s with a cold cache; building the cache takes about 3 s); 35.4 s one at a time with `SUMO_REAL_JOBS=1` (roughly single-core). The original three scenarios take 16.9–17.9 s on the same machine. There is no pre-computed fallback: `runOptions(options, {seed, onStatus, signal, timeoutMs = 180000})` in `sumo-client.js` returns `{source:'live', runId, index}` on success and `{source:'none', reason}` on failure. The web's step 04 sends plans A (no VMS), B (two VMS showing the delay) and C (one VMS naming the detour) with p taken from the engine's sign readings.

## Verification

```bash
python3 apps/web/tests/test_sumo_real.py   # shape / hash / ranges / queue metrics of the baked copy; set SUMO_PY=<venv python> to re-run SUMO and check reproducibility (about 1–2 minutes)
python3 apps/web/tests/test_sumo_backend.py
# With the server running: submit a new synthetic-network job and check every trajectory chunk and endpoint
python3 apps/web/tools/sumo/smoke.py
# Or verify an existing job to avoid recomputing
python3 apps/web/tools/sumo/smoke.py --run-id RUN_ID
# Through a deployed site (Worker rate limit: no more than 3 runs a minute); the hackathon deployment is offline, so this now fails with 502
python3 apps/web/tools/sumo/smoke.py --base https://<site>/api/sumo/v1
```
