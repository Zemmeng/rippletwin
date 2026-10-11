# params: sourced behaviour and valuation parameters

Owner: @Unzzip

One static file, [`public/params.json`](public/params.json), holds the parameters behind the engine's route-choice model: the mix of road-user personas, the two calibration anchors for sign-driven diversion, per-persona behaviour, VMS legibility and the value of travel time. Every value carries a source, a confidence rating and a note. The rule is never to invent a number: if nothing citable was found, the value is `null` with confidence `none`, and the engine falls back to its own assumption for that item.

The file is hand-written, not generated. The `hackathon-site` Worker serves it at `/params/public/params.json`; this module has no runtime code.

## Schema

Each parameter is an object with these fields:

| Field | Meaning |
|---|---|
| `value` | The number (or boolean), or `null` when no usable source was found |
| `range` | Plausible interval `[low, high]`, or `null` |
| `unit` | `share`, `ratio`, `relative`, `bool`, `count`, `m_per_mm_capheight`, `words_per_second`, `aud_per_person_hour`, `persons_per_vehicle`, `aud_per_vehicle_hour` |
| `source` | Where the value comes from; derived values state their formula |
| `confidence` | `high`, `medium`, `low` or `none` |
| `note` | What the value means and its caveats |

Top-level groups: `mix`, `anchors`, `persona.<commuter|local|tourist|delivery>`, `vms`, `value_of_time`, `risk_preference`, `time_of_day_mix`, plus `version`, `generated`, `note` and `mix_sum_check` (a reminder that the shares sum to 1, not a parameter). All keys are ASCII ([decision D-05](../../docs/decisions.md)).

```bash
python3 -m json.tool apps/params/public/params.json >/dev/null && echo ok   # quick syntax check
```

## How it is used

- **Engine.** [`apps/engine/public/js/params.js`](../engine/public/js/params.js) (`loadParams()` / `applyParams()`) reads only:
  - `mix.*`: all four shares, each 0–1, summing to 1 ± 0.02 (renormalised), otherwise the whole group falls back;
  - `anchors.generic_warning_divert` and `anchors.named_route_divert`: the low and high targets of the engine's two-point calibration (both required, low < high);
  - `persona.<type>.{hurry, familiar, trust, queue_averse, truck_only}`, with `route_familiarity` accepted as an alias of `familiar`, and `sign_trust` (share who follow the sign) converted to a relative `trust` multiplier when at least two personas have it.

  Each item is validated on its own. A missing, `null` or out-of-range value falls back to the engine's assumed value without failing the run, and the origin of every item is reported in `status().params_used`. Other fields are listed there as ignored.
- **Web app.** Step 03 (Impact) shows the four `mix` shares with their ranges and labels them as assumed when confidence is `low` or `none`.
- **Not read by any code.** `anchors.stated_to_actual`, `vms.*`, `value_of_time.*`, `risk_preference.*` and `time_of_day_mix` are reference values. `stated_to_actual` became unused when the LLM was limited to reading the sign and the engine took over computing the shares ([D-0929-1435](../../docs/decisions.md)).

Of the 26 entries the engine reads, 10 have values (4 mix shares, 2 anchors, 4 `familiar`); the other 16 are `null` and use the engine's assumptions.

## Parameters

