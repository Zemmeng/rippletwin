# T20 Remove hard-coded fake numbers from the page + label the weather as illustrative + the 5 items from the (simulated) judge panel — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done:
  - **B1–B3, removing the fake numbers**:
    - The top-bar safety score is removed; the step 4 safety-score ring and before/after repair table are removed (they used to look up `RESULTS` by weather).
    - "Reproduced in n / 50 seeds" in the alert card and the step 3 replay is removed (it used to look up `SEEDS`).
    - The made-up grey "expected conflicts" bars on the timeline are removed (they used to look up `PROFILE`); only the conflicts actually counted in this simulation run remain.
    - Step 2's fake progress, "variant 22/30", the variant list and "agent decisions / s" are all removed. Step 2 is renamed "Junction micro-simulation" and states that it is a preset scenario at La Trobe × Swanston at 17:00, with counts from this one run, not the engine's numbers for the plan.
    - "Run AI red-team test" becomes "Run junction simulation"; "250 agents × 30 behaviour variants" is removed.
    - The response playbook no longer copies effects from the lookup table; it now describes the plan itself (street, closure, works dates, VMS text, signs) plus the engine numbers.
    - The engine-offline card changes from "showing preset numbers" to "no numbers for now".
  - **B4–B5, weather**:
    - The legend badge "Live" becomes "Illustrative", and the legend gains the line "Weather is not part of the engine calculation".
    - Lightning labels lose the random kA intensity; the lightning count is no longer shown.
    - The page opens with clear weather by default and neither reads nor writes `rt-wx`.
  - **Addendum item 1 · centre the map on Lonsdale** (the five addendum items are in [T20-addendum.md](../specs/T20-addendum.md)):
    - `engFit()` no longer forces the junction (0,0) into the frame. It frames only the works area, the queue line (clipped at the map edge) and detours with a share ≥ 5%, and sets the zoom by the area not covered by glass (`insets()`).
    - It frames once more when the first engine result arrives.
    - The bounds of `setView()` are now computed from the area not covered by glass: before, the east and south edges of the map could never be dragged out from under the panel, so the queue line east of Lonsdale was always covered by the panel.
    - On phones, the framing avoids the weather bar at the top and the legend at the bottom.
    - The queue line is drawn up to the map edge, with the label "Queue 918 m →".
  - **Addendum item 2 · engine numbers expanded by default**:
    - `SEC_KEEP` gains `#engOut` / `#eng4`; T14's compact mode used to treat the engine numbers, which arrive asynchronously, as collapsible.
    - The step 1 engine section moves below the works-area form and above VMS: at 1440×900, the 4 big numbers sit just above while you edit the VMS text, with no scrolling.
  - **Addendum item 3 · units**:
    - Under "−1,580 vehicle-hours" on the advisor card it says "whole works period", with the note "5 days × 2 sampled hours a day = 10 hours; the comparison table below covers only one hour, in vehicle-minutes".
    - The comparison table's title says "This hour · 08:00"; "Network delay" is labelled "vehicle-minutes (this hour)".
  - **Addendum item 4 · one works, one time**:
    - New `microOn()`: the La Trobe micro scenario (barrier B-12, the pedestrian figures, AOI labels, Δ labels, the step 1 equipment list and road-user bar) is drawn only in step 2, in step 3's "Junction replay", when the plan is on La Trobe St, or when the engine is offline. It no longer flashes up first while the engine is connecting.
    - The timeline follows it (`.app.no-time`; on desktop `--safe-b` shrinks to 24px); when the micro scenario is not on screen, the micro-simulation does not run either.
    - The time on the top-right info card shows the plan time (2026-10-05 08:00) in steps 1, 3 and 4.
    - The slider comparison labels become "Before / After" (previously "After AI repair · v2").
  - **Addendum item 5 · show the assumptions** (`.eng-assume`, not `.muted`, so it is visible in compact mode too):
    - Under the engine numbers: "1,072 vehicles/h still need to pass the Lonsdale St works section; with one lane closed only 810 vehicles/h get through, and the rest queue". The numbers come from `v` / `cap` of the works link in `raw.links`.
    - Then: "Assumption: detours are computed by the route-choice model (T12 parameters); about 53% of drivers understand and follow the signs / VMS". The 53% is the engine's understanding share for each driver type, weighted by vehicle count.
    - The premise is stated under the step 4 before/after detour comparison.
  - Tests:
    - New `tests/test_t20.py` (32 tests).
    - The 8 tests in `tests/test_web.py` that asserted `RESULTS` / `SEEDS` exist are now negative assertions that "these lookups are gone".
- Where it stopped (09-29 22:01): all of T20 done and committed locally, waiting to push and open a PR.
- Branch / PR: `unicornnnnnny/web/T20-no-fake-numbers` (PR still to be opened)
- Verification:
  - `bash apps/web/test.sh` → `169 passed, 0 failed`; `bash scripts/check.sh --quick` has no ❌.
  - Browser at 1440×900, dark: in steps 1, 3 and 4 the works area and the queue line (clipped at the map edge) are all outside the glass (point sampling: 0 points under the panel); timeline hidden; safety score gone.
  - Step 2: micro scenario + timeline + real counts.
  - Switching to the La Trobe St plan brings the micro scenario and the timeline back; switching back to Lonsdale hides them again.
  - 375×812 light, step 3: the works area and the queue line are above the legend, with no horizontal scrolling.
  - All the English UI text has been checked.
- Not yet verified:
  - The page with the engine offline (`/engine/` has to be disconnected to see it): the logic is that when offline `microOn()` is true, so the La Trobe micro scenario and the offline card are shown, with no preset numbers at all.
  - Safari.
- Cost this session: 0

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| — | — | None |

## 3. For the lead
- Decisions needed:
  - #48 B6–B11 (remove the near-infrared basemap, the graticule and the scripted roles C-17 / D-42, rename the steps, replace step 1 with the equipment list for the current works) are not part of T20 and were not touched this time.
  - Step 2 now says explicitly "La Trobe junction micro-simulation (example)". Whether to merge it into step 4 or delete it is for the lead to decide, as #48 B2 suggests.
- Risks:
  - The bounds of `setView()` are now computed against the inner edge of the glass, which affects all dragging: the map edge can now be dragged up to the edge of the panel (before, it stopped at the canvas edge, so a strip of the map was always under the panel). Phones have no insets, so behaviour there is unchanged.
- Needs from others:
  - T23 (@jinmingq, side-by-side plans) also changes `apps/web`: the step 4 panel structure has changed (`#eng4` at the top; the micro plan v2 appears only when `microOn()` is true); take care when merging.
- Other things noticed along the way:
  - The specific numbers in the weather legend (e.g. 18 °C, μ 0.80, "braking distance +38%") are still there. They are part of what is "illustrative": the legend is already labelled illustrative and says the weather does not take part in the engine calculation. Removing them all would be a separate task.

## 4. Next steps
- First command for the next person: `python apps/web/build.py && bash apps/web/test.sh`
- Dev server name (launch.json): `site` (wrangler dev, 8790, open `/web/public/`)
