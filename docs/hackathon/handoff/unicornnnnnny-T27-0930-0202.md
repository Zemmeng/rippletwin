# T27 The map shows the whole CBD (+ wrapping up T28 / T26) — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done:
  - **T28** (#79, merged by the lead): each entry in the engine's `raw.links` now also gives `extra_min` (vehicle-minutes compared with the same hour without works; can be < 0); 7 tests in `apps/engine/tests/extra.test.mjs`.
  - **T26** (#80, merged by the lead): 7 items finishing off T20; see the PR description.
  - **T27 phase 1** (#85, merged by the lead):
    - New file `apps/web/src/js/6c-city.js`: the whole-city road network + buildings pre-rendered to off-screen canvases (one each for light and dark), laid under the detailed window (`WORLD`), with the seam marked by a thin dashed frame.
    - `CITY={x0:-1150,x1:750,y0:-950,y1:450}`: dragging, the minimum zoom (`cityMinS()`) and the engine lines all follow it. At zoom < 1 the weather, the micro-simulation pedestrian figures, the graticule and the probe are hidden, and clicking the map does not move the works area.
    - The queue line is drawn along links with the same street name by `len_m` and stops where the street ends (the default plan draws 544 m, to Spring St); the label still gives the engine's "Queue 918 m · drawn up to Spring St".
    - The scale bar uses `K_UPM=0.862` (1 m ≈ 0.862 page units).
    - The filter for slowed links and their red / yellow colouring look only at `extra_min` (#82); the red of the label on the most congested link on the map now also follows `extra_min`.
    - Engine label placement (`tagSpot` / `tagFlush` in `5-app.js`) avoids the glass controls, the works section and other labels. At 375 px in step 3, the works label used to sit under the zoom buttons, half off screen.
    - Also two items from the T26 review: the parameter badge "T12 (trust is an assumed value)"; the step 3 subtitle "Impact · network", consistent with the step bar.
    - Tests: new `apps/web/tests/test_t27.py` (39 tests, 13 of which run `t27_glue.mjs` on the real network with the real engine).
- Where it stopped (09-30 02:02): T27 merged (`bad055d`) and deployed live; phase 1 done.
- Branch / PR: #79, #80 and #85 are all merged; this handoff note goes on `unicornnnnnny/web/T27-handoff`.
- Deployment ([PRD](../specs/T26-T27-web-PRD.md) section 5):
  - T28 + T26 were deployed by the lead.
  - T27 was deployed by me: `bash scripts/deploy.sh all`, commit `bad055d`, 2026-09-30 01:59 AEST, api + site.
  - Live smoke test after deployment:
    ```
    $ bash scripts/check.sh --e2e https://hackathon-site.zemmmeng.workers.dev
    [E1] Home page GET / ✅ 200, contains data-smoke
    [E2] Health check GET /api/health ✅ {"ok":true,"v":"0.3.0","mock":false,"llm":{"mode":"llm","model":"deepseek-flash","key":true,...
    [E3] No localhost in HTML ✅
    ======== Summary 0 ❌ 0 ⚠️
    ```
- Verification:
  - Before merging: `bash apps/web/test.sh` → `356 passed, 0 failed`; `bash scripts/check.sh --quick` has no ❌; #85 CI green.
  - Tested in a browser (numbers in the #85 description): framing at 1440×900 and 375×812; zoomed all the way out, the 1,833 buildings inside `CITY` are drawn; all six weathers; La Trobe 17:00, the full closure and T21's overlapping works each viewed once.
  - Live: `CITY`, the whole-city layer, the live engine, "03 Impact", the queue label and the T12 badge are all in the new version.
- Not yet verified:
  - A frame rate of ≥ 50 fps has not been measured in Chrome DevTools yet. In the in-app browser: T27 drags at 44.5 fps, the old live version at 40.7 fps; with `backdrop-filter` off, dragging the whole city runs at 120 fps with 0.7–1.6 ms of JS per frame. So the ceiling comes from glass compositing, not from T27.
  - Safari.
- Cost this session: 0

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| `docs/3-tasks.md` (now [`docs/hackathon/task-board.md`](../task-board.md)) | "Live version" at the top | commit `bad055d` (#85 T27: the map shows the whole CBD) · deployed by @unicornnnnnny at 09-30 01:59; live smoke test 0 ❌; `/api/health` = `llm.mode llm` (deepseek-flash) |

## 3. For the lead
- Decisions needed (three places where #85 differs from the PRD; already merged, and I will change them if you think they are wrong):
  - The north edge of `CITY` is y 450 (Franklin St), not 350: the La Trobe 17:00 detour reaches y 390–420.
  - `engFit` frames detours with a share ≥ 1%, not ≥ 5%: once LLM sign reading was connected, the default plan's three detours carry only 4.4–4.8%.
  - With a full closure, all the affected bus routes are drawn but are not included in the framing (63% visible in the default framing, all visible one zoom level out).
- Risks:
  - Frame rate: if Chrome also stays below 50, the thing to change is T14's glass layer (e.g. pausing refraction while dragging), not T27.
- Needs from others: none
- Other things noticed along the way:
  - PRD phase 2 (main street names, a "junction micro-simulation" marker in the whole-city view, slowed links when T21's two works run together) was not done. It could be assigned if there is time before the freeze.
  - `apps/api/tests/workerd.test.mjs` gets the path wrong on Windows (`.pathname` includes the drive letter), so every time I deploy I have to move `apps/api/node_modules` out of the way temporarily. The fix is two lines (`fileURLToPath`), verified locally at 28 passed; it is cross-module, so I will open a PR once you agree.

## 4. Next steps
- First command for the next person: `git switch main && git pull && bash apps/web/test.sh`
- Dev server name (launch.json): `site` (wrangler dev, 8790, open `/web/public/`)
