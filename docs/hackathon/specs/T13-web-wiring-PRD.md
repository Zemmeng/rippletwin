# T13 PRD: wire the web page to the backend (RippleTwin's numbers move from presets to real engine output)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @unicornnnnnny · Module: `apps/web/` · Branch: `unicornnnnnny/web/T13-wiring` · Written 2026-09-29 16:00 (the lead, @Zemmeng)
> Basis: D-0929-1445 (the main path goes back to the 6-step flow), D-0929-1435 (the LLM only interprets, the engine computes), D-0929-1540 (the lead wires up the backend; the page only connects to `backend.js`), contract v3.1, works-plan and evaluate sections

## 1. Why

The numbers on the page today (conflict counts, delay, safety score and so on) are all hard-coded presets, so when a judge asks "where does this number come from?" we have no answer. The lead has already wired up the backend: the road network, traffic volumes, parameters, T5 sign reading and the engine are all packaged in one file, `backend.js`, and the page calls one function to get numbers it can display directly. This task covers **only the page side**.

## 2. Deliverables

| What | Acceptance |
|---|---|
| New `src/js/6-engine.js` that loads `backend.js` | Opened locally as in section 4, steps 1, 3 and 4 show the engine's numbers; if loading fails, the preset numbers stay and the page does not go blank |
| Step 1: pick a road section, place equipment, edit the sign text → build a "plan" | Changing a line of text or moving a VMS changes the numbers (call `run` once per change, not on every frame) |
| Step 3: share per route, queue, each road-user type, map highlights, "why" | Fields as in the table in section 5 |
| Step 4: before vs after the fix + advisor suggestions | Use `compare` / `advise`, fields as in section 5 |
| Label where numbers come from | When `flags.ok` is false, mark it yellow; `reading_src === 'rule'` is labelled "estimate"; `params === 'default'` is labelled "parameters are assumed values" |
| Change the negative assertions in `tests/test_web.py` | See section 6 |

## 3. Code to paste

The page is plain `<script>` concatenated by `build.py` (not a module), so use dynamic `import()`; top-level `await` is not available. `build.py` concatenates `src/js/*.js` in file-name order, so the new file is called `6-engine.js`:

```js
// 6-engine.js — backend wiring (docs/hackathon/specs/T13-web-wiring-PRD.md). If loading fails, keep the preset numbers
const BE = { api: null, err: null };
BE.ready = import('/engine/public/js/backend.js')
  .then(m => m.connect())                        // network + volumes + parameters + T5 sign reading + engine, set up in one go (about 1 s)
  .then(api => { BE.api = api; console.info('backend ready', api.status()); })
  .catch(e => { BE.err = e; console.warn('backend not connected, keeping preset numbers', e); });

async function beRun(plan) { await BE.ready; return BE.api ? BE.api.run(plan) : null; }
async function beCompare(before, after) { await BE.ready; return BE.api ? BE.api.compare(before, after) : null; }
async function beAdvise(plan) { await BE.ready; return BE.api ? BE.api.advise(plan) : null; }
function beCheck(plan) { return BE.api ? BE.api.check(plan) : []; }   // instant check while typing in the input box; synchronous
```

Get it working with a demo plan first, then switch to the plan the user builds on the page:

```js
const plan = BE.api.demo('lonsdale');                                        // main demo
const s = await beRun(plan);                                                   // → the summary in section 5
const c = await beCompare(BE.api.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), plan);   // before vs after changing one line of text
```

`demo(name, { frames, at_m, hour })`: `lonsdale` = Lonsdale St westbound at 8 am (one block from the La Trobe / Swanston junction; closing one lane builds a queue; the main demo); `latrobe` = the page's current scene, La Trobe St westbound at 17:00 (light traffic, almost no congestion). Which one is the main storyline, and how the map is laid out, is to be agreed with the lead.

The **plan** format (follow this when building one yourself; `links` are road-section ids from `network.json`, `at_m` = metres upstream of the start of the works):

```js
{
  when: { date: '2026-10-06', hour: 8 },
  worksites: [{
    id: 'B-12', links: ['l595594354_9756035316'], closes: { lanes: 1 },
    time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
    equipment: [
      { id: 'VMS-1', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']] },
      { id: 'S-1', type: 'sign', at_m: 100, text: 'RIGHT LANE CLOSED' },
      { id: 'A-1', type: 'arrow', at_m: 60 },                  // arrow board (readable since T5 #29)
      { id: 'B-1', type: 'barrier', at_m: 0 },                 // barriers are drawn only, not part of the readings
    ],
  }],
}
```

Sign text: ≤ 2 frames × ≤ 4 lines × ≤ 10 characters per line, upper case. Call `beCheck(plan)` while the user types in the input box: do not pass anything with `ok: false` to `run`; `warnings` are reminders only (`msg` is in Chinese; `code` can be mapped to English). Equipment types: `vms` (with `frames`), `sign` (with `text`), `arrow` (arrow board; `text` optional), `barrier` (drawn only, never read).

