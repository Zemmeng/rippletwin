# T20 addendum: 5 problems raised by the simulated judge panel (added to T20 by the lead at 21:25 on 29 Sep)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @unicornnnnnny · Module `apps/web/` · Do it on the same branch as T20
> Source: 3 Opus AI agents role-playing judges (industry / technical / presentation), not the real judges. Each looked at screenshots of the 4 live steps and reviewed them independently against the scoring criteria and the 7-minute demo; all three found it "too complicated". The full comments are in [`judge-panel-0929.md`](judge-panel-0929.md)
> Already decided and not changing: the weather layers stay, labelled "illustrative" (D-0929-2012); removing the hard-coded fake numbers is T20 itself (D-0929-2011 ①). The 5 items below are not covered by T20 and do not conflict with existing decisions

All three simulated judges saw the biggest scoring risk as the same thing: the main storyline is the Lonsdale plan computed by the real engine, yet the screen also shows the preset simulation of the La Trobe junction. In Q&A a single "is this computed live?" would make even the real numbers untrustworthy, dragging down effectiveness (40%) and technical feasibility (30%).

## 1. The step 3 map is not framed on Lonsdale (most urgent)

- Symptom: on entering step 3 the map stays on La Trobe × Swanston, and the 918 m red queue line and the detour lines are out of view, while the heading says "Lonsdale St, one lane closed: 918 m queue"
- Cause: `engFit()` in `src/js/6-engine.js` frames against the whole canvas `V.w / V.h` without subtracting the glass panels floating over the map (`insets()` / `--safe-*` in `src/js/7-glass.js`), and it also forces the junction at `(0,0)` into the frame
- Fix: frame only the works area + the queue line + detours with a share ≥ 5%, and use `insets()` to work out the area not covered by glass for centring and zoom; frame automatically on entering steps 1, 3 and 4
- Acceptance: at 1440×900 and 375 px, entering step 3 shows the red queue line and the detour lines entirely outside the glass panels

## 2. The step 1 engine numbers are collapsed by default

- Symptom: in the compact view the queue, extra wait per vehicle, detour and network delay are folded into one row, "Engine · real CBD traffic >", so after clicking through the plan the judges cannot see the impact
- Cause: `compactPanel()` in `7-glass.js` decides the default expansion from `SEC_KEEP` (whether there are `.metrics`) at the moment the panel renders; the engine numbers arrive asynchronously, so at that moment `#engOut` has no `.metrics` yet, and the section is collapsed by default and recorded in `GL.def`
- Fix: the engine section is always expanded by default (for example add `#engOut` to `SEC_KEEP`, or give that section `data-keep`), placed directly below the form
- Acceptance: in the compact view, changing a line of VMS text makes the 4 big numbers jump immediately without expanding anything

## 3. The units don't match

- Symptom: the step 4 advisor card says "−1,580 veh·h" (summed over the whole works period, from the 10 sampled hours), while the comparison table below is "veh·min" for this one hour (10,493 → 966); the judges will think it is a calculation error
- Fix: the advisor card should say "total over the whole works period (5 days × AM and PM peaks)", or switch to the same basis as the table; write the units out in full in both places
- Location: `eng4HTML()` in `6-engine.js` (`delta_min`, `a.window.whens`)

## 4. Two works and two times on screen at once

- Symptom: the panel talks about Lonsdale at 08:00 while the map also draws La Trobe's barrier B-12, the route 250 bus stop, "passage only 1.1 m", the ADI analysis area and other annotations; the timeline at the bottom shows 17:00–18:00
- Fix: when the engine plan is not on La Trobe, steps 1, 3 and 4 do not draw the La Trobe micro-scene annotations or the little people (`planNotes()`, `drawWorks()`, `drawAgents()` in `5-app.js`); hide the timeline in these steps, or show it only in step 2 / the junction replay
- Acceptance: the step 1, 3 and 4 screenshots show only one works area

## 5. Bring the key assumptions into the open

- "Detour 14% → 61%" relies on the assumption that drivers follow the VMS (the engine's choice model + the T12 parameters): add a line of grey text next to that before vs after row, ideally with a range or an "if only X% comply"
- The simulated technical judge suggested a line under the engine numbers, "demand X veh/h vs capacity with one lane closed Y veh/h", to explain where the queue comes from (`summary.approaches[main].volume`; capacity has to come from the engine; if it cannot be obtained, leave it out for now)

## Order

1 → 2 → 3 → 4 → 5. Items 1 and 2 take about 30 minutes each, 3 about 15 minutes, 4 about 30–45 minutes, and 5 depends on the engine fields. When done, use T14's acceptance: `bash apps/web/test.sh` green, `bash scripts/check.sh --quick` with no ❌, desktop + 375 px screenshots.
