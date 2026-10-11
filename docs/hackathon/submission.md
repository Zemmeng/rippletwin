# Submission notes: third-party material, AI use, pre-event prep

*Archived from the hackathon (29 Sep – 1 Oct 2026). The English notes below are the text submitted to the judges; only links to moved files have been fixed. The team notes at the end are translated from the original Chinese; superseded details are kept as they were.*

> **Post-event update (11 Oct 2026).** The submission text is kept as it stood on 1 Oct 2026. What has changed since:
>
> - **SUMO container.** On 1 Oct the container was moved from `standard-2` to `standard-4` (4 vCPU, 12 GiB) so that each scenario of the full 08:00–09:00 run gets its own SUMO process (PR #130, D-1001-0045). After the event the owner deleted the container and the `hackathon-sumo` Worker, so `/api/sumo/*` now returns 502 `sumo_down`.
> - **SUMO ran on the real network.** From 30 Sep 22:23 (PR #118, D-0930-2200) SUMO ran on the real Melbourne CBD network built from `network.json` and the SCATS 08:00 flows, not only on the synthetic 2×2 grid described in §1, and step 02 of the page played its results. From PR #130 it covered the full 08:00–09:00 hour and supplied the traffic numbers shown for the Lonsdale demo plan. The live site now replays the pre-computed run in `apps/sumo/public/real/` (seed 42), labelled "pre-computed (cloud unavailable)". SUMO is a cross-check with assumed signal timing and turn shares, not a validation of the engine.
> - **LLM key removed.** The `LLM_API_KEY` secret was deleted after the event. `/api/health` now reports `llm.mode: "rules"`; the 92 pre-computed DeepSeek readings in `apps/api/public/answers/demo.json` still ship, and any new sign wording is read by keyword rules. "In use in the deployed demo" and `"mode":"llm"` below describe the event period.
> - **Missing credit.** `apps/web/src/js/7-glass.js` adapts the refraction technique of liquid-glass.js by Deepika Rao ([github.com/sven1577/liquid-glass](https://github.com/sven1577/liquid-glass), MIT). The file header credits it, but it should also have been listed in the software table in §1. It is credited in [NOTICE.md](../../NOTICE.md).
> - **Paths.** File paths in the submission text are as they were on 1 Oct. The event documents (`docs/1-brief.md` … `docs/4-demo.md`, `docs/arch/`, `docs/llm-apis/`, `docs/pitch-assets/`, `handoff/`) now live in this archive; see the [archive index](README.md).

> For the judges (FEIT Hackathon 2026, Challenge 5, RPM Hire). Covers competition **rules 3, 5 and 6**: no development before the event, public code repository, and a list of every third-party asset and API.
> Compiled 2026-09-29 22:05 AEST from what the repository itself shows; updated 2026-09-30 (live LLM, Open-Meteo, SUMO; 18:40: SUMO running in a Cloudflare Container, OSM vector basemap, Workers Paid plan).

## 1. Third-party data, assets, APIs and software

**Data used in the product.** We only use open data. All of it was downloaded ahead of time by scripts in `apps/roads/tools/`, and no data API is called at runtime.

| Source | Used for (file) | Licence | Attribution line |
|---|---|---|---|
| OpenStreetMap, fetched with OSMnx through public Overpass API instances | Road network, walking network and building outlines (`apps/roads/public/cbd/network.json`, `walk.json`, `buildings.json`) | ODbL 1.0 | © OpenStreetMap contributors |
| DataVic: Traffic Signal Volume Data (SCATS), DTP Victoria | Hourly vehicle flows, 2026-08-01 to 09-27 (`flows.json`, `apps/sim/public/demand/`) | CC BY 4.0 | Traffic Signal Volume Data, Department of Transport and Planning, Victoria |
| DataVic: Victorian Traffic Signals (site list) | Signal locations matched to network nodes (`network.json`) | CC BY 4.0 | same as above |
| DataVic: Traffic Signal Configuration Data Sheets | Detector layout for site 2921 (`apps/sim`) | CC BY 4.0 | same as above |
| DataVic: PTV GTFS Schedule, 2026-09-26 release | Tram (sub-feed 3) and metro bus (sub-feed 4) routes and stops (`transit.json`) | CC BY 4.0 | Public Transport Victoria, via DataVic |
| City of Melbourne: Pedestrian Counting System (hourly counts and sensor locations) | Footpath volumes (`peds.json`, `apps/sim`) | City of Melbourne Open Data (the dataset page states no licence; the other datasets in the series are CC BY) | City of Melbourne Open Data |
| City of Melbourne: 2018 Building Footprints | Building heights (`buildings.json`) | CC BY | City of Melbourne Open Data |
| City of Melbourne: Building information (CLUE census 2024) | Building use and floor count (`buildings.json`) | CC BY | City of Melbourne Open Data |
| Open-Meteo Historical Weather API (`archive-api.open-meteo.com`), model `ecmwf_ifs` | Hourly weather 2026-08-01 to 09-27 for an offline back-test of the weather layer (`apps/roads/public/cbd/weather_hourly.json`, `weather_backtest.json`); not shown on the page | CC BY 4.0 data, fetched once through the free API, whose terms allow non-commercial use (a student hackathon back-test) | Weather data by Open-Meteo.com |
| Bureau of Meteorology: daily weather observations, Melbourne (Olympic Park) | Manual cross-check of rain days for that back-test; downloaded by hand, not committed | © Commonwealth of Australia, reference only | Bureau of Meteorology |
| RPM Hire website product pages (checked 2026-09-29) | Equipment types and specifications (16 items in `equipment.json`: the 7 hire products link to their product pages, the 9 static signs use TfNSW sign codes). **Quantities and day rates are our own assumptions** because the site publishes no prices. No images or text were copied | Reference only | RPM Hire (challenge sponsor) |
| OpenMapTiles vector tiles served by OpenFreeMap (`tiles.openfreemap.org`), built from OpenStreetMap | Background map layers around the fine window: water, green space, land use, rail and tram lines. Six z14 tiles fetched at build time by `apps/roads/tools/fetch_vectormap.py` and decoded into our own `apps/roads/public/cbd/vectormap.json` (PR #111); the page never contacts the tile server | OpenMapTiles schema CC BY 4.0; data ODbL 1.0 | Vector basemap © OpenMapTiles / OpenFreeMap, data © OpenStreetMap contributors |
| TfNSW sign register (codes T1-1, T2-16) | Sign codes in `equipment.json` | Reference only | Transport for NSW |

On the web page, source credits appear next to the layers that use them: "OSM · City of Melbourne" on the building layer, "Timetabled trips from PTV GTFS" in the tram panel and "City of Melbourne pedestrian counts" in the pedestrian panel.

**Numbers from the literature** (`apps/params/public/params.json`). Every value has a source and a confidence rating, and low-confidence values are labelled "assumed" on the page (D-0929-1536). Sources:

- ATAP PV2 Road parameter values (2016): travel time
- City of Melbourne, Update of the strategic transport evidence base (car occupancy 1.09, from the 2016 Census journey to work)
- ABS Census 2016 and ABS Survey of Motor Vehicle Use, for the road-user mix, which is a labelled assumption (not re-checked on 30 Sep)
- Chatterjee, Hounsell, Firmin & Bonsall 2002 (TR Part C)
- Erke, Sagberg & Hagman 2007 (TR Part F)
- Bonsall & Palmer 1999 (book chapter)
- Wardman, Bonsall & Shires 1996 (ITS Leeds Working Paper 475)
- Austroads GTM Part 10 (2020); AS 4852.1:2019 and AS 4852.2:2019
- Transport for NSW TSI-SP-008 (2021)
- Dudek 2001 (NJDOT VMS operations manual)
- O'Fallon & Sullivan 2007 (Land Transport NZ Research Report 316)

Full citations with DOI or URL, each checked on 2026-09-30, are in [README §10](https://github.com/Zemmeng/rippletwin/blob/hackathon-final/README.md#10-references) (as submitted).

The papers behind our design choices (Meister 2024, Xiong 2024, Wang et al. 2025, Song et al. 2025, Liu, Li & Yin 2026) are cited in [`docs/decisions.md`](../decisions.md) only. We use their numbers and cite them; we do not reproduce their text.

**Software and services**

| Item | Role | Licence / terms |
|---|---|---|
| Cloudflare Workers (+ service bindings from `site` to the `api` and `sumo` Workers) | Hosting of the demo at `hackathon-site.zemmmeng.workers.dev`. Workers Paid plan since 2026-09-30 (see "Paid purchases") | Cloudflare terms |
| Cloudflare Containers | Runs the SUMO service (`apps/sumo`, Worker `hackathon-sumo`, one `standard-2` instance with 1 vCPU) behind `/api/sumo/v1/*`; per-IP rate limit via the Workers rate-limit binding (D-0930-1700) | Cloudflare terms |
| `@cloudflare/containers` 0.3.7 (npm) | Container class and routing in `apps/sumo/src/worker.js` | MIT OR Apache-2.0 |
| Docker official image `python:3.12-slim` (Docker Hub) + Debian packages (libX11, libGL and friends, libatomic) | Base of `apps/sumo/Dockerfile`; the image was built on the lead's Mac with colima + Docker CLI (Homebrew) | PSF and Debian package licences |
| Wrangler CLI (npm, dev dependency of `apps/api`, `apps/site`, `apps/web`) | Local dev and deploy | MIT / Apache-2.0 |
| GitHub Actions: `actions/checkout`, `actions/setup-node`, `actions/setup-python`, `cloudflare/wrangler-action` | CI checks and the manual-only deploy workflow (`.github/workflows/`) | Open source, see each action's repository |
| OSMnx (+ networkx, geopandas, shapely, requests) | Offline data preparation only (`apps/roads/requirements.txt`), not shipped | MIT / BSD-3 |
| Python 3 and Node.js standard libraries | Build scripts and tests | PSF / MIT |
| Google Fonts: Inter, JetBrains Mono, Noto Sans SC, Space Grotesk (`apps/web`); Barlow, Barlow Condensed, IBM Plex Mono (`apps/sim`) | UI type, loaded from fonts.googleapis.com | SIL OFL 1.1 |
| DeepSeek API (`deepseek-flash`, OpenAI-compatible) | **In use in the deployed demo**, server-side only in `apps/api`: it reads sign text (`/api/read`) and words the plan-comparison explanation (`/api/explain`), where any sentence with a number the engine did not produce is dropped (`sanitizeExplain`). Answers are cached in KV, the demo's sign readings are precomputed, and every call is counted against a daily ceiling of 50,000 in the Worker, with the prepaid DeepSeek balance (about ¥100) as the real spending limit; without a key, over the ceiling, once the balance runs out or on an error it falls back to rules, and the page labels which source was used (D-0929-2307, D-0929-1830). During development, two team members made a small number of test calls with their own keys and personal credit (see "Paid purchases" below; [`llm-apis/`](llm-apis/)) | DeepSeek API terms |
| Alibaba Cloud Model Studio (Bailian) | Evaluated (PR #28), then dropped (PR #37). Not used | — |
| Eclipse SUMO 1.27.1 + sumolib (PyPI `eclipse-sumo`, `sumolib`) | Micro-simulation backend (`apps/web/tools/sumo`, PR #96), **deployed** as a cloud service on 2026-09-30 (Cloudflare Container above, PR #112) at `/api/sumo/v1/*`. Results pre-computed with the same image are served as a labelled fallback (`apps/sumo/public/baked/`). The network is a **synthetic** 2×2 grid with assumed demand, not calibrated to Melbourne. The web page does not display SUMO results yet (no UI card) | EPL-2.0 OR GPL-2.0-or-later (dual licence) |

We found no CDN JavaScript libraries, stock images, audio or 3D assets under `apps/`, and the page loads no map tiles: a grep for tile, CDN and font URLs returns only the Google Fonts above, the OpenFreeMap attribution link in the page credits, and the tile template recorded as the source inside `vectormap.json` (the page never requests it; `apps/web/tests/test_web.py` checks that every fetch is same-origin). The map is drawn from our own JSON, including the vector basemap above, which was converted from tiles at build time.

**Paid purchases.** DeepSeek API credit and a Cloudflare plan. On 2026-09-30 the lead upgraded the team's Cloudflare account to **Workers Paid (US$5 a month)**, because Cloudflare Containers, which run SUMO, are not available on the free plan; container time is billed on top while the instance is awake (the `standard-2` instance is roughly US$0.05 an hour, about US$2–3 over the event; the exact amount will be taken from the Cloudflare invoice). The lead will delete the container and cancel the plan after judging. @jinmingq topped up ¥10 from a personal account for development test calls ([`llm-apis/jinmingq-deepseek.md`](llm-apis/jinmingq-deepseek.md)). @louisxie316-dotcom made test calls on credit in a personal DeepSeek account; the amount is not recorded in the repo ([`llm-apis/louisxie316-dotcom-deepseek.md`](llm-apis/louisxie316-dotcom-deepseek.md)). The team's own estimate for a full set of 10 demo sign texts is about ¥0.2 (PR #37). For the deployed demo, the lead set a DeepSeek key as a Cloudflare secret; precomputing the demo sign readings cost about ¥0.54 (estimate, ledger in [task-board.md](task-board.md)), and live calls run on that account's prepaid balance (about ¥100 on 2026-10-01; the Worker's daily ceiling is 50,000 calls, D-1001-0125). Members also used AI coding assistants on their own subscriptions (Claude Code, OpenAI Codex; see §2). No other paid services, data or assets were bought.

## 2. AI tools used

| Tool | How it was used | Evidence |
|---|---|---|
| **Claude Code** (Anthropic; Claude Opus 5.5 and Claude Fable 5.1 per commit trailers) | The main coding assistant for all five members. It wrote most of the code, tests, data-pipeline scripts, docs and HTML diagrams, working from specs the team wrote ([`specs/*-PRD.md`](specs/)). Humans set the direction and made every product decision ([`docs/decisions.md`](../decisions.md) quotes each one), reviewed the work and merged the PRs. The lead also ran parallel sub-agents for reviews | 59 commits on `main` carry a Claude `Co-Authored-By` trailer; 50 of the last 60 PR descriptions say "Generated with Claude Code" |
| **OpenAI Codex** | @jinmingq: the editable business-workflow SVG (PR #52). @unicornnnnnny: an early standalone "liquid glass" UI prototype, of which only the accent colour was reused ([`handoff/unicornnnnnny-T14-0929-1905.md`](handoff/unicornnnnnny-T14-0929-1905.md)) | PR #52 body; T14 handoff |
| Image or video generation models | **None found.** All diagrams are HTML or SVG written as code and rendered to PDF/PNG | grep of the repo for image-model names returns nothing |
| LLM inside the product | DeepSeek reads sign text and words plan explanations; every number still comes from the engine (see DeepSeek above) | live `/api/health` → `"mode":"llm"` |

## 3. What existed before the event (rule 3)

The event started on 2026-09-29 at 09:30 AEST. Before that, `main` had 9 commits, from 2026-09-26 01:29 to 2026-09-29 09:12 (`git log --before=2026-09-29T09:30:00+10:00`). All of it is **team-workflow tooling, with no product code, design, graphics or data**:

- **Process docs:**
  - `README`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `KICKOFF.md`
  - empty templates for `docs/1-brief`, `2-plan`, `3-tasks`, `4-demo`, `contract`, `decisions`, `pitfalls`, `deploy-cloudflare`, `onboarding`
  - `handoff/README.md`, `apps/README.md`, `hackathon.conf`, and a template MIT `LICENSE`
- **Guard scripts:**
  - `scripts/` (setup, check, sync, deploy, secret-scan; `new-app.sh` was already reduced to a one-message stub on 09-29 and removed on 09-30)
  - `.githooks/` (pre-commit, pre-push)
  - `.github/` (CI check, manual-only deploy workflow, CODEOWNERS, PR template)
- **AI assistant configuration:** `.claude/` (settings, 3 hooks, 6 slash commands, 2 agent definitions, launch.json).
- **Onboarding check:** one teammate's T0 test PR (#3, 09:12), which only touched the task board and a handoff note.

**Removed from the working tree on 09-30, still in git history.** On 2026-09-30 the team decided (D-0930-0200) to remove the collaboration-scaffold files that the project does not depend on: `KICKOFF.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `docs/onboarding.md`, `scripts/new-app.sh` and the whole `.claude/` directory. They were replaced by nothing: the three hard rules they carried now live in `README.md`, and the checks that enforced them (`scripts/check.sh`, `.githooks/`, CI) are unchanged.

This is a working-tree cleanup, **not** a rewrite of history. Every one of those files is still readable in commits dated 2026-09-26 to 09-29, and the repository is public, so nothing about the pre-event work is hidden. The disclosure above is the record; deleting the files was about the repository's shape, not about the record.

- **`starters/`:** two generic skeletons (a Cloudflare Worker + Durable Object room demo, and a Python CLI; 22 files). On 09-29 the team decided to remove them (D-0929-1311); they were removed from the repository in PR #65 on 2026-09-30. No product feature was built from them. Two **test-tooling** files in `apps/api` do come from the web-worker skeleton; they were copied in during the event (commit `fd6018c`, 2026-09-29 15:02):
  - `apps/api/tests/mini.mjs`, a 51-line assertion helper for the tests, is an unchanged copy of `starters/web-worker/tests/mini.mjs`;
  - `apps/api/test.sh`, the script that runs those tests, is a copy of `starters/web-worker/test.sh` with one line changed (86 of its 87 lines are identical; only the temp-directory name differs).

  Neither file is part of the deployed product. `apps/sim/bump.sh` (a 17-line cache-busting helper) was rewritten during the event from the same idea as the skeleton's version.

**Built during the event**, from the first product commit `cb7d3ee` at 2026-09-29 12:30 onward: everything under `apps/` (sim, roads, engine, api, web, site, params) apart from the two test-tooling files above, all data files, `docs/arch/`, `docs/pitch-assets/`, and the filled-in content of every doc.

## 4. Repository and secrets (rule 5)

Checked 2026-09-29 ~22:05:

| Check | Result |
|---|---|
| `bash scripts/secret-scan.sh --history`, all refs after `git fetch`, 176 commits | 0 hits |
| `.env`, `**/.dev.vars`, `raw/`, `.wrangler/`, `assets-src/` | Git-ignored. Only `*.example` files are tracked |
| `wrangler.jsonc` files | No `account_id`, no key. `DEMO_URL` shows the workers.dev subdomain, which is public anyway |
| GitHub Actions | Deploy is `workflow_dispatch` only. The Cloudflare token and account id live in GitHub Secrets, which forks cannot read |

---

## Team notes (originally in Chinese, for team members)

- This file is the "third-party list + pre-event preparation note" item of the submission (rules 5 and 6 in [challenge-brief.md](challenge-brief.md)). The English part states only facts that already hold; every to-do is in this section.
- The lead made the repository **PUBLIC** at 09-30 01:30 (after running `secret-scan.sh --history` over the whole history).

**To be decided**

- Whether to include the live link + QR code: the URL's subdomain contains a member's handle (`zemmmeng`), which may conflict with "team name only" ([demo-script.md](demo-script.md), decision 2). `README.md` currently has the demo link at the top.

**Decided (09-30)**

- The personal email addresses in the commit history (6 of them) and the real names in the docs → **made public with the repository; history is not rewritten** (D-0930-0133, agreed by the whole team).
- The two test helpers in `apps/api` come from the pre-event template → **disclosed as they are; no change of story**. Section 3 states it truthfully, the "Disclosure and licence" section of `README.md` says the same, and the alternative of "rewriting those two files" is no longer mentioned.
- `docs/event/canvas-export.md` (a verbatim copy of the Canvas course pages, including the original challenge texts of the four sponsors) → **deleted**. The key points of the challenge are in `docs/1-brief.md` (now [challenge-brief.md](challenge-brief.md)), which does not depend on that copy.
- The pre-event collaboration scaffold (`KICKOFF.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `docs/onboarding.md`, `.claude/`, `scripts/new-app.sh`) → **removed from the working tree** (D-0930-0200). The three hard rules moved to `README.md`; the checks in `scripts/check.sh` / `.githooks/` / CI are unchanged. The history is kept, as section 3 states.

**To-do**

1. Done: delete `starters/`: PR #65 (09-30 01:25); section 3 is now in the past tense.
2. Done: team name in LICENSE: **Team Uncapped**.
3. Done: data credits on the web page: `apps/web/src/js/5-app.js` now lists them in full under ODbL / CC BY 4.0 (OSM, DataVic SCATS, PTV GTFS, City of Melbourne).
4. Add a line to `apps/roads/README.md`: the OSM-derived files (`network.json`, `walk.json`, `buildings.json`) are ODbL 1.0 share-alike, not MIT (the "Disclosure and licence" section of the root `README.md` already says so).
5. Ask @jinmingq and @louisxie316-dotcom how much each of them topped up and spent on DeepSeek in total. @jinmingq's card says a self-funded top-up of ¥10; @louisxie316-dotcom's card says "didn't check the balance". If the answers differ, correct the "Paid purchases" paragraph in section 1.
6. Ask @Unzzip which tools they used for the T12 (`apps/params`) literature search (AI search counts too) and add them to section 2.
7. The pedestrian-count dataset page states no licence; check once more before submission and then update that cell in section 1.
8. Done: Cloudflare plan: on 09-30 the lead upgraded to Workers Paid (US$5/month) to run the SUMO container; this is recorded in section 1 (software table, Paid purchases). **After the finals**: follow steps 1 and 2 of the shutdown section of `apps/sumo/README.md`: first remove site's `SUMO` binding (relaxing the tests at the same time) and deploy site, then delete the `hackathon-sumo` Worker, the container and the image, and finally cancel Workers Paid in the dashboard and add the actual container cost from the invoice.
9. Done: the LLM is switched on (live `/api/health` → `mode: llm`): the DeepSeek row in section 1 now says "in use in the demo", and the cost is in "Paid purchases" (09-30).
10. The team name on the three pre-screen PDF pages and items 1–4 of "For the whole team to decide (before submission)" in `docs/4-demo.md` (now [demo-script.md](demo-script.md)) are still for the whole team to decide.
11. Whose account the live DeepSeek key belongs to and how much was topped up in total: ask the lead and add it to "Paid purchases" in section 1 (it currently gives only the precomputed readings, about ¥0.54, and the balance of about ¥100 on 10-01; the daily ceiling has been raised to 50000, D-1001-0125).

**Steps to make the repository public (done by the lead; this PR does not change any repository settings)**

1. Merge the open work, then merge the fixes for items 1–4 above.
2. Run `git fetch origin && bash scripts/secret-scan.sh --history` again; it must report zero hits. If anything is found, **rotate the key first**, then deal with the repository.
3. Full `bash scripts/check.sh` run: 0 ❌.
4. Repository settings: leave the secrets alone, keep the deploy workflow manual-only, protect `main`.
5. `gh repo edit Zemmeng/hackathon --visibility public --accept-visibility-change-consequences`.
6. Open the repository in a logged-out browser window to confirm it is visible, then paste the link into the Canvas submission.
7. **Do not make it private again or delete it before judging ends** (rule 5).