## 4. Running it locally

```bash
python3 -m http.server 8000 -d apps      # serve from apps/ so paths match production
# open http://localhost:8000/web/public/
```

There is no `POST /api/read` in this setup, so T5 sign reading falls back to the keyword rules automatically (`flags.reading_src = 'rule'`), which does not affect the wiring. Opening `index.html` by double-clicking (file://) cannot load the backend, so the preset numbers stay. In production the deployment shell `apps/site` (T10) mounts every module under the same URL.

## 5. What the numbers on the page become

`s` = the result of `beRun(plan)` (the summary):

| Place on the page | Now | Becomes |
|---|---|---|
| Step 1, plan | Preset geometry | Road section the user picked → `links`; equipment placed → `equipment` |
| Step 2, stress test | Weather preset `RESULTS` | **Unchanged** (weather is a second layer; the engine ignores weather) |
| Step 3, which road | Preset | `s.street` (main section = the one with the largest delay; with several works the others are in `s.approaches[]`, and the main one is `s.approaches[s.main]`) |
| Step 3, share per route | Preset | `s.routes[]`: `name`, `share` (0–1), `now_min`, `usual_min`; `id === 'stay'` is the original route; `s.detour_share` = detour share |
| Step 3, queue | Preset | `s.queue_m` (metres) |
| Step 3, affected vehicles | Preset | `s.vehicles` (vehicles per hour), `s.mean_delay_s` (mean extra seconds per vehicle) |
| Step 3, each road-user type | Preset | `s.by_type[type].per_capita_min` (extra minutes per person); type = commuter / local / tourist / delivery |
| Step 3, "why" | Preset copy | `s.why[type]` (T5's one-line reason on the main section; **use `textContent`**, not `innerHTML`) |
| Step 3, map highlights | — | `s.hot[]`: the ≤ 5 most congested sections `{ id, name, extra_min, v, cap, queue_m }`; all sections are in `s.raw.links[]`; take the geometry by `id` from `links[].geometry` in `/roads/public/cbd/network.json` |
| Step 4, mean car delay | `R.car` | `c.before.mean_delay_s` → `c.after.mean_delay_s` (`c` = the result of `beCompare`; a negative `c.delta.*` = better) |
| Step 4, queue / detour | — | `c.delta.queue_m`, `c.delta.detour_share`: compared on **the main section before the change** (`c.delta.street`), so the same road is compared before and after; when `c.delta.main_changed = true` the most congested road after the change is a different one, and the UI should say so |
| Step 4, AI suggestions | Preset Δ1–Δ4 | `beAdvise(plan)` → `options[]`: `kind` (text = change the wording / move = move equipment / shift = stagger the dates), `why`, `frames` / `at_m` / `days`, `delta_min` (negative = better, summed over the whole works period), `better`, `plan` (the changed plan, which can be passed straight to `beRun` and drawn) |
| Step 4, conflicts, harsh braking, TTC, buses, emergency access, safety score | Micro-simulation + presets | **Unchanged** (the engine does not compute these); keep the "simulated" label |

Where the numbers come from (for when a judge asks), in `s.flags`:

- `ok`: false = a reading was missing / the calibration did not hit / the sign text breaks the limits / vehicles are fully blocked with no detour → mark yellow and do not present it as a real number
- `blocked_vph`: > 0 = vehicles stuck behind a full closure with no detour (veh/h); not counted in the delay, show separately
- `inactive`: true = none of the works in the plan are active in this hour (all numbers are 0); show "no works at this time"
- The advisor result from `beAdvise` also has `flags.ok` (when a reading was missing, `delta_min` / `better` cannot be trusted); when the works have no dates, only this one hour is compared (`window.single_hour`)
- `reading_src`: `rule` = keyword-rule estimate; once switched to an LLM, the model name
- `params`: `params` = sourced (T12); `default` = assumed values
- `sign_errors[]` / `sign_warnings[]`: problems with the sign text (`msg` in Chinese)

## 6. Tests to update

The 3rd negative assertion in `apps/web/tests/test_web.py` is currently "no fetch in the JS". After the wiring, change it to:

- Only same-origin relative paths may be loaded (`/engine/`, `/roads/`, `/params/`, `/api/`); no other `http(s)://` domain may appear in the JS (Google Fonts excepted); keep the existing domain check
- Add one: the branch for a failed backend load exists (`BE.err`) and the page still shows the preset numbers

## 7. Rules

- Write only in `apps/web/`; `backend.js` and the engine belong to the lead; interface change requests go in section 2 of a handoff note
- After changing `src/`, run `python3 apps/web/build.py`
- When done: `bash apps/web/test.sh` green and `bash scripts/check.sh --quick` with no ❌; open it locally as in section 4 and take one desktop and one 375 px screenshot (the step 3 queue in metres and the step 4 before vs after must be engine numbers); open a PR

## 8. Timebox

2 h. Do "step 3 queue + route shares + step 4 before vs after for a one-line text change" first (the best for the demo), then the map highlights and the advisor suggestions.