| Key | Value | Range | Confidence | Source | Read by |
|---|---|---|---|---|---|
| `mix.commuter` | 0.50 | 0.40–0.60 | low | ABS Census 2016 journey to work; City of Melbourne Transport Strategy 2030; VISTA trip purposes | engine, web |
| `mix.local` | 0.25 | 0.15–0.35 | low | VISTA trip-purpose categories; City of Melbourne Transport Strategy 2030 | engine, web |
| `mix.tourist` | 0.10 | 0.05–0.20 | low | City of Melbourne / Tourism Victoria visitor-economy reports (qualitative) | engine, web |
| `mix.delivery` | 0.15 | 0.08–0.22 | low | ABS Survey of Motor Vehicle Use; O'Fallon & Sullivan 2007 | engine, web |
| `anchors.generic_warning_divert` | 0.03 | 0.01–0.06 | low | Working assumption; Bonsall & Palmer 1999 and Wardman, Bonsall & Shires 1996 report only a wide 5–80% | engine |
| `anchors.named_route_divert` | 0.20 | 0.10–0.30 | **high** | Erke, Sagberg & Hagman 2007, *Transportation Research Part F* 10(6):447–457: in a field trial about every fifth vehicle changed route as recommended | engine |
| `anchors.stated_to_actual` | 0.20 | 0.10–0.35 | **high** | Chatterjee, Hounsell, Firmin & Bonsall 2002, *Transportation Research Part C* 10(2):149–169: only one-fifth as many drivers diverted as the stated-intention survey predicted | — |
| `persona.<type>.familiar` | commuter 0.80, local 0.70, tourist 0.25, delivery 0.75 | per persona | low | Qualitative (route-choice literature; O'Fallon & Sullivan 2007 for delivery drivers) | engine |
| `persona.<type>.hurry`, `sign_trust`, `queue_averse`, `truck_only` | `null` | — | none | No per-persona figures; Ermagun 2021 is qualitative on trust | engine (falls back) |
| `vms.legibility_index_m_per_mm` | 25 | 20–28 | medium | Transport for NSW TSI-SP-008: legibility distance = 700 × letter height (see [known issues](#known-issues)) | — |
| `vms.reading_rate_wps` | 2.5 | 1.5–4.0 | low | Austroads AGTM Part 10; Dudek 2001 (see [known issues](#known-issues)) | — |
| `vms.max_frames` | 2 | 1–3 | low | Austroads AGTM Part 10; AS 4852 | — |
| `value_of_time.private_car_occupant_aud_ph` | 14.99 | 14–16 | medium | ATAP PV2: 40% of average weekly earnings, June 2013 prices | — |
| `value_of_time.business_car_occupant_aud_ph` | 48.63 | 45–52 | medium | ATAP PV2: 129.8% of average weekly earnings | — |
| `value_of_time.commercial_occupant_aud_ph` | 26.5 | 25.41–28.45 | medium | ATAP PV2: courier to A-triple occupants, midpoint | — |
| `value_of_time.car_occupancy` | 1.09 | 1.05–1.20 | **high** | City of Melbourne, *Update of the strategic transport evidence base*: work trips to the City of Melbourne, 2016 Census journey to work | — |
| `value_of_time.private_vehicle_hour_aud` | 16.34 | 15–18 | medium | Derived: 14.99 × 1.09 | — |
| `risk_preference.queue_aversion` | `null` | — | none | No citable figure | — |
| `time_of_day_mix` | `null` | — | none | Not built (VISTA would allow it) | — |

Full references with DOIs and links are in the root [README](../../README.md) and in each entry's `source` field.

## Confidence

The file has 37 rated entries: **3 high, 5 medium, 11 low, 18 none**. All 18 `none` entries are `null`, so the engine uses its own assumptions for them; the 11 `low` entries carry a value with a range.

**The weakest numbers.**

1. **The four `mix` shares (50/25/10/15).** These are the original working assumption. No public source splits Melbourne CBD car trips by purpose into these four groups; the cited sources only fail to contradict it (commuters dominate, commercial vehicles are of the order of 10–20%). They were not derived from the sources, which is why the UI labels them as assumed.
2. **`generic_warning_divert` = 0.03.** For a warning that recommends no route, the literature gives only a wide range (5–80% total diversion). 0.03 is the team's calibration anchor, not a measurement.
3. **Per-persona `sign_trust`.** Deliberately `null`: there are no clean public trust rates for the four personas. The engine keeps its own assumed trust values, which the UI labels as assumed, rather than pretending to have a source.

**The numbers that hold up.**

- **20% follow a recommended detour.** Erke, Sagberg & Hagman 2007 field trial: about every fifth vehicle changed route.
- **Stated to actual × 0.2.** Chatterjee et al. 2002, London VMS: only one-fifth of the expected drivers diverted.
- **Car occupancy 1.09.** Stated in the City of Melbourne evidence base for work trips (2016 Census).
- **Value of time.** ATAP national guideline values (private $14.99 and business $48.63 per person-hour).

## Known issues

- **`vms.legibility_index_m_per_mm` = 25 is wrong by about 36 times.** TSI-SP-008 gives legibility distance = 700 × letter height, which is 0.7 m per mm. The error was found in a citation check on 30 Sep 2026 and is recorded in the entry's `note`; the value itself has not been corrected. No code reads it, so no number in the app depends on it.
- **`vms.reading_rate_wps` = 2.5** could not be found in Austroads AGTM Part 10 or Dudek 2001; treat it as an assumption. No code reads it.
- **`sign_trust` is empty.** The engine must not hard-code a placeholder such as 0.5.
- **Lower-priority (P2) items were not delivered:** time-of-day persona mix and risk preference.

## Testing

```bash
bash apps/params/test.sh   # Python 3 standard library; 131 assertions on the current file
```

The inline validator checks that `version` is a positive integer; that all keys are ASCII; that there are at least 8 parameter objects; that each has a confidence from the allowed set; that `none` means `value: null` and anything else has a non-empty source; that share and ratio values lie in 0–1, inside their `[lo, hi]` range; that `mix` has all four personas summing to 1 (±1e-6); and that both high-confidence anchors stay `high` and cite a link or a year. The last line is `N passed, M failed`.

## Files

| File | Purpose |
|---|---|
| `public/params.json` | The parameters (the only file the engine reads) |
| `test.sh` | Validator for the JSON contract and the shares |
| `README.md` | This file |

## Contributing

- Add fields; do not rename or remove them (the engine reads them by name).
- When a value changes, update its `source`, `confidence` and `note` in the same edit.
- Derived values state their formula in `source` or `note`.
- Name the original author of a second-hand citation, and never present a cited finding as the team's own.

## History

Built on 29 Sep 2026 during the FEIT Hackathon (task T12, PRs #31 and #32). The original brief is archived at [`docs/hackathon/specs/T12-params-PRD.md`](../../docs/hackathon/specs/T12-params-PRD.md). The citations were re-checked against Crossref and publisher pages on 30 Sep 2026; the `source` fields were corrected afterwards: Chatterjee et al. is in *Transportation Research Part C*, the 1.09 occupancy comes from the City of Melbourne evidence base rather than VISTA, Bonsall & Palmer 1999 is a book chapter, and two unverifiable commuter figures were removed.
