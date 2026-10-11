# T31 Real-weather back-test — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done: phase 1 complete. `tools/fetch_weather.py` (Open-Meteo `ecmwf_ifs` hourly → `public/cbd/weather_hourly.json`, 1,392 hours = 58 days × 24), `tools/backtest_weather.py` (→ `public/cbd/weather_backtest.json`), `tests/test_weather.py` (22 tests, including all the negative assertions in [PRD](../specs/T31-weather-backtest-PRD.md) §6), and a "Weather back-test" section in the README
- Where it stopped (09-30 10:28): phase 1 delivered; phase 2 (extending into 2025 to add heat / strong wind / heavy rain) not started
- Branch / PR: `louisxie316-dotcom/roads/T31-weather-backtest` (PR still to be opened)
- Verification: `bash apps/roads/test.sh` → `78 passed, 0 failed`; `bash scripts/check.sh --quick` → `======== Summary 0 ❌ 1 ⚠️` (the ⚠️ is someone else's handoff note that has not been processed for more than 19 hours)
- Not yet verified: Open-Meteo's "precipitation at T is the total over the previous hour" is used only as documented; checked against the rain effect on cycling, the differences between T = h / h+1 / h+2 fall within the intervals, so it cannot be confirmed that way
- Cost this session: 0 (Open-Meteo is free and needs no key; the two BoM CSVs were downloaded by hand in a browser by @louisxie316-dotcom and put in `raw/`, not committed)

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| `apps/web/src/js/4-sim.js` | `WXP.storm.rate` (:16, currently .9, shared by cars / bicycles / pedestrians) | suggest splitting it by mode: cars 1.0 (measured 0.998 [0.985, 1.015]), bicycles about 0.95 (measured 0.924–0.965; the method reads about 3% low for bicycles), pedestrians about 0.85 (light rain 0.875 [0.813, 0.933]), pedestrians in heavy rain 0.7 (≥ 1 mm/h 0.681 [0.50, 0.91]). If it cannot be split, keep .9 and keep the "illustrative" label |
| same | `WXP.storm.T` (:16, currently 1.4 → capacity ×0.71) | measured: the maximum 15-minute morning-peak flow on saturated approaches is ×0.979 [0.971, 0.986] (an upper bound) → T about 1.02; the literature gives −2..−21% for saturation flow at signals, so 1.1 is also defensible; 1.4 is too strong |
| same | `WXP.fog.rate` (:18, currently .85) | no drop in flow on foggy days in the 8 weeks (cars 1.03; visibility from the model only, mostly on still, clear, cold mornings); suggest keeping it and labelling it "illustrative / model only" |
| same | `WXP.flood` / `heat` / `wind` | no samples in these 8 weeks (≥ 4 mm/h only for 2 hours in the middle of the night; maximum 28.5 °C; BoM maximum gust 59 km/h); no change, keep "illustrative"; they can only be measured once phase 2 extends the window |
| the "illustrative" labels on the page (D-0929-2012) | the rain setting | if storm's rate / T are changed as above, this can become "car and pedestrian flows calibrated on measurements from August–September 2026 (Open-Meteo + BoM + SCATS)"; the other weather stays "illustrative" |

## 3. For the lead
- Decisions needed: whether to change the page's `WXP` before the freeze (table above); whether to do phase 2
- Risks: only 8 weeks, 13 rain days confirmed by BoM, 4 rain days at ≥ 1 mm/h; bicycles at only one junction (2921); placebo interval coverage for bicycles is 80% (cars 96%, pedestrians 92%)
- Needs from others: none
- Other things noticed along the way: the PRD says 1,344 rows, but 08-01..09-27 is actually 58 days = 1,392 hours; the 15.8 mm on 08-25 fell before 9 am on 08-25, and for the rain the model reported that afternoon, BoM has only 0.8 mm

## 4. Next steps
- First command for the next person: `python3 apps/roads/tools/backtest_weather.py && bash apps/roads/test.sh` (prerequisites in the README, "Weather back-test")
- Dev server name (launch.json): none
