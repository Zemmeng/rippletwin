# T28 + T26 + T27: engine `extra_min` + finishing T20 + the map shows the whole CBD (PRD)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @unicornnnnnny · all three tasks are yours · Written 2026-09-29 23:54 by the lead (@Zemmeng); revised 09-30 00:05 (T28 assigned to you as well) and 09-30 00:15 (the AI panel is merged as #76 and deployed; sections 2 and 4 no longer need to wait)
> Order and branches:
> 1. **T28** `unicornnnnnny/engine/T28-extra-min` (about 1 h, section 0): changes only `apps/engine`; do it first
> 2. **T26** `unicornnnnnny/web/T26-t20-tail` (about 1.5 h, section 2)
> 3. **T27** `unicornnnnnny/web/T27-full-cbd` (stage 1 about 5 h, section 3, timebox 09-30 22:00)
>
> Start each task from the latest `origin/main`, and open the next branch only after the previous one is merged; T26 and T27 both change `apps/web`, so **do not run them in parallel**
> Merge order: **#72 (credits, merged) → #76 (AI road-user panel, merged and deployed 09-30 00:0x) → T28 → T26 → T27**; T28 does not touch `apps/web` and can be merged at any time, but T28 must be on main before T27 merges. Read section 4, "Changes running in parallel with the lead", before you start. #73 (T23, the AI plan explanation) is also merged and changed `8-compare.js`
> Basis: the lead's words "has @unicornnnnnny finished all my review comments?" → the check is in section 1; "I think we can fit the whole city", "you don't need to do it, just write a PR for @unicornnnnnny", "combine it with the issues above, then summarise and push", "just give the PRD to @unicornnnnnny and have them do all of it". Decisions: `docs/decisions.md` D-0929-2354, D-0930-0005
> Freeze: feature freeze at 10-01 06:00. T27 merges only a finished "stage 1"; if it is not green by 09-30 22:00 it does not merge and the fallback applies (section 3.4). Leave nothing half-done

## 0. T28 · The engine gives every road section an `extra_min` (about 1 h, do it first)

**Why**: the page's "slowed sections" layer currently compares against **free flow** (`delay_s = t − t0_s` in `apps/engine/public/js/pipeline.js:213`; the page filters on `v·delay_s/60` in `apps/web/src/js/6-engine.js:465-466`), not against **the same hour without works**. Flinders / King St already queue 3,952 m at 8 am, so that road is drawn as a red "ripple caused by the works" in every plan. Nobody sees it today only because it is outside the map window; once T27 extends the map to the whole CBD it will show.

**How**:
- Branch: `git fetch origin && git switch -c unicornnnnnny/engine/T28-extra-min origin/main` (the module segment must say `engine` for `check [3]` to let you write in `apps/engine`)
- `apps/engine/public/js/pipeline.js`, around lines 212–215: in `links.push({...})` add `extra_min: round1((x.v * x.t - bx.v * bx.t) / 60)`, which is the number the next line's `hot` already computes (vehicle-minutes, compared with the same hour without works). Report negative values as they are, without clipping to 0; the page decides how to draw them
- Do not change or remove any other field (`delay_s` is still used elsewhere)
- Add tests under `apps/engine/tests/`, written like the existing tests there:
  - Negative assertion: with Lonsdale westbound at 08:00 and 1 lane closed, the Flinders St / King St sections have a large `delay_s` but `extra_min < 2`
  - The works section itself has `extra_min > 0`
  - Every entry in `raw.links` has a numeric `extra_min`
- **The page side is not changed in T28**: switching the filter in `6-engine.js:466` to `extra_min` is done in T27 (section 3.2)
- Contract: `docs/contract.md` (now `docs/reference/interfaces.md`) is the lead's exclusive area. In the PR's "Shared files to change" section, write "engine raw result section: add `extra_min` to raw.links (vehicle-minutes, compared with the same hour without works, may be < 0)", and the lead will apply it
- The code in `apps/engine/` belongs to the lead (CODEOWNERS); **the lead reviews the PR before it merges**, so do not merge it yourself
- Acceptance: `bash apps/engine/test.sh` all green and `bash scripts/check.sh --quick` with no ❌; paste the summary line

## 1. T20 check results (09-29 23:30, live = build of main `f3d4d95`)

