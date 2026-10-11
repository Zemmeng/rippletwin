# T2 Web panel (RippleTwin GIS + extreme weather + four-step flow) — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done: created the `apps/web` module, a single-file web page that walks through four steps, "Plan → Stress test → Ripple trace → Repair". The map is a custom-drawn GIS: the dark theme uses orthophoto imagery (with a near-infrared false-colour alternative), and the light theme switches automatically to a light vector street map; six weather layers (radar dBZ, SAR flood depth, fog visibility, land-surface temperature, wind-field particles) with contours, legends and values under the mouse; a multi-agent simulation (IDM car-following, signal phases, TTC conflicts) drives step 2 to trigger a severe C-17 × D-42 conflict automatically; step 4 has a before/after slider for the repair; one-click Chinese / English switch.
- Where it stopped (09-29 14:40): feature-complete and run in a browser; not yet connected to the real road network from `apps/roads` or to T4's results, so the numbers are simulated / preset values
- Branch / PR: `unicornnnnnny/web/T2-gis-weather-ui` / the PR is opened from this branch
- Verification: `bash scripts/check.sh --quick` → summary line in the PR description; `bash apps/web/test.sh` → `27 passed, 0 failed`
- Not yet verified: production (Cloudflare) deployment; canvas pattern transforms in Safari (the fog layer uses `CanvasPattern.setTransform`)
- Cost this session: 0

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| `apps/README.md` | module registry | add a row: `web` · @unicornnnnnny · no starter (single-file static page) · 4175 · — |
| `.github/CODEOWNERS` | module section | add `/apps/web/                    @unicornnnnnny` |
| `.claude/launch.json` | configurations | add `web`: `python3 -m http.server 4175 -d apps/web/public` |
| `hackathon.conf` | `DEPLOY_MODULES` | add `web` when it needs to go live (static directory `apps/web/public`) |

## 3. For the lead
- Decisions needed: under R3 the lead was originally going to create an empty skeleton for `apps/web`; this time the T2 branch created the module directory directly, so please add the registry / CODEOWNERS entries as in section 2
- Risks: the repair plan's "move the barrier 8 m west" differs from "move it 12 m east" in the earlier Figma draft; the page and the tests go with 8 m west
- Needs from others: once T4 (network computation) has results, wire the delay / conflict numbers into steps 2 and 4 to replace the preset values
- Other things noticed along the way: the cause-and-effect chain in step 3 could be used directly as a pitch slide

## 4. Next steps
- First command for the next person: `python3 -m http.server 4175 -d apps/web/public`
- Dev server name (launch.json): none yet (waiting for the lead to add `web` as in section 2)
