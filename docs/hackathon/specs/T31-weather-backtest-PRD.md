# T31: back-test against real weather (PRD)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @louisxie316-dotcom · Module `apps/roads` · Branch `louisxie316-dotcom/roads/T31-weather-backtest`
> Written 2026-09-30 10:03 (the lead, @Zemmeng) · Basis: the lead's words "post a task on GitHub for @louisxie316-dotcom to get the weather data … try back-testing with real weather data"
> Timebox: **stage 1 about 2 h, PR green before 09-30 16:00**; stage 2 optional, before 20:00. Feature freeze is 10-01 06:00; whether the page switches to measured numbers is for the lead to decide after seeing your results
> Cost: 0 (Open-Meteo is free and needs no key)

## 1. Why

- The 6 weather types on the page (clear / thunderstorm / flooding / dense fog / heat / strong wind) only act in the step 2 junction micro-simulation. Their multipliers are hard-coded in `WXP` in `apps/web/src/js/4-sim.js:14-20`, and **they are all made up**, which is why the page labels them "illustrative" (D-0929-2012). The engine (`apps/engine`) ignores weather completely
- We cannot answer when judges ask "what happens when it rains?" or "where do these numbers come from?". You already have SCATS and pedestrian counts for 2026-08-01..09-27 (T3, T7); paired with real hourly weather for the same period, they let us back-test **how much car, bike and pedestrian traffic actually drops when it really rains in the Melbourne CBD, and how much capacity falls**, and then compare with `WXP`

What each `WXP` field multiplies (the lead has read the code):

| Field | What it multiplies (line in `4-sim.js`) | Can your data back-test it? |
|---|---|---|
| `rate` | The arrival rate at every entry, **one value shared by cars, bikes and pedestrians** (:98) | Yes: SCATS car volumes, site 2921 detector 1 (Swanston bikes), pedestrian counts |
| `T` | Car headway (:137), which sets capacity | Only approximately: the peak 15-minute maximum lane flow on saturated approaches, clear vs rain |
| `v` `bike` `ped` | The **speed** of cars / bikes / pedestrians (:92 :126 :144) | No: SCATS has only volumes, no speed, occupancy or degree of saturation |
| `b` `wob` | Deceleration / bike wobble (:137 :101) | No |

Current values: thunderstorm `rate .9` (−10% for everyone) `T 1.4`; flooding `rate .75`; fog `rate .85` `T 1.7`; heat `rate .8`; strong wind `rate .85`.

## 2. Data (tested by the lead's agent at 09-30 09:55; fetch it this way)

