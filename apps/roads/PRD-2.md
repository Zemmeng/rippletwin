# T3 phase 2 PRD: pedestrians, public transport, equipment inventory

*Original hackathon PRD (phase 2), written on 29 Sep 2026 during the FEIT Hackathon Festival. Translated from the original Chinese; superseded details are kept as they were, with later outcomes noted in brackets. For the module as built, see [README.md](README.md).*

> Owner: @louisxie316-dotcom · Module: `apps/roads/` · Branch: `louisxie316-dotcom/roads/T<n>-…` once the lead assigns a task number · Issue #11
> Written 2026-09-29 13:55 (compiled by @jinmingq). Follows `PRD.md` (phase 1, PR #9). The new file formats are drafts; once final, the lead adds them to `docs/contract.md` (now [docs/reference/interfaces.md](../../docs/reference/interfaces.md)).
>
> **Summary (English in the original):** Phase 2 of T3. PR #9 covers vehicle traffic. The brief also names **pedestrians, public transport** and the **equipment inventory (barriers, signage, VMS)**, none of which has data yet. Please produce `equipment.json`, `transit.json`, `walk.json` + `peds.json` (P0), linked to `network.json` link ids. Same rules as `PRD.md` §9.

## 1. Why this is needed

The challenge text: *"…knock-on effects on surrounding **traffic, pedestrians, and public transport** … using typical traffic **equipment inventory (barriers, signage, VMS boards)**…"*

PR #9 has finished "vehicle traffic". The other two kinds of impact (pedestrians, public transport) and the equipment inventory currently have **no data at all**: T4 cannot compute the impact on pedestrians and public transport, and T2's equipment panel has no equipment list. The "walking network, public transport routes (a separate task later)" in `PRD.md` §4 is this task.

## 2. Ground rules (same as `PRD.md` §9, with one addition)

- Change only `apps/roads/`; scripts go in `tools/*.py`, re-runnable with one command, with the area passed as `--bbox`, not hard-coded
- Raw data goes in `raw/` (gitignored), outputs in `public/cbd/`, **each file < 2 MB**; no keys, no cost
- New: **every new file must link to `network.json` link ids** (field `road_link`). When T4 closes a stretch of road, it must be able to look up the sidewalks, tram / bus routes and stops on that stretch directly
- Periods align with `flows.json`: 2026-08-01..09-27, 24 numbers each for weekdays `wd` and weekends `we` (index = hour)
- Every estimated number is labelled with a `method`, assumptions go in `assumptions`, and the README explains them

## 3. P0: must do (the three things the challenge names)

| # | File | For | Estimate |
|---|---|---|---|
| A | `equipment.json` equipment inventory | T2 equipment panel, T4 equipment effects, T5 VMS character count | 1h |
| B | `transit.json` trams and buses | T4 public transport impact, T2 drawing routes and stops | 2h |
| C | `walk.json` + `peds.json` pedestrians | T4 pedestrian detours, T2 drawing sidewalks | 2–3h |

### A. `equipment.json`: equipment inventory

The challenge's input is "a typical equipment inventory", which users rely on to describe a works plan. Each kind of equipment must state clearly **what it does in the model**.

```json
{
  "version": 1,
  "sources": ["RPM Hire product pages (types, specifications)", "Quantities and day rates are assumptions"],
  "items": [
    { "id": "barrier_water", "category": "barrier", "name": "Water-filled barrier",
      "effect": "close", "can_close": ["lane", "footpath", "bike_lane"], "unit_len_m": 2.0,
      "qty": 200, "day_rate_aud": 0, "assumed": ["qty", "day_rate_aud"],
      "url": "https://www.rpmhire.com.au/products/water-filled-barriers/" },
    { "id": "sign_footpath_closed", "category": "sign", "name": "Footpath closed, use other side",
      "effect": "route_peds", "qty": 50, "day_rate_aud": 0, "assumed": ["qty", "day_rate_aud"] },
    { "id": "vms", "category": "vms", "name": "Variable Message Sign",
      "effect": "message", "lines": 3, "chars_per_line": 0, "qty": 6, "day_rate_aud": 0,
      "assumed": ["qty", "day_rate_aud"],
      "url": "https://www.rpmhire.com.au/products/variable-message-signs/" }
  ]
}
```
(The numbers in the example are placeholders only; fill them from the product page specifications.)

- `category` ∈ `barrier / sign / vms / arrow_board / ped_signal`
- `effect` starts with these 6 values; tell T4 before adding more: `close` (the barrier encloses what is in `can_close`), `route_vehicles` (vehicle detour direction), `route_peds` (pedestrian diversion), `warn` (advance warnings such as roadwork ahead), `message` (free VMS text), `control_crossing` (portable pedestrian signals)
- **Minimum list**: 1–2 kinds of barrier; 5–6 static signs (Roadwork ahead, Lane closed, Detour left / right / straight ahead, Footpath closed use other side, Bike lane closed / Bicycles merge, End roadwork); VMS; arrow board; portable pedestrian signals. Where a sign has a standard code (AS 1742.3 / AGTTM), fill in `code`
- Copy the specifications (barrier section length, VMS lines, characters per line) from the RPM Hire product pages: [catalogue](https://www.rpmhire.com.au/) · [VMS](https://www.rpmhire.com.au/products/variable-message-signs/) · [arrow boards](https://www.rpmhire.com.au/products/arrow-boards/) · [portable pedestrian signals](https://www.rpmhire.com.au/products/pedestrian-portable-traffic-lights/) · [water-filled barriers](https://www.rpmhire.com.au/products/water-filled-barriers/). The site **publishes no prices**: use assumed values for `qty` and `day_rate_aud` and list them in `assumed`
- Record only types, specifications and links; **do not copy the site's images or long passages of text**

### B. `transit.json`: trams and buses

The key point in the CBD: **trams cannot detour** (they run on rails). T4 relies on this data to decide three things: works that touch a tram line mean "line interrupted"; on links where trams share the road with cars, congestion carries over to the trams; buses can detour but skip stops.

- Data: [DataVic "GTFS Schedule"](https://discover.data.vic.gov.au/dataset/gtfs-schedule) (CC BY 4.0, updated 09-26). The full bundle is 275 MB and contains one `google_transit.zip` per mode; by PTV convention `3/` is tram (18 MB) and `4/` is metropolitan bus (104 MB); check `routes.txt` after unzipping. The server supports HTTP Range, so you can follow `fetch_scats.py` and extract only `3/` and `4/`. Trains are not affected by roadworks, so leave them out
- Pick one normal weekday and one Saturday (avoiding public holidays) and record the dates in `service_dates`

```json
{
  "version": 1,
  "sources": ["PTV GTFS Schedule (DataVic, CC BY 4.0), 2026-09-26"],
  "service_dates": { "wd": "2026-09-29", "we": "2026-10-03" },
  "routes": [
    { "id": "tram_96", "mode": "tram", "short": "96", "name": "…",
      "dirs": [ { "dir": 0, "headsign": "…", "links": ["l12", "l13"], "offnet_m": 0,
                  "stops": ["s1001", "s1002"],
                  "trips": { "wd": [0, 0, "…24 in total"], "we": ["…24 in total"] },
                  "geometry": [[-37.81, 144.96]] } ] }
  ],
  "stops": [ { "id": "s1001", "name": "…", "lat": -37.81, "lon": 144.96, "road_link": "l12", "routes": ["tram_96"] } ],
  "coverage": { "routes": 0, "stops": 0, "matched_len_pct": 0 }
}
```

*[As built, `routes[]` carry `id`, `mode`, `short` and `dirs` with no `name`; `stops[]` also carry `mode`, and stop ids are `st_<gtfs id>` / `sb_<gtfs id>`.]*

- `links`: map the `shapes.txt` alignment, in order, onto the directed links of `network.json` (within 15 m, same direction)
- `offnet_m`: length that cannot be matched to the drivable network, for example tram-only sections such as Swanston St and Bourke St Mall. Keep `geometry` for these sections so T2 can draw them; do not force them into `links`
- `trips`: trips per hour per direction; `stops[].road_link`: the link the stop is on
- Average passengers per vehicle belongs to P1-E

### C. `walk.json` + `peds.json`: pedestrians

**`walk.json`**: the walking network, undirected.

```json
{
  "version": 1,
  "sources": ["© OpenStreetMap contributors (ODbL)"],
  "nodes": [ { "id": "w123", "lat": -37.81, "lon": 144.96 } ],
  "links": [ { "id": "wl1", "a": "w1", "b": "w2", "len_m": 35.2, "kind": "sidewalk",
               "crossing": null, "road_link": "l12", "side": "left",
               "geometry": [[-37.81, 144.96], [-37.8102, 144.9603]] } ]
}
```

- First choice is OSMnx `network_type="walk"`. **First check whether CBD sidewalks are drawn as separate lines**: if most exist only as `sidewalk=*` tags on roads, switch to the City of Melbourne [Pedestrian Network](https://data.melbourne.vic.gov.au/explore/dataset/pedestrian-network/) (CC BY). Record the choice in the README
- `kind` ∈ `sidewalk / crossing / path / mall / other`; `crossing` ∈ `signal / zebra / uncontrolled / null`
- `road_link` + `side`: which directed link this sidewalk runs beside, and whether it is on that link's left or right. Australia drives on the left, so on a two-way road the sidewalk beside one direction of traffic is usually on the left of that directed link. When T4 closes a "footpath", this is how it finds the walking links to cut
- Derive ids from OSM ids so they stay stable across re-runs

**`peds.json`**: pedestrian volumes, in the same layout as `flows.json`.

```json
{
  "version": 1, "unit": "ped/h",
  "period": "2026-08-01..2026-09-27 (same as flows.json)",
  "sensors": [ { "id": "45", "name": "Swa148_T", "lat": -37.8141, "lon": 144.9661, "walk_link": "wl88", "road_link": "l12" } ],
  "days": { "wd": { "wl88": [0, 0, "…24 in total"] }, "we": { "…": [] } },
  "method": { "wl88": "sensor" },
  "coverage": { "links": 0, "measured": 0, "estimated": 0 }
}
```

- Data: the City of Melbourne [Pedestrian Counting System (counts per hour)](https://data.melbourne.vic.gov.au/explore/dataset/pedestrian-counting-system-monthly-counts-per-hour/) and [Sensor Locations](https://data.melbourne.vic.gov.au/explore/dataset/pedestrian-counting-system-sensor-locations/), both CC BY. Checked on 09-29: the data is updated to 09-28
- Export these 8 weeks directly from the API, about 130,000 rows; no need to download everything:
  ```
  curl -G "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-monthly-counts-per-hour/exports/csv" \
    --data-urlencode "where=sensing_date>=date'2026-08-01' and sensing_date<=date'2026-09-27'" -o apps/roads/raw/peds.csv
  ```
- Columns: `location_id, sensing_date, hourday, direction_1, direction_2, pedestriancount, sensor_name, location`. `pedestriancount` = the sum of both directions (spot-checked on a few rows). About 96 sensors near the CBD have data for these 8 weeks
- `method` ∈ `sensor / street_interp / class_default`, with the same meaning as in `flows.json`

## 4. P1: bonus, after P0 is done

*[None of D, F or G was delivered in `apps/roads`: `DETECTOR_MAP` still covers only site 2921 and there is no `rules.json`. Item E (value of time, car occupancy) was picked up in `apps/params` (T12).]*

- **D. Evidence for the road-user mix**: T5's four road-user shares (commuter 50%, local 25%, tourist 10%, delivery 15%) are currently guesses. Possible evidence: the delivery share from the heavy-vehicle share in [Historical AADT](https://discover.data.vic.gov.au/dataset/historical-annual-average-daily-traffic-volume) (to 2019, arterial roads only). For the other three, use public sources if any can be found; otherwise write "no source, assumption kept" in the README. Check with whoever takes T5 first; either side can do the search
- **E. Conversion parameters in `params.json`**: value of travel time and vehicle occupancy from [ATAP PV2 · Travel time](https://www.atap.gov.au/parameter-values/road-transport/3-travel-time); average passengers per tram and bus estimated from [Monthly average patronage by day type and by mode](https://discover.data.vic.gov.au/dataset/monthly-average-patronage-by-day-type-and-by-mode) divided by the number of services, with the method written down. T4 uses it to convert vehicle-minutes into person-minutes, and the pitch uses it to convert delay into Australian dollars
- **F. Flow correction**: the next step already noted in PR #9: map more junctions' detector configuration sheets (`detector_map`) to fix "per lane about 1/3 below measured"
- **G. `rules.json` placement rules**: advance warning distances, taper lengths, minimum width of temporary pedestrian paths. Source AGTTM / AS 1742.3; fill from the original tables if they can be found, otherwise write down the assumptions. T2 uses it to check whether equipment is placed compliantly

## 5. P2: if there is time

- Wheelchairs: the City of Melbourne [Footpath steepness](https://data.melbourne.vic.gov.au/explore/dataset/footpath-steepness/), to flag detours too steep for a wheelchair
- Bikes: some SCATS detectors are bike-only (see `PRD.md` §6); collecting them gives cycling volumes

## 6. Acceptance (add to `tests/test_roads.py`; passes only when `bash apps/roads/test.sh` is all green)

1. Every new file: `version` is an integer, file < 2 MB
2. Referential integrity: every `road_link` and `routes[].dirs[].links` entry is a real link in `network.json`; references between `walk_link`, `stops` and `routes` all exist
3. Every 24-hour array in `peds.json` and `transit.json`: length 24, all numbers non-negative
4. `equipment.json`: unique ids; `category` and `effect` take the values above; `barrier` has `unit_len_m > 0`; `vms` has `lines` and `chars_per_line`; every item has `qty ≥ 0`, and every assumed field is listed in `assumed`
5. `walk.json` connectivity: the largest connected component has ≥ 90% of nodes
6. Sanity checks:
   - At least one tram route runs on a La Trobe St link; of the links used by tram routes, ≥ 80% have `tram = true` in `network.json` (which also verifies PR #9's tram flags)
   - The maximum over all sensors of the busiest weekday hour lies between 500 and 10,000 people per hour. Reference: Swanston St `Swa148_T` had 1,626 at 17:00 on 09-27

## 7. Time boxes (suggested; the lead can adjust)

| Time | What to hand over |
|---|---|
| After PR #9 is merged into main | Branch `louisxie316-dotcom/roads/T<n>-…` from main and deliver A (`equipment.json`) first, so T2 can build the equipment panel straight away |
| 21:00 integration point | B (`transit.json`) |
| Wednesday 09:00 integration point | C (`walk.json` + `peds.json`); mark the PR ready, `check.sh --quick` all green |
| Before Wednesday noon | As much of P1 as possible |

## 8. Out of scope

- The behaviour parameters themselves (T5), delay and detour calculations (T4), the interface (T2)
- GTFS Realtime, PTV Timetable API: they need a key, and the demo does not need real-time data

## Change log

| Time | Who | What changed |
|---|---|---|
| 09-29 13:55 | @jinmingq | First version (same content as issue #11) |
