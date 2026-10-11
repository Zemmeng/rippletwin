# T14 PRD: restyle the web page as "liquid glass"

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @unicornnnnnny · Module: `apps/web/` · Branch: `unicornnnnnny/web/T14-liquid-glass` · Written 2026-09-29 17:20 (the lead, @Zemmeng)
> Basis: the lead's request "have @unicornnnnnny restyle it as liquid glass"; D-03 (zero build, no added libraries); T13 has already wired steps 1, 3 and 4 to the engine (PR #43), so this task touches appearance only

## 1. Why

The page's `.glass` is currently one flat layer of frosted glass. For the demo and the pitch screenshots it should look more like a mature product: use the visual language of Apple's Liquid Glass (WWDC 2025), so that the controls floating over the map look like a piece of glass with thickness that refracts the map below. **Change the appearance only, not the features or the numbers.**

## 2. What liquid glass looks like (in CSS terms)

| Feature | How |
|---|---|
| Translucent, letting the map show through and "refract" | `backdrop-filter: blur(14–24px) saturate(160–180%)`; only on the HUD floating over the map (see performance in section 4) |
| Highlighted edges, like the thickness of glass | Layered `box-shadow`: a 1 px inner highlight at the top (`inset 0 1px 0 rgba(255,255,255,.5)`), a dark inner edge at the bottom, a soft outer shadow; a 1 px gradient border (`border` in translucent white + `mask`, or a pseudo-element) |
| Large radii, pill-shaped controls | Panels with 16–22 px radii; buttons, chips and segmented controls as pills (`border-radius: 999px`) |
| Colour changes with what is underneath | The glass itself carries only a very faint tint (`--glass-tint`), one each for the dark and light themes |
| (Optional) real refraction | Try an SVG `feDisplacementMap` edge bend on 1–2 main panels only; only Chrome supports `backdrop-filter: url()`, other browsers fall back to a plain blur, and this must never blank the page |

All new colours are tokens in `:root` (add `--glass-hi`, `--glass-edge`, `--glass-tint` and the like next to the existing `--glass` and `--glass-line`), written for both dark and light (in both the `prefers-color-scheme` and the `[data-theme]` blocks).

## 3. Scope

| Change | Do not change |
|---|---|
| `src/styles.css`: `.glass` (the HUD on the map: scene info, weather, basemap switch, zoom, legend, value probe, alerts, hints), the top bar, the step bar, the left layer bar, the cards in the right-hand panel (`.card .metric .list .table .eng-*`), buttons, chips, segmented controls, the timeline | The logic and numbers in `src/js/*.js`; how the map canvas is drawn |
| `src/body.html`, only where an extra wrapper element is needed for a highlight | `id`s, `data-*`, class names the JS uses (renaming them means the JS can no longer find the elements) |
| If needed, add classes in the templates in `src/js/5-app.js` / `6-engine.js` | Chinese and English copy (new copy still uses `L('English', 'Chinese')`) |

The VMS input box keeps its LED look of amber text on black (it imitates the roadside sign); its outer frame may be glassified.

## 4. Constraints

- **Legibility**: text on glass has a contrast ratio ≥ 4.5:1, readable even over the busiest basemaps (near-infrared, the thunderstorm layer); the glass tint under text must be strong enough (suggested panel opacity ≥ 0.72)
- **Accessibility**: `@media (prefers-reduced-transparency: reduce)` falls back to solid panels; `@media (prefers-reduced-motion: reduce)` has no moving highlights; `@supports not (backdrop-filter: blur(1px))` also falls back to solid
- **Performance**: the map redraws every frame, so `backdrop-filter` goes only on the few HUD elements floating over the map (about 8); do not blur the right-hand panel, list rows or buttons one by one. When done, open step 2 (the busiest simulation) at 1440×900 and check ≥ 50 fps in DevTools Performance
- No added libraries and no external resources (fonts still only from Google Fonts), D-03
- Phones at 375 px: no horizontal scrolling; both the dark and the light theme must look good

## 5. Acceptance

1. After changing `src/`, run `python3 apps/web/build.py`
2. `bash apps/web/test.sh` all green (65 assertions; appearance changes should not turn any of them red) and `bash scripts/check.sh --quick` with no ❌
3. Start `site` in preview (8790, with the engine), open `/web/public/` and take screenshots: desktop 1440 and 375 px × dark / light theme × steps 1, 3 and 4, in the PR description
4. Open a PR; the lead merges and deploys

## 6. Timebox

2 h. Do the most visible things first: the HUD on the map + the cards in the right-hand panel + buttons and chips; then the top bar, the layer bar and the timeline.

To start:

```bash
git switch main && git pull
git switch -c unicornnnnnny/web/T14-liquid-glass origin/main
```