### 2.1 Weather: the Open-Meteo historical API (free, no key, CC BY 4.0)
```
https://archive-api.open-meteo.com/v1/archive?latitude=-37.8136&longitude=144.9631
  &start_date=2026-08-01&end_date=2026-09-27
  &hourly=precipitation,rain,temperature_2m,wind_speed_10m,wind_gusts_10m,weather_code,visibility
  &timezone=Australia%2FMelbourne&models=ecmwf_ifs
```
- Returns `hourly.time[]` (local time without a time zone, e.g. `2026-08-01T00:00`) and parallel arrays `hourly.<variable>[]`; missing values are `null`. Units: mm, °C, km/h, visibility in m
- **Always pass `models=ecmwf_ifs`**: with the default model, visibility is all `null`; `era5` lags by 5 days and has a 0.25° grid
- The whole window is UTC+10 (daylight saving only starts on 10-04)
- The precipitation value at time T is for the hour before T (according to the Open-Meteo docs; not independently verified); check it yourself when aligning with the SCATS hours
- Attribution: `Weather data by Open-Meteo.com` (link https://open-meteo.com/)

### 2.2 Cross-check: BoM Melbourne (Olympic Park) daily observations
- `https://www.bom.gov.au/climate/dwo/202608/text/IDCJDW3033.202608.csv` (and `202609`)
- **BoM explicitly does not support automated scraping**: download these few CSVs by hand in a browser into `apps/roads/raw/` (already gitignored), and **do not put them in a script or commit them** (copyright © Commonwealth of Australia)
- Latin-1 encoding; dates are not zero-padded (`2026-08-1`); `Rainfall (mm)` is the 24-hour rainfall from 9 am the previous day to 9 am on the day

### 2.3 Cars and bikes: raw SCATS data (`flows.json` will not do)
- `flows.json` has only weekday / weekend × 24-hour averages and no daily data, so the back-test must use the raw data: `python3 apps/roads/tools/fetch_scats.py --range 2026-08-01..2026-09-27` (your local `raw/` may still have it)
- One row = one detector at one junction for one day; `V00..V95` are the 96 15-minute volumes; negative values are faults → drop that hour (`build_flows.py` does the same)
- Suggested sites: 2921 Swanston/La Trobe (detector 1 = the Swanston bike detector, about 5,500 a day; 5 and 7 are traffic lanes), 2903 Russell/Lonsdale, 2902 Exhibition/Lonsdale, 2935 Lonsdale near Swanston (a mid-block pedestrian signal with only 2 detectors, suitable for the capacity proxy). Except for 2921, which lane each detector covers has not been checked; before saying "Lonsdale westbound", look it up with `fetch_scats.py --sheet <site>`
- 2921 is missing all data for 07–10 on 09-28

### 2.4 Pedestrians: City of Melbourne hourly counts
- The same API as T7 (`pedestrian-counting-system-monthly-counts-per-hour` in `apps/roads/README.md`); the data is kept on a rolling two-year basis (from 2024-09-30)
- Counters near the demo: `Swa295_T`, `Lat224_T`, `Swa330_T`, `Lon364_T`, `Lon189_T` (this one is missing 86 hours in the window)

## 3. What this window can back-test (look first; don't force it)

The lead's agent counted these with the APIs above (`ecmwf_ifs`, 2026-08-01..09-27):

| Weather | Hours | Can it be back-tested? |
|---|---|---|
| Wet (≥ 0.1 mm/h) | 205 h in total; 29 h in weekday peaks (07–10, 16–19) | Yes, but the effect is small, so pool all daytime hours |
| Moderate rain (≥ 1 mm/h) | 41 h in total; 6 h in weekday peaks, of which only **Monday 08-10 morning** is confirmed by BoM (24.4 mm); **Wednesday 08-19 morning is a model false alarm** (BoM 0 mm) | Case studies only |
| Heavy rain (≥ 4 mm/h) | 2 h, both in the middle of the night | No |
| Heat ≥ 30 °C | 0 h (BoM maximum 28.5) | Not in this window |
| Strong wind (gusts ≥ 60 km/h) | 0 days measured by BoM (maximum 59); the model says 5 days, which is not credible | Not in this window |
| Fog (visibility < 1 km) | 32 h in the model, e.g. Monday 08-17 07–09 at 120–160 m; no measured visibility to check against | Case studies only, labelled "model only" |

Weekday heavy-rain days (≥ 5 mm) that both sources agree on: **Monday 08-10 and Tuesday 08-25**.

## 4. Method

### Stage 1 (required, about 2 h): 8-week window, wet vs dry
1. `tools/fetch_weather.py`: fetch the hourly weather in 2.1 → `public/cbd/weather_hourly.json` (with `source`, `licence` and `attribution` fields; 1,344 rows, very small)
2. `tools/backtest_weather.py`:
   - **Classify each hour**: `dry` = this hour and the previous 2 hours all 0 mm, and BoM rainfall for the day < 1 mm; `wet` = ≥ 0.1 mm; `rain` = ≥ 1 mm; `fog` = visibility < 1000 m (labelled `model_only`). Other hours go into no class
   - **Excluded days**: 09-25 (public holiday, already in `HOLIDAYS` in `build_flows.py`), 09-26 (AFL Grand Final); check the dates of the Victorian school holidays (probably late September) and either exclude them or analyse them separately. Write the exclusion list into the output
   - **Baseline**: for each detector (or counter) × weekday / weekend × hour, the median over `dry` hours only
   - **Effect**: flow in `wet` / `rain` hours ÷ baseline, summarised separately by mode (car / bike / pedestrian) as the baseline-weighted mean log ratio, with **the 95% interval from resampling by day** (hours on the same day are correlated, so do not resample by hour)
   - **Capacity proxy** (for `T`): pick approaches that are close to saturation at peak (for example the top 10% of dry-peak 15-minute flows) and compare the maximum 15-minute lane flow in wet and dry peaks. This number mixes "fewer cars" with "slower driving", so **treat it only as an upper bound** and say so
   - **Case studies**: Monday 08-10 07–10, Tuesday 08-25, and the fog on Monday 08-17 (model only): list car / bike / pedestrian ratios to baseline hour by hour, with BoM rainfall for the day
   - **Placebo test**: pick dry days at random as "fake wet days" and run the same method; the ratio's interval should contain 1.0. If it does not, the method is biased; fix the method first
3. Output `public/cbd/weather_backtest.json` (ASCII keys):
```json
{
  "version": 1, "window": ["2026-08-01", "2026-09-27"],
  "sources": {"weather": "...Open-Meteo ecmwf_ifs...", "check": "BoM IDCJDW3033", "traffic": "DataVic SCATS", "peds": "City of Melbourne"},
  "excluded_days": [{"date": "2026-09-25", "why": "public holiday"}],
  "classes": {"dry": "...", "wet": "precip >= 0.1 mm/h", "rain": ">= 1 mm/h", "fog": "visibility < 1000 m (model only)"},
  "results": [{"cls": "wet", "mode": "car", "period": "day", "ratio": 0.98, "ci95": [0.95, 1.01], "n_days": 14, "n_hours": 120, "n_sensors": 9}],
  "capacity_proxy": [{"site": "2935", "period": "am", "ratio": null, "ci95": null, "n_days": 1, "note": "sample too small"}],
  "cases": [{"date": "2026-08-10", "hours": "07-10", "rain_mm_h": [2.1, 1.3, 1.2], "bom_daily_mm": 24.4, "car": 0.97, "bike": 0.7, "ped": 0.9}],
  "placebo": {"ratio": 1.0, "ci95": [0.98, 1.02], "n_days": 10},
  "wxp_compare": [{"wxp": "storm.rate", "current": 0.9, "measured": "car 0.98 [0.95, 1.01]; bike ...", "literature": "Melbourne car -1.35..-3.43% (Keay & Simmonds 2005)", "verdict": "too_strong"}]
}
```
   The numbers above are **format examples, not answers**. For cells with `n_days < 3`, write `null` for `ratio` and `ci95` and give the reason in `note`; **never make numbers up**. `verdict` may only be `ok` / `too_strong` / `too_weak` / `wrong_direction` / `untestable` / `no_sample`
4. Add a "Weather back-test" section to `apps/roads/README.md`: how to run it (two commands), data sources and attribution, **conclusions in no more than 5 lines**, and limitations (the Open-Meteo grid point is 3–4 km north-west of the CBD; the model's rain timing is unreliable and must be checked against BoM; there is no speed data)

### Stage 2 (optional, only if there is time after stage 1 merges): a longer window, adding heat, strong wind and heavy rain
- SCATS monthly packages exist from 2025-01 to 2026-09 (`fetch_scats.py --range` works on them directly; 2024 and earlier are yearly packages containing monthly ones, which the script does not support, so leave them alone); pedestrian data goes back to 2024-09-30
- Pick samples by day: weekdays with a BoM maximum ≥ 35 °C, weekdays with BoM gusts ≥ 60 km/h, and weekdays with BoM rainfall ≥ 10 mm, each paired with 2 dry days on the same weekday within 2 weeks either side as controls. Download the BoM monthly CSVs by hand
- First send one Open-Meteo request for 2025-01 to confirm `ecmwf_ifs` goes back that far; on the daylight-saving changeover days (2025-10-05, 2026-04-05) check `CT_RECORDS` to confirm that `V00` is local midnight
- Merge the results into the same `weather_backtest.json` (change `window` to the actual range; add `heat` / `wind` / `heavy_rain` to `cls`)

## 5. Literature for comparison (goes in `wxp_compare.literature`; numbers only from what you compute)

| Comparison | Range in the literature | Source |
|---|---|---|
| Car volume in rain (Melbourne) | Daily traffic on wet days −1.35% to −3.43% | Keay & Simmonds 2005, *Accident Analysis & Prevention* 37(1):109–124, doi:10.1016/j.aap.2004.07.005 |
| Cyclist numbers in rain (Melbourne) | Light rain −8 to −19%, heavy rain −13 to −25% | Phung & Rose 2007, ATRF |
| Cyclist numbers in rain / wind (Melbourne) | Light rain about −13%, heavy rain about −40%, strong wind about −15 to −20% | Ahmed, Rose & Jacob 2010, ATRF |
| Saturation flow at signalised junctions in rain | Arterials −2 to −21% | FHWA Road Weather Management |
| Capacity in heavy rain (freeways) | −10 to −17%; low visibility −12% | Agarwal, Maze & Souleyrette 2005 |
| Pedestrians | Cold / precipitation reduce walking by less than 20% (small US town; nothing found for Melbourne) | Aultman-Hall, Lane & Lambert 2009, TRR 2140 |
| Heat | Heat **increases** traffic volume (Belgium) | Cools, Moons & Wets 2010, *Weather, Climate, and Society* |

Going by the literature, `WXP` is probably off in these places (**your back-test will confirm or refute this**): the thunderstorm `rate .9` is 3–7 times the measured Melbourne effect for cars; bikes drop much more than cars in rain, which one shared `rate` cannot express; the heat `rate .8` may have the wrong sign.

## 6. Acceptance

- `bash apps/roads/test.sh` all green; `bash scripts/check.sh --quick` with no ❌; **paste the summary line verbatim**
- The new tests include at least these negative assertions:
  - The baseline contains no `wet` / `rain` / `fog` hours
  - Days in `excluded_days` appear in no result or case study
  - Cells with `n_days < 3` have `ratio` set to `null` (no sample, no number)
  - The number of hours in `weather_hourly.json` = days × 24, and the times are local time
  - The placebo's `ci95` contains 1.0
- Every wet day in the case studies has `bom_daily_mm`; the morning of 08-19 is flagged as a model false alarm and is not used as a wet day
- Every JSON file under `public/cbd/` is < 2 MB (D-0929-1430)
- Put a table in the PR description: `WXP` field → current value → what you measured → literature → verdict

## 7. Not doing

- **Do not change `apps/web`** (`WXP` is in @unicornnnnnny's module). If you think `WXP` should change, write the values in section 2 of your handoff note; the lead will decide after reading whether to change the page before the freeze, and whether the page's "illustrative" label should become "calibrated against measurements from August–September 2026"
- Do not change the engine (it ignores weather and will not gain it before the freeze)
- Do not write a script that scrapes BoM automatically; do not use paid APIs; do not commit raw SCATS or BoM files
- A back-test that finds nothing (intervals too wide) is also a result: write it as it is, "with an 8-week sample no significant change in car volume is visible, interval [a, b]", and **never cherry-pick time periods to make it look good**
