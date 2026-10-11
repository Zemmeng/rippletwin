# 2 · Plan, roles and timeboxes

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> The module table is the boundary between people. When a timebox runs out we cut scope; we do not extend it. Lead edits only (filled in at kickoff steps 2–3).
>
> Challenge 5: RPM Hire, "Digital Tool for Temporary Infrastructure" · choice of challenge in `D-0929-1215` (decision IDs refer to [docs/decisions.md](../decisions.md)) · detailed specs in [specs/](specs/); the diagrams (start with [`1-system-flow.pdf`](https://github.com/Zemmeng/rippletwin/blob/hackathon-final/docs/arch/1-system-flow.pdf)) are kept only at the `hackathon-final` tag · filled in 2026-09-29

## One-line pitch

**Others simulate "a stretch of road is missing". We simulate "what people see and what they will do", and "what happens when several works add up".**

(The idea came from teammate @jinmingq.) In more detail: before works start, try them on a web page first. If this stretch is closed, which way will people go, how long will they be held up, and who is hit hardest?

## Users and pain points

**Who**: council traffic staff who plan closures, and contractors (the people who hire barriers, signs and VMS boards from RPM Hire).

**When**: before works start, they must decide which stretch to close, which equipment to place where, and what the sign should say.

**What hurts today**:

- "How many people will detour" is guesswork, often a fixed share (say 10%). Nobody can say whether the sign wording does anything for the queue
- Each works permit is fine when reviewed on its own; the jams come when several overlap in the same area at the same time, and nobody calculates that
- Only cars are considered. How much tram and bus riders, pedestrians, cyclists and wheelchair users are affected is invisible

**The new question we can answer**: change one line on the sign, and how much shorter does the queue get?

## The 3 "wow" moments in the demo (scope is worked back from these)

1. **Change one VMS message, the queue gets shorter**: the equipment and its positions stay the same; only the sign text changes from "Roadworks ahead" to "Use Russell St, save 8 min", and the queue length and the impact on each group are recomputed at once (the numbers are whatever the simulation gives)
2. **Two works together: 100 + 80 ≠ 400 minutes**: add another works site nearby. Each is fine on its own; the extra delay when both run together is the "clash cost"
3. **The ledger proposes a stagger**: stagger one by a few days and the clash goes away. Compare total delay and the impact on each group, then zoom into the junction at the works site to look at cyclists and pedestrians

## Options compared (rejected options keep a row with the reason)

| Option | In one line | Wow moments | Fit to the criteria | 48 h risk | Verdict |
|---|---|---|---|---|---|
| A Challenge 5 agent simulation | An LLM plays 4 types of road user who "read" the signs and boards; the engine computes delay in the browser; the page is hosted on Cloudflare | All three acts | Potential effectiveness 40%: answers "change one line on the sign, how much shorter is the queue"; technical feasibility 30%: real traffic flows + a working web page; originality 15%: road-user agents that read signs, clash cost of multiple works; business 10%: RPM hires out equipment in the recommended configuration | Medium: the real network data needs cleaning; LLM results must be precomputed and stored | Chosen (`D-0929-1215`) |
| B Python backend / Streamlit | The same features, with the computation on a Python server we run ourselves | Same as A | Same as A | High: the server has to stay up the whole time; if it goes down during judging the page will not open | Rejected: the server must always be online |
| C Live LLM calls for everything | Ask the LLM on the spot every time the plan changes, with no cache | Same as A, but with waiting | Same as A | High: slow and expensive; the demo may fail on stage | Rejected: slow, expensive, may fail on stage |

## MVP

| P0 must have | P1 nice to have | Out of scope |
|---|---|---|
| One closure → traffic detours → delay computed | Planning advisor agent: looks at the results and proposes 3 changes (rewrite the message / stagger the dates / move equipment), each recomputed by the engine | Stakeholder coordination workflow (sign-off from bus operators, emergency services, businesses): slides only |
| Before/after comparison of a VMS message change | Tram track markings | Automatic search for the best plan (scope not final yet) *(unverified)* |
| Clash cost of two overlapping works | Key junctions matched to lanes using the detector configuration sheets | |
| Impact by group: commuters, bus and tram riders, pedestrians, cyclists, wheelchair users | | |
| Junction zoom (`apps/sim`, real flows) | | |

Anything cut stays cut unless there is a new entry in the decision log.

## Architecture

The 6 steps a user goes through, and which external service each step uses:

```
Our 6 steps (all in the browser that opens the page)   Who        External service

[1] Open the web page                                   T2 web    ◀── Cloudflare: page + data files, online 24 h
 │
[2] Draw the works plan on the map                      T2 web    ◀── OpenStreetMap basemap (free, credited on the page)
 │   pick the road segment and times; place barriers /
 │   signs / VMS and write the sign message
 │
[3] Ask 4 types of road user: seeing this,              T4 → T5   ◀── LLM (called only via Cloudflare, cache first, MOCK by default)
 │   which way will you go?
 │   commuter driver / local / visitor / delivery driver
 │
[4] Compute the impact: where cars detour, where it     T4        ◀── open data downloaded in advance (T3 turns it into JSON, no key)
 │   jams, how many extra minutes; how much tram and
 │   bus riders, pedestrians, cyclists and wheelchair
 │   users are affected
 │
[5] Find other works nearby at the same time and        T4        ◀── Cloudflare storage: works list, everyone sees the same copy
 │   compute the overlap
 │   100 + 80 ≠ 400 minutes
 │
[6] Recommend changes, before/after comparison          T2 + T4       no external service, only our own computation
     change the sign message / move equipment / stagger by a few days
     └─▶ zoom into the junction at the works site       sim
         (how cars, bikes, trams and pedestrians merge and cross)
```

Where things live:

| Where | What | Who |
|---|---|---|
| Prepared in advance, shipped with the page | Network + baseline flow JSON; Q&A cache for the demo messages | T3, T5 |
| Cloudflare (the lead's account) | Page hosting; endpoints `/api/persona` and `/api/worksites` (draft); Q&A cache and works list; **the LLM key lives only here** | T5, T6 |
| The phone or computer that opens the URL | Panel, network engine (detours, delay, clash cost), junction zoom | T2, T4, sim |

**Principle: the LLM advises, the engine computes.** The LLM only "reads" the words on the sign: was it noticed, was it understood, which route does it tell you to take or avoid, how many minutes does it say you save or lose, do you trust it, and a one-line reason. It is asked once per road-user type per message (3 samples give a range), not once per vehicle. How many people take each route is computed by the engine's choice model from explicit per-type parameters, and two-point calibration tunes those parameters (D-0929-1435). Every minute and every queue length is computed by the engine, so when a judge asks "where does this number come from?", each step can be explained.

The data flow in 3 lines:

1. The panel (T2) hands the works plan to the engine (T4). The engine finds the possible detours, writes for each of the 4 road-user types "what they see along the way, in order", and passes it to T5's endpoint
2. T5 checks the cache first and only asks the LLM on a miss (MOCK by default). It returns a "reading" per type (noticed, understood, which route it points to, trusted), not shares. The engine turns the readings plus the per-type parameters into route shares, assigns the traffic and computes delay. People change their minds when it jams: when the queue grows, the engine recomputes by itself without asking the LLM again (D-0929-1435). The results go back to the panel
3. The works list is stored in Cloudflare. The engine computes A and B separately, then A+B together; the extra is the clash cost, `D(A+B) − D(A) − D(B)`, where D is total delay in minutes

Why this stack: see decisions `D-03` (zero-build web + Cloudflare) and `D-0929-1215` (challenge and direction). Computing in the browser means a changed line gives results at once, and we do not have to keep a server running. Paid calls default to MOCK, see `D-09`.

## Module table (kept consistent with CODEOWNERS, launch.json and the registry in apps/README)

| Module | Directory | Owner | Local port | Live path |
|---|---|---|---|---|
| web panel · T2 | `apps/web/` (to be created) | @unicornnnnnny | TBD | TBD |
| roads network data · T3 | `apps/roads/` | @louisxie316-dotcom | TBD | `/roads/public/cbd/` |
| engine network computation · T4 | `apps/engine/` (skeleton created, T9, #20) | The lead's engine session (T9, D-0929-1500) | — (run `tools/demo.mjs` with node) | `/engine/public/js/` |
| api LLM and cloud · T5 | `apps/api/` | @jinmingq | 8788 | TBD |
| params engine parameters · T12 | `apps/params/` (to be created) | @Unzzip | — | `/params/public/params.json` |
| sim junction zoom · T6 integration and deploy | `apps/sim/` | @Zemmeng (lead) | 4174 | `/sim/public/` |
| site same-origin site shell · T10 | `apps/site/` | code @Zemmeng · deploy @unicornnnnnny | 8790 | `/` (= `DEMO_URL`) |
| pitch | [demo-script.md](demo-script.md) | TBD | — | — |

- Live paths are prefixed with the domain, which is `DEMO_URL` in `hackathon.conf` (still empty; the lead fills it in after M1). Deploy rule: each module's `public/` is mounted as is at `/<module>/public/` by a single Worker in `apps/site` (`/api/*` is forwarded to T5 through a service binding; steps in [`apps/site/README.md`](../../apps/site/README.md))
- T6 = the lead handles integration and merges PRs, and also owns the sim junction zoom. **Deploys are run by @unicornnnnnny** (DEPLOYER, `D-0929-1322`), with the lead as backup deployer
- The sim UI files (index.html, style.css and js/ui.js under `apps/sim/public/`) are edited by @unicornnnnnny; the engine, data and tests belong to @Zemmeng (`D-0929-1226`)
- Handover between T4 and T5: T4 delivers "what each of the 4 road-user types sees, which routes they can take and how long each takes"; T5 returns "for each type: noticed or not, understood or not, a probability per route, and a one-line reason". The fields are final; see the "road-user agent" section of contract v2 (T7), now [docs/reference/interfaces.md](../reference/interfaces.md)

## Milestone timeboxes (lead only)

This event runs about 50 hours (09-29 09:30 → 10-01 12:00); we follow the 48 h column. T− counts down from 10-01 12:00.

| Milestone | 48 h timebox | 24 h timebox | Verifiable done criterion | Owner | Actual |
|---|---|---|---|---|---|
| Start | T+0 | T+0 | — | — | 09-29 09:30 |
| M0 read the brief, choose a direction | T+0 to 1 h | T+0 to 30 min | [challenge-brief.md](challenge-brief.md) filled in, solution chosen | lead | Done before 09-29 12:38 (challenge chosen, `D-0929-1215`) |
| M1 plan + a live hello-world for every deployable module | ≤ T+3 h | ≤ T+2 h | `bash scripts/check.sh --e2e` green | DEPLOYER | Target 09-29 21:00: one live URL that opens |
| M2 main-path skeleton (MOCK) | ≤ T+10 h | ≤ T+5 h | The main path can be clicked through on the live site; tag `skeleton` | everyone | |
| Pre-screen | — | — | 3 slides submitted (project overview / tech and progress / architecture diagram and screenshots) | pitch owner | Due 09-30 12:30 |
| M3 the 3 wow moments really work | ≤ T+30 h | ≤ T+15 h | Each wow moment has a test or a screenshot | everyone | |
| M4 pitch draft + ≥ 2 rehearsals + fallback screen recording + P0 cleared | ≤ T−8 h | ≤ T−4 h | ≥ 2 rehearsal rows in [demo-script.md](demo-script.md) | pitch owner | |
| Feature freeze | T−6 h | T−4 h | Announced in the decision log | lead | 10-01 06:00 |
| Code freeze | T−2 h | T−1 h | Tag `demo-v1`, deploy from the tag | lead | 10-01 10:00 |
| Submission | T−1 h to T−30 min | T−30 min to T−15 min | `/submit` checklist all done, tag `submission` | lead | Due 10-01 12:00 |

## Integration checkpoints

**09-29 17:00 and 21:00, then every 4 hours** (01:00, 05:00, 09:00 …). Everyone pushes before the hour → the lead runs `/lead` → at 20 past the hour, everyone runs `git merge origin/main`.

What each person delivers at the first checkpoint:

| Task | Deliverable | Due |
|---|---|---|
| T3 roads | Open a draft PR with a minimal `network.json` first (flows not required yet) | 17:00 |
| T4 engine | "Close a segment → reassign traffic → compute delay" working on a small 5×5 grid, with fake road-user choices for now | 17:00 |
| T5 api | A live endpoint on Cloudflare that returns fake data for now; profiles and prompt templates for the 4 road-user types written | 17:00 |
| T6 lead | One live URL that opens (M1) | 21:00 |

## When a timebox runs out

The lead chooses one of three within 15 minutes, with no extension: ① cut scope ② switch to a mock ③ degrade (for example, polling instead of real time).

## Mocks and fake data

- What each module returns when `MOCK=1`:
  - **api (T5)**: no LLM call; answers come from keyword rules. "Use X" or "save N min" on the sign raises the detour probability. The demo messages are asked for real in advance and stored in the cache, so the demo makes almost no live calls
  - **engine (T4)**: until the real network arrives, use a small 5×5 grid; until T5's endpoint works, road-user choices use the same keyword rules
  - **roads (T3)**: no mock. The output is static JSON; no API calls, no keys
  - Before asking the LLM for real, report the number of calls and the rough cost first (`D-09`); any spend goes into the quota ledger
- How to start bots or fake users (so the whole flow can be tested before everyone is in): no bots are needed, because nothing involves several users online at once. The "road users" are themselves 4 agent types: commuter drivers 50%, locals 25%, visitors 10%, delivery drivers 15% (the shares are assumptions for now; T5 is to find data to calibrate them). One person with the page open and MOCK on can go through all three acts

## Risks and fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| LLM down / rate-limited / too slow | Medium | MOCK keyword rules + demo Q&A precomputed in the cache |
| SCATS has only motor-vehicle data, and some detectors are broken (negative readings) | Confirmed | Label the estimation method: the `method` field in `flows.json` records how each link's number was obtained |
| T3's real network arrives late | Medium | T4 runs on the 5×5 grid first, in the format from the contract; swapping in the data needs no code change |
| Cloudflare live site down | Low | Local preview → screen recording |

## Sleep and shifts

Everyone sleeps at least 4 hours, staggered, and always writes a handoff note before sleeping.

| Who | Sleeps | Covered by |
|---|---|---|
| | | |

## Progress log (the lead appends a row at each checkpoint)

| Time | Milestone | Status | What was cut |
|---|---|---|---|
| 09-29 14:00 | Before M1 | T3 network data (PR #9) CI green, waiting for the author to merge; T2 waiting for the empty `apps/web` scaffold; T4, T5 and the pre-screen slides to be assigned at 17:00; T7 assigned to @louisxie316-dotcom (equipment inventory first) | Nothing |
| 09-29 14:45 | Before M1 | T3 network (#9) merged; T7 pedestrians / transit / equipment (#14) CI green, waiting for the author to merge; T5 assigned to @jinmingq (#16); [`llm-apis/`](llm-apis/) live (#17); the T2 web page was pushed but went off track, pulled back by D-0929-1445; nobody on T4 or the pre-screen slides yet | Nothing |