T20 (#60) is mostly done: of 10 items, 7 are fully done and 3 are half done; the later #61 and #62 did not undo T20; `bash apps/web/test.sh` → `222 passed, 0 failed`.

| Item | Verdict |
|---|---|
| B1 safety score / lookup result table · B2 fake progress / variants · B3 the words "AI red team" · B4 weather labelled illustrative · B5 sunny by default | Done |
| Addendum ① map framed on Lonsdale | Partly: meets the bar on desktop; 375 px and the "back to the works area" button do not |
| Addendum ② engine numbers expanded by default | Partly: expanded; at 1440×900 the VMS input box needs scrolling to edit |
| Addendum ③ units | Done |
| Addendum ④ one works, one time | Done: the map shows only one works area; the scene name in the top bar was missed |
| Addendum ⑤ assumptions in the open | Partly: demand vs capacity is done; the "53%" wording is wrong and there is no range |

T20 is still marked "in progress, awaiting review" in your section of `docs/3-tasks.md` (now `docs/hackathon/task-board.md`): this is the review, so mark it done (#60) when you start T26.
Item-by-item evidence (file:line): the lead's local `.claude/agent-out/t20-*.md` (not in git; ask the lead if you need it).

**The context has changed: the LLM is now live** (D-0929-2307, #70 sign reading, #71 AI explanation). Sign reading and the AI explanation now both use the real DeepSeek, no longer keyword rules. So:
- The 918 m, 14% → 61% and 53% quoted below are live numbers from rule-based sign reading at 09-29 23:30. With LLM readings (measured by the lead at 09-29 23:25 with `connect()`): Lonsdale at 8 am with only ROADWORK AHEAD is still 918 m / 10,493 veh·min; adding USE RUSSELL ST gives 538 m / 5,629 (−46%); bus riders 18,693 → 10,991 (−41%); the guided plan 79 m / 937. **Screenshot acceptance always uses the numbers on the page at that time**; do not hard-code the numbers in this document into copy or tests
- The sign-reading badge and legend have already been changed by the AI road-user panel (#76) to friendly names (LLM · precomputed / cached / live, Rules · fallback), summarised from the actual readings of the 4 road-user types in this plan (`aiPlanSrc()` in `9-ai.js`). When T26 changes the badge or the text next to the legend, keep the two calls `aiPlanSrc` / `aiSrcLabel`

## 2. T26 · Finishing T20 (about 1.5 h, do it first)

Every item has an acceptance check. Line numbers are from main `954842a`; they have moved since the AI panel (#76) merged, so find things by function name.

**Order to start**: the AI panel is on main (#76), so 2.1–2.7 can all be done; there is no longer any need to group and wait.

### 2.1 The top-bar scene name still says La Trobe
- Symptom: at 1440 wide (the demo projector width), the top bar for the Lonsdale plan reads "Scene Swanston St × La Trobe St · Melbourne CBD"
- Location: hard-coded in `src/body.html:7`; the canvas `aria-label` (`body.html:34`) is hard-coded too
- Fix: when `microOn()` is true, keep it as it is; otherwise show the street of the current works (`EP.street` + direction + hour), for example "Lonsdale St westbound · 08:00 · Melbourne CBD". In both Chinese and English
- Acceptance: the 1440×900 screenshots of steps 1, 3 and 4 contain no "La Trobe" (except the step 3 "junction replay" tab; labels of slowed sections computed by the engine, such as "LA TROBE ST +15 veh·min", are real results and stay)

### 2.2 The "back to the works area" button flies back to La Trobe
- Symptom: `#zoomHome` (its `aria-label` is "back to the works area") flies to `HOME={cx:-22,cy:-6,s:3.6}`, which is the La Trobe × Swanston junction
- Location: `src/js/5-app.js:458`, `:45`
- Fix: call `engFly()` when `microOn()` is false, and fly to `HOME` only when it is true
- Acceptance: in steps 1, 3 and 4, drag the map away and press the button; it returns to the Lonsdale works area and the queue line

### 2.3 At 1440×900, editing the VMS text in step 1 needs scrolling
- Symptom: in the compact view of step 1 the panel's visible area ends at 876 px and the VMS input box spans 827–923 px, so only about the top 50 px show (measured live). Your handoff note said "no scrolling needed", which does not match the measurement
- Fix (pick one): move the VMS input box directly above the engine numbers; or compress the engine section (`engWhy` / `engImpacts` / `engBadges` in `6-engine.js`, around `:237`), for example by collapsing the grey assumption text to one line in the compact view and expanding it on click
- Acceptance: at 1440×900, once in Chinese and once in English, the compact view of step 1 shows the 4 big numbers and the whole VMS input box at the same time without scrolling; changing a character makes the numbers jump immediately

### 2.4 Phone framing at 375 px
- Symptom: in step 3 the works area sits against the top edge of the weather legend, and the label "W-1 · LONSDALE ST westbound · 1 lane closed" is half covered by the legend; part of the ≥ 5% detour (Russell) falls into the legend strip at the bottom
- Cause: `setView()` (`5-app.js:40-42`) clamps the centre to the WORLD bounds and ignores the top 96 / bottom 104 px that `engFit()` (`6-engine.js:417-428`) reserves on phones; Lonsdale is too close to WORLD's southern edge, so after clamping it sits at the bottom. On desktop `engFit()` also leaves no room for the bottom-left legend (expanded by default, with `glass`)
- Fix: **once T27 extends WORLD to the whole CBD, Lonsdale is no longer at the edge and most of this goes away by itself**. So T26 only does this: collapse the legend by default in the engine steps (on both phone and desktop), and have `engFit()` include the legend height in the bottom margin. Re-test after T27
- Acceptance: at 375×812 in step 3 the works-area label is fully visible; at 1440×900 in step 3 no detour line sits under the legend

### 2.5 Make the two assumption lines accurate (the second half of addendum ⑤)
- "About 53% of drivers understand and follow the signs" is wrong: 53% is the **share who understand the sign**, computed by `engInformed()` (`6-engine.js:203`), not the share who comply. It is also 53% when the sign only says ROADWORK AHEAD and tells nobody to detour; a judge will ask "53% comply, so why do only 14% detour?"
  - Change it to: "About 53% of drivers understand the sign text; whether they change route is computed by the route-choice model from each driver type's parameters, 14% detour this time" (`6-engine.js:207`, in both Chinese and English)
- The compliance assumption has no source: T12's `sign_trust` is `null` with `confidence: none`. Per D-0929-1536, label this number "assumed value" and do not write "computed from the T12 parameters"; when `params.json` cannot be loaded (`flags.params==='default'`) it must not say "T12 parameters" either
- The step 4 row "vehicles detouring 14% → 61%" is always green (`row(...,true)` in `6-engine.js:370`): make it a neutral colour; it is a change driven by an assumption, not a proven benefit
- On the same panel, "extra wait per vehicle · 513 veh/h" and "works section 1,072 veh/h" sit side by side with no explanation of what each measures: say whose vehicles the 513 are (the main approach), or keep only one
- (Optional, if there is time) a range: "if only half comply: detour about X%, queue about Y m". This needs the engine to expose a compliance rate; ask the lead first whether the engine has such a parameter. If not, skip it, and do not compute it in the page yourself
- Acceptance: steps 1, 3 and 4 in both Chinese and English no longer contain "follow the signs" or "act on the signs"; the "vehicles detouring" row is not green; with a full closure (`EP.all`) there is still a line explaining where the queue comes from (today the whole row is removed by a guard when `cap=0`, `6-engine.js:206`)

### 2.6 The remaining misleading wording (raised in the simulated judge panel's notes)
| Location | Now | Change to |
|---|---|---|
| `body.html:10-12` step bar | 02 Stress test / 03 Ripple trace / 04 Repair (and the Chinese equivalents) | 02 Junction sim / 03 Impact / 04 Improve (Chinese to match); you already renamed the step 2 panel heading to "Junction micro-simulation", but the step bar did not follow |
| `5-app.js:310` button in the junction-replay tab | Generate a safer plan → | See the revised layout → (v2 is a preset layout, not a generated one) |
| `5-app.js:306`, `:379` | Agents involved / Impact on agents | Road users involved / Impact on road users ("agents" makes people think AI is used) |

### 2.7 Tests
- Add `seed 4218`, `随机种子`, `行为变体` and `behaviour variations` to the B3 negative assertion in `tests/test_t20.py` (the two Chinese strings are the UI's Chinese for "random seed" and "behaviour variants", which must not appear)
- Add `tests/test_t26.py` with at least one assertion per constraint above, including these negative assertions: `.scene-name` in `body.html` must not hard-code La Trobe; clicking `#zoomHome` must not only fly to `HOME`; the copy must not contain "follow the signs"; the "vehicles detouring" row must not pass `better=true`
- Acceptance: `bash apps/web/test.sh` all green and `bash scripts/check.sh --quick` with no ❌; paste the summary line; check the 1440×900 and 375 px screenshots yourself

## 3. T27 · The map shows the whole CBD (stage 1 about 5 h, after T26 merges)

### 3.1 How it is now, and why
- **The data is complete**: `network.json` (805 nodes / 1,513 road sections), `buildings.json` (2,508 buildings), and `walk` / `peds` / `transit` in `apps/roads/public/cbd/` all cover lat −37.8235..−37.806, lon 144.948..144.976, i.e. the whole Hoddle Grid (Spencer–Spring × Flinders–La Trobe) plus 300–600 m beyond it. Divided into 200 m cells across the grid, no cell has zero buildings
- **The page shows only a small piece**: `WORLD={x0:-320,x1:320,y0:-300,y1:300}` (`src/js/1-world.js:61`) is about 8% of the data extent, so only 395 buildings show. `setView` / `flyTo` / `zoomAt` clamp the view to WORLD, with a hard-coded minimum zoom of 1.1 (`5-app.js:40`, `:43`, `:474`)
- **So the engine's results cannot be drawn in full** (measured by the lead with node on the real network, default plan Lonsdale westbound at 08:00 with 1 lane closed):
  - Of the 918 m queue only 184 m is drawn (`engWorldReach()`, `6-engine.js:498`)
  - 37% of the 2,626 m of detour lines are outside the window; for the La Trobe 17:00 plan 70% are outside; with a full closure 82% of the affected bus and tram lines are outside
  - Detour labels and most-congested-section labels outside the window are simply not drawn (`6-engine.js:493-494`)
  - Only 227 of 1,513 road sections can be clicked to move the works area (`engCands()`, `6-engine.js:120`)
  - The T20 addendum ① acceptance, "queue line and detour lines fully visible", cannot be met, and this is the root cause
- **Page units are not metres**: `geoToWorld()` (`6-engine.js:13`) draws 1 real metre as about 0.863 page units, so the scale bar (`5-app.js:165-170`) is off by about 14%. Once zoomed out to the whole city, judges may measure with the scale bar

### 3.2 Approach: leave the fine window alone and add a whole-city layer outside it
**Unchanged**: `WORLD` itself, `geoToWorld()`, `buildWorldReal()`, the weather grid, the junction micro-simulation and the orthophoto canvas. They still cover only the original area. Reasons:
- Simply enlarging WORLD would need a 110–119 Mpx imagery canvas (iOS cannot create one), make each weather-grid recompute 19 times as expensive (about 31 ms for the thunderstorm frame), and the 8 synthetic streets and plots would cover real streets such as Bourke and Collins. That approach was estimated at 14–22 h and cannot be finished before the freeze
- Making the window follow the works does not work either: it first needs the previous item's "generate streets from the road network", and the grid would be rebuilt on every change of road section

**Extent**: only out to about 150 m beyond the Hoddle Grid (page coordinates roughly x −1150..750, y −950..350, as computed by the lead; check them yourself with `geoToWorld()` before you start). Do not use the whole data bbox:
- `geoToWorld()` stretches by 1.85× north of La Trobe (`6-engine.js:13-14`), so drawing too far north distorts the shapes
- At the edge of the bbox, around Crown and St Patrick's, whole buildings were dropped (`apps/roads/tools/fetch_buildings.py:205`), so drawing them would show holes

Add a new constant `CITY` for this extent. It controls only three things: how far you can drag, how far you can zoom out, and how far the engine lines are drawn.

**Stage 1 (required, about 5 h)**

1. **Whole-city layer**: new file `src/js/6c-city.js` (`build.py` sorts by file name, so it comes after `6-engine.js`). **Pre-render the whole city to an offscreen canvas**, one each for the light and dark themes:
   - Draw the `network.json` sections as grey road surface, skipping footpaths. 411 pairs of sections are exact reverses of each other (the centre line of the same two-way street); pair them up and de-duplicate before drawing
   - Draw `buildings.json` as flat footprints, with no extrusion and no outline
   - Pre-rendering is required: measured live, redrawing the whole city once takes 46 ms, and dragging redraws every frame (`renderBase`, `5-app.js:69-70`); blitting the cached image takes only 1.7 ms
2. **Basemap layering**: `renderBase` first blits the whole-city layer, then draws the original fine window (clipped to WORLD). There will be a seam between the two layers, visible in the default Lonsdale framing (Exhibition St and Spring St are both outside the window). **You decide** how to handle the seam (fade, outline or something else); once decided, put screenshots in the PR
3. **Open up the view**: in the three places `setView` / `flyTo` / `zoomAt`, change the minimum zoom of 1.1 to "just fits CITY" (about 0.35–0.5 on desktop), and clamp panning to CITY. When zoom is below 1:
   - Hide the weather, the micro-simulation's people and events, the graticule, the degree-minute-second ticks and the lat/lon probe. `toLL()` is already off by 120–229 m (`1-world.js:62-64`), which would only become more visible when zoomed out
   - Disable clicking the map to move the works area: the pick tolerance `max(9,14/V.s)` (`6-engine.js:517`) is 70 units at s=0.2, so clicks would land on the wrong section
4. **Draw the engine lines in full**: in `6-engine.js`, replace `WORLD` with `CITY` for the engine overlay, including `engCands` (:120), `engFit` (:418, and the minimum zoom at :425), label culling (:493-494) and `engWorldReach` / `engVisible` (:498-501). Open up `engFit`'s minimum zoom accordingly; all detours with a share ≥ 5% must be in frame
5. **Draw the queue line along real roads**: today `engUp()` (`6-engine.js:435`) pushes back in a straight line along the direction of the works section, so once the view is opened up it would push off the network (Lonsdale would be pushed east to x≈1054, while the easternmost street in the network, Spring St, is at x≈892). Change it to walk upstream from the works section along sections with the same name, accumulating `len_m`, and stop at the edge of the network or when the length is reached.
   - Note: the engine's queue is a point queue on the works section (`apps/engine/public/js/assign.js:43`) and does not propagate to upstream junctions. In the default plan there are only about 544 m from the works east to Spring St, which cannot hold 918 m
   - **Draw the line as far as it goes and never stretch it to fake the length**; the label still shows the engine's number ("queue 918 m"), plus a note such as "drawn as far as Spring St"
   - `tests/test_t20.py:69` pins the source text `engUp(Math.min(s.queue_m,engWorldReach()))`; update that assertion when you change it
6. **Scale bar**: correct for 1 m ≈ 0.863 page units (`5-app.js:165-170`), so it is right at both whole-city and junction zoom levels

7. **Filter slowed sections on `extra_min`** (you already did the engine side in T28): `6-engine.js:465-466` currently filters on `(l.v||0)*(l.delay_s||0)/60`; change it to `l.extra_min` (draw only when ≥ 2; red / yellow thresholds unchanged). **Also remove the two `queue_m>0` checks**: both `!(l.queue_m>0)` in the filter and the red test `sev = l.queue_m>0 ? 2 …` must look at `extra_min` instead. `queue_m` is an absolute value: Flinders / King St normally have about 3,950 m of queue with an `extra_min` of 0, so if only `ex` is replaced and these two are left in, they are still drawn red (measured in the 09-30 review of #79). The works section's own queue line is drawn separately and is not affected. This way the queues Flinders / King St always have are not drawn as works ripples in every plan. **T27 does not merge until T28 is on main**

**Stage 2 (optional, only if there is time after stage 1 merges)**
- Street names for about 15 main streets on the whole-city layer (`drawLabels` currently draws only building names, from `2-basemap.js:199`)
- In the whole-city view, a "junction micro-simulation" marker at La Trobe × Swanston that flies to `HOME` when clicked
- The slowed sections when two works run together in the overlapping-works clash (T21) (92–95% are outside the window; the page does not draw them today)

**Not doing**: simply enlarging WORLD; making the window follow the works; extending to Docklands / Southbank / Carlton (the data would need re-fetching, and `walk.json` / `peds.json` are already close to the 2 MB limit); the whole City of Melbourne area. The last two go into the pitch's "next steps".

### 3.3 Acceptance
- At 1440×900 in steps 1 and 3 with the default Lonsdale plan: the map frames the works area, the queue line and the three detours via Russell / Exhibition / Spring, all outside the glass panels, with none cut off at the edge of the window
- Zoomed all the way out, the whole Hoddle Grid and more than 1,400 buildings are visible; dragging the whole city stays ≥ 50 fps in DevTools Performance
- At 375×812: both of the above hold, with no horizontal scrolling; clicking the map at zoom below 1 does not move the works area
- Click through all six weather types: each appears only in the original window, is hidden when zoomed out, and throws no errors
- Switch to the La Trobe 17:00 plan, the full-closure plan and the T21 overlap once each; the detour lines and the affected bus lines are drawn in full
- Negative assertions (new `tests/test_t27.py`):
  - Under the Lonsdale plan, the background queues on Flinders / King St are not drawn (using T28's `extra_min`)
  - The length of the queue line does not exceed the summed length of the real sections it passes through
  - At zoom below 1, `engCands` does not accept clicks
  - The weather and micro-simulation grids are still built on `WORLD`, not `CITY`
- `bash apps/web/test.sh` all green and `bash scripts/check.sh --quick` with no ❌, with the summary line pasted; desktop and 375 px screenshots in the PR

### 3.4 Timebox and fallback
- Timebox: **the PR must be green before 09-30 22:00** (check with no ❌, and both screenshots approved), leaving time before the freeze for bug fixes and deployment
- If it is not green by then, T27 does not merge; the fallback is a static "whole-CBD impact" image drawn offline by the lead with node and put in the pitch. T28 merges whether or not T27 does
- If stage 1 runs past 5 h without finishing, stop and talk to the lead first; do not cut the acceptance criteria yourself

## 4. Changes running in parallel with the lead (what merges first, what not to touch)

### 4.1 The AI road-user panel is merged into main (#76, 09-30 00:0x, deployed)
It changed the following (T26 and T27 may change wording next to these, but must not delete or move them):

| File | What changed |
|---|---|
| `apps/web/src/js/9-ai.js` (new) | Step 3 "AI road users · what each one read": 4 road-user cards + an expandable "AI call log" + JSON download; `aiPlanSrc()` / `aiSrcLabel()` for the sign-reading badge |
| `apps/web/src/js/5-app.js` | The line `clashMount();aiMount();` in the step 3 render |
| `apps/web/src/js/6-engine.js` | The sign-reading badge in `engBadges(f,s)` and the step 3 legend now use `aiPlanSrc` / `aiSrcLabel` |
| `apps/engine/public/js/backend.js` | `be.aiLog()` / `be.onAiLog()` / `be.readingsOf()` / `be.lastReadings()` |

The AI explanation under the plan cards in step 4 is T23 (#73, `8-compare.js`), not the AI panel.

### 4.2 Merge order
**#72 (merged) → #76 (merged) → T28 → T26 → T27**; at each step wait until the previous one is on main before opening the next branch.

To start T26:
```bash
git fetch origin && git switch -c unicornnnnnny/web/T26-t20-tail origin/main
```
T27 starts the same way: after T26 merges, open `unicornnnnnny/web/T27-full-cbd` from the latest `origin/main`.

### 4.3 What not to touch
- **Do not restructure the step 3 panel, and do not rearrange the step 4 plan cards** (`8-compare.js`): the AI road-user cards and the AI explanation hang off these two places. Changing button and heading text is fine (for example the rows in 2.6); moving blocks or changing the DOM hierarchy is not
- When T27 changes map framing and drawing, keep the line `clashMount();aiMount();` in `5-app.js`; do not delete it or move it out of the step 3 render branch (`apps/web/tests/test_ai.py` checks it)
- In `6-engine.js` the sign-reading badge and legend use `aiPlanSrc` / `aiSrcLabel`; T26 and T27 keep these two calls

### 4.4 If there is a conflict
- **Never edit or hand-resolve conflicts in** `apps/web/public/index.html`: after `git merge origin/main`, just run `python3 apps/web/build.py` to regenerate it, then `git add apps/web/public/index.html`
- When both sides added assertions to `apps/web/tests/test_web.py`, **keep both sides** and delete none
- Resolve conflicts in `src/` function by function: keep both the calls the AI panel added and your changes; if unsure, stop and ask the lead

### 4.5 Deployment
You are the deployer (D-0929-1322). The AI panel, #72 and #73 were deployed by the lead as backup deployer at 09-30 00:1x (b4bc2c6). **Once T28 and T26 are both on main, deploy once** with `bash scripts/deploy.sh all`; do not deploy after every merge. Deploy again after T27 merges. After deploying, run `bash scripts/check.sh --e2e` and paste the summary line into a handoff note.
