# T14 Liquid-glass web page — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done:
  - On desktop (≥ 821px) the map fills the whole window; the top bar, layer bar, analysis panel and timeline are now glass panels floating over the map. `--safe-t/b/l/r` on `.app` record how much of the map the glass covers; `readInsets()` in `js/7-glass.js` reads these values, and `flyTo` / the scale bar / graticule labels / alert cards / the step 4 divider are all placed only within the remaining map area.
  - Real refraction is applied to only two panels, the analysis panel and the top bar ([PRD](../specs/T14-liquid-glass-PRD.md): 1–2 panels). The technique is adapted from liquid-glass.js (Deepika Rao, github.com/sven1577/liquid-glass, MIT, credited in the `7-glass.js` file header): a canvas draws a displacement map, which goes through three offset `feDisplacementMap` passes via `backdrop-filter:url(#lg-n)`. It is applied only on Chromium desktop; Safari / Firefox / phones / reduced transparency get CSS frosting only.
  - Right-hand panel slimmed down:
    - Default "Compact": hides the `p.muted` explanatory text and folds secondary sections behind their headings (click a heading or press Enter to expand). Numbers, inputs and plan cards are expanded by default.
    - "Detailed" opens everything in one click.
    - A button in the top-right corner collapses the whole panel; once it is collapsed, a vertical "Analysis panel" button appears on the right edge, and clicking it restores the panel. The choice is stored in localStorage as `rt-panel` / `rt-pmin`.
  - Roads clearer than buildings (09-29 request): `emphasizeRoads()` runs once per view change inside `renderBase()` (not every frame), pushing roofs towards the ground tone, brightening carriageways and outlining kerbs. Buildings and engine data are unchanged.
  - Colours: the primary action colour is now the orange from the Codex version (`--sun`), used for the current step, the layer buttons and the basemap buttons; glass base opacity ≥ 0.72.
  - New `tests/test_glass.py`, 22 tests, covering: fallback, credit, number of refracting panels, `--safe-*`, Chinese and English, keyboard operation, `emphasizeRoads` not running every frame.
- Where it stopped (09-29 19:05): feature done, waiting for review.
- Branch / PR: `unicornnnnnny/web/T14-liquid-glass` (PR still to be opened)
- Verification:
  - `bash apps/web/test.sh` → `143 passed, 0 failed`
  - `bash scripts/check.sh --quick` → `======== Summary 0 ❌ 0 ⚠️`
  - Checked in a browser: 1440×900 dark / light × steps 1, 2, 3, 4; 375×812 dark, no horizontal scrolling; Chinese / English switch; panel collapse / expand.
- Not yet verified:
  - The real frame rate of step 2: rAF does not run while the preview window is hidden, so it cannot be measured. JS takes about 0.3 ms per frame and road emphasis about 0.5 ms per basemap redraw, but the GPU cost of glass compositing has to be checked in a visible browser.
  - Safari / Firefox not checked on real devices; by design they should fall back to frosting.
  - No screenshots of 375 light, or of steps 3 and 4 on phones.
- Cost this session: 0

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| — | — | None |

## 3. For the lead
- Decided (09-29 19:15, @unicornnnnnny):
  - Action colour unified to orange `--sun`: primary buttons, the play button, selected chips / speed / language / theme, the progress bar and panel section headings have all changed. Teal is kept only for "better / after repair" numbers, the safety score, the v2 tag and map overlays. In the light theme, orange text uses the darker `--sun-ink` (#A35A00) to keep the contrast.
  - Glass made more transparent, Apple-style (09-29 19:40, requested by @unicornnnnnny):
    - Regular glass base opacity is about 0.40 (the PRD suggests ≥ 0.72, so this departs from it; the PRD's hard requirement "contrast ≥ 4.5" is still met).
    - Legible text relies on `--glass-tone`: the dark theme darkens the map behind to 0.5×, the light theme brightens it.
    - Adapts to the background: in the light theme over the imagery / near-infrared basemaps or the heat layer, the glass becomes a 0.72 milky white with stronger brightening; in the dark theme over dense fog it darkens to 0.33×.
    - `data-bm` / `data-wx` on `<html>` are written by `updateBasemapUI()` / `setWeather()` in `5-app.js`.
    - Measurement method: composite the map's canvas layers, take block means at the blur radius, then apply the darkening / brightening, base colour, highlight and card. Tested 3 basemaps × 6 weathers × dark and light; worst case for the smallest text, `--fg-3`: dark 4.50, light 4.57.
- Decisions needed:
  - The panel defaults to "Compact"; @unicornnnnnny will look at the result first and then decide.
  - In the light theme with the imagery basemap, the glass is fairly white (to keep the contrast). If it does not feel transparent enough, the only options are larger or bolder small text; the opacity cannot go any lower.
- Risks:
  - `backdrop-filter:url()` may drop frames on low-end integrated graphics. If it really does, remove the top-bar panel from `applyGlass()` in `7-glass.js` and keep only the analysis panel.
- Needs from others: none
- Other things noticed along the way: Codex's `rippletwin-liquid-glass.html` is an old standalone version (not connected to the engine). This work was done on the latest `apps/web` in the repository, not on top of that file.

## 4. Next steps
- First command for the next person: `python apps/web/build.py && bash apps/web/test.sh`
- Dev server name (launch.json): `site` (wrangler dev, 8790, open `/web/public/`)
