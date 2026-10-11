# Handoff notes

*Archived from the hackathon (29 Sep – 1 Oct 2026). The notes in this folder are translated from the original Chinese; superseded details are kept as they were.*

During the event, five people and many AI-assisted coding sessions worked on this repository at the same time. Handoff notes were how state passed between them: whenever a person or a session stopped, it wrote down what it had done, where it stopped, what it needed changed but could not change itself, and the first command the next person should run. The rule behind it: **anything that exists only in a chat transcript might as well not exist.**

The notes are kept as a record of how the work was coordinated. They are historical: numbers, plans and file names reflect the moment each note was written, and many were superseded later. For the current design, see [`docs/architecture/`](../../architecture/README.md) and [`docs/decisions.md`](../../decisions.md).

## The convention

**When to write one.** Before sleeping, when handing over to another person, when switching sessions, when an AI session's context window is nearly full, when leaving for more than an hour, when a task is done, and before every integration point. Only the lead could edit the shared files (the interface contract, task board, plan, decision log and similar), so a note was also everyone else's only way to ask for a change to them.

**File name.** `<handle>-T<n>-<MMDD-HHMM>.md`, all ASCII, for example `Zemmeng-T9-0929-1610.md`. The task number was mandatory so that `ls handoff/*T3*` would list a task's whole history. A new file every time, never an edit to an old one, so several people could write notes at once without conflicts.

**Four fixed sections.** Step [8] of `scripts/check.sh` warned about any note that was missing one of them.

| Section | What goes in it |
|---|---|
| `## 1. Facts` | What was done; where it stopped (with a time); branch / PR; verification (the `check.sh --quick` summary line, test counts); what has not been verified; money spent |
| `## 2. Shared files to change` | A table of file · section or line · change, for files the author had no permission to edit; the lead applied them |
| `## 3. For the lead` | Decisions needed, risks, help needed from others, other things noticed along the way |
| `## 4. Next steps` | The first command the next person should run; the dev server name from `.claude/launch.json` |

**Lifecycle.** A note travelled with its branch into the PR, and whoever picked the work up ran `gh pr checkout <n>` and read the note first. Once the lead had processed it (section 2 changes made, section 3 decisions recorded in the decision log), the note was moved into [`done/`](done/README.md) with `git mv`, never deleted. The goal was that after each integration round only this README would be left at the top level, and `check.sh` [8] warned about any note left unprocessed for more than 12 hours. In practice only 7 notes were moved to `done/`; the other 28 were still at the top level when the event ended.

**Never written in a note.** Keys, tokens, passwords, account details, email addresses, student numbers, organiser-internal material, or long pasted chat transcripts.

The template, as used during the event (translated):

```markdown
# T<n> <task name>: handoff

## 1. Facts
- What was done:
- Where it stopped (with time):
- Branch / PR:
- Verification: `bash scripts/check.sh --quick` → `======== Summary 0 ❌ 1 ⚠️`
- Not yet verified:
- Money spent this session: 0

## 2. Shared files to change (I don't have permission; the lead applies them)
| File | Section / line | Change to |
|---|---|---|
| | | |

## 3. For the lead
- Decisions needed:
- Risks:
- Help needed from others:
- Other things noticed along the way:

## 4. Next steps
- First command for the next person:
- Dev server name (launch.json):
```

## Reading the notes

- During the event this folder was `handoff/` at the repository root; it now lives at `docs/hackathon/handoff/`. References to `handoff/…` inside the notes mean this folder.
- File paths inside the notes point to where those files live now (for example `docs/contract.md` → `docs/reference/interfaces.md`, `docs/arch/*` → `docs/hackathon/specs/*`, `docs/3-tasks.md` → `docs/hackathon/task-board.md`). Files that were removed after the event keep their old paths; they are still in git history and in the `hackathon-final` tag.
- Many notes were written by AI-assisted sessions working for a team member. "The user" means the person driving that session, and "the lead" is @Zemmeng. "Control session" and "engine session" are names for the lead's parallel sessions; "opus agents", "subagents" and "Workflow" refer to the AI agents those sessions ran for implementation and adversarial review.
- `T<n>` numbers are rows on the [task board](../task-board.md); `D-MMDD-HHMM` IDs are entries in [`docs/decisions.md`](../../decisions.md); `#n` are GitHub pull requests or issues.
- Local machine paths and a claude.ai link have been redacted, and teammates' nicknames have been replaced by their GitHub handles.
- The `.claude/agent-out/…` files mentioned in some notes were local review outputs and were never committed.

## Index

All 35 notes in time order (AEST).

| When (AEST) | Note | Author | Task | Topic |
|---|---|---|---|---|
| 27 Sep 14:48 | [done/louisxie316-dotcom-T0-0927-1448](done/louisxie316-dotcom-T0-0927-1448.md) | @louisxie316-dotcom | T0 | Pre-event onboarding warm-up (GitHub CLI, hooks, `.env`); two `$var` boundary bugs in the scripts |
| 29 Sep 13:15 | [Zemmeng-T6-0929-1315](Zemmeng-T6-0929-1315.md) | @Zemmeng | T6 | Kickoff: Challenge 5 chosen, architecture settled, `apps/sim` demo merged, road-data PRD and first docs |
| 29 Sep 14:19 | [louisxie316-dotcom-T3-0929-1419](louisxie316-dotcom-T3-0929-1419.md) | @louisxie316-dotcom | T3 | Road data phase 2: equipment inventory and tram/bus routes; pedestrian files blocked by the 1 MB size limit |
| 29 Sep 14:25 | [done/Zemmeng-T7-0929-1425](done/Zemmeng-T7-0929-1425.md) | @Zemmeng | T7 | First engine + api skeleton (all mock, on a small grid network), contract v2 |
| 29 Sep 14:40 | [unicornnnnnny-T2-0929-1440](unicornnnnnny-T2-0929-1440.md) | @unicornnnnnny | T2 | First web panel: self-drawn GIS map, extreme-weather layers, four-step flow with preset numbers |
| 29 Sep 15:00 | [done/Zemmeng-T9-0929-1500](done/Zemmeng-T9-0929-1500.md) | @Zemmeng | T7 (filed as T9) | The skeleton after a 47-finding adversarial review |
| 29 Sep 15:00 | [jinmingq-T5-0929-1500](jinmingq-T5-0929-1500.md) | @jinmingq | T5 | New `apps/api`: `readSigns()` fallback chain, keyword rules, sign validation, `/api/read` |
| 29 Sep 15:06 | [jinmingq-T5-0929-1506](jinmingq-T5-0929-1506.md) | @jinmingq | T5 | Worker tested in workerd, `checkSigns()` for the UI, demo sign list |
| 29 Sep 15:15 | [done/Zemmeng-T9-0929-1515](done/Zemmeng-T9-0929-1515.md) | @Zemmeng | T9 | Engine reworked per D-0929-1435: sign readings + persona parameters → route choice on the real network |
| 29 Sep 15:23 | [jinmingq-T5-0929-1523](jinmingq-T5-0929-1523.md) | @jinmingq | T5 | Sign reader accepts the engine's requests (arrow boards, `read_s` cap, road-name characters) |
| 29 Sep 15:25 | [done/Zemmeng-T9-0929-1525](done/Zemmeng-T9-0929-1525.md) | @Zemmeng | T9 | Parameter loader `loadParams()` / `applyParams()` with validation and fallback |
| 29 Sep 15:30 | [done/Zemmeng-T10-0929-1530](done/Zemmeng-T10-0929-1530.md) | @Zemmeng | T10 | Same-origin site Worker `apps/site`; the build copies only git-tracked files |
| 29 Sep 15:40 | [Unzzip-T12-0929-1540](Unzzip-T12-0929-1540.md) | @Unzzip | T12 | `apps/params`: literature-sourced parameters, explicit nulls where there is no evidence |
| 29 Sep 15:48 | [Zemmeng-T6-0929-1548](Zemmeng-T6-0929-1548.md) | @Zemmeng | T6 | Integration session 13:54–15:48: 14 PRs merged, LLM API card folder, 2 MB JSON limit, macOS bash fix |
| 29 Sep 15:50 | [Unzzip-T12-0929-1550](Unzzip-T12-0929-1550.md) | @Unzzip | T12 | Parameter field names aligned with the engine; `mix` documented as an assumption |
| 29 Sep 15:50 | [done/Zemmeng-T9-0929-1550](done/Zemmeng-T9-0929-1550.md) | @Zemmeng | T9 | Detours avoid laneways, parameter review fixes, contract v3.1, `backend.js` wiring layer |
| 29 Sep 16:10 | [Zemmeng-T9-0929-1610](Zemmeng-T9-0929-1610.md) | @Zemmeng | T9 / T10 | End of shift: engine, wiring layer and site shell all merged |
| 29 Sep 17:12 | [Zemmeng-T13-0929-1712](Zemmeng-T13-0929-1712.md) | @Zemmeng | T13 | Web steps 1, 3 and 4 show engine-computed numbers (`6-engine.js`) |
| 29 Sep 18:45 | [Zemmeng-T19-0929-1845](Zemmeng-T19-0929-1845.md) | @Zemmeng | T16–T19 | Real buildings, tram/bus and pedestrian impacts, LLM-ready api Worker |
| 29 Sep 19:05 | [unicornnnnnny-T14-0929-1905](unicornnnnnny-T14-0929-1905.md) | @unicornnnnnny | T14 | Liquid-glass UI: floating glass panels, refraction on two panels, compact panel mode |
| 29 Sep 20:18 | [jinmingq-T15-0929-2018](jinmingq-T15-0929-2018.md) | @jinmingq | T15 | Editable business-workflow SVG for the pitch |
| 29 Sep 20:30 | [jinmingq-T5-0929-2030](jinmingq-T5-0929-2030.md) | @jinmingq | T5 | Worksite register `/api/worksites` (Durable Object, edit tokens, seeded demo worksites) |
| 29 Sep 21:05 | [jinmingq-T5-0929-2105](jinmingq-T5-0929-2105.md) | @jinmingq | T5 | Rule-based `/api/explain` with a guard that drops numbers not traceable to the engine |
| 29 Sep 21:25 | [jinmingq-T5-0929-2125](jinmingq-T5-0929-2125.md) | @jinmingq | T5 | `pack.js`: equipment hire quote, shared-stock check, execution pack |
| 29 Sep 22:01 | [unicornnnnnny-T20-0929-2201](unicornnnnnny-T20-0929-2201.md) | @unicornnnnnny | T20 | Hard-coded numbers removed from the page, weather labelled illustrative, five review points fixed |
| 29 Sep 22:15 | [jinmingq-T23-0929-2215](jinmingq-T23-0929-2215.md) | @jinmingq | T23 | Step 4: compare three plans side by side, select one, one-page export |
| 29 Sep 22:55 | [jinmingq-T23-0929-2255](jinmingq-T23-0929-2255.md) | @jinmingq | T5 / T23 | Evening wrap-up: worksite register, explain, execution pack and plan comparison all live |
| 29 Sep 22:55 | [Zemmeng-T6-0929-2255](Zemmeng-T6-0929-2255.md) | @Zemmeng | T6 | Product architecture diagram for the pre-screen, after three rounds of simplification |
| 30 Sep 01:17 | [Zemmeng-T6-0930-0117](Zemmeng-T6-0930-0117.md) | @Zemmeng | T6 | T20 checked by 22 review agents; full-CBD map assessed; T26–T28 assigned |
| 30 Sep 02:02 | [unicornnnnnny-T27-0930-0202](unicornnnnnny-T27-0930-0202.md) | @unicornnnnnny | T27 | Whole CBD on the map (pre-rendered city layer), plus T28 `extra_min` and T26 fixes |
| 30 Sep 10:28 | [louisxie316-dotcom-T31-0930-1028](louisxie316-dotcom-T31-0930-1028.md) | @louisxie316-dotcom | T31 | Real-weather back-test, phase 1: Open-Meteo weather against measured traffic and pedestrian counts |
| 30 Sep 10:58 | [jinmingq-T34-0930-1058](jinmingq-T34-0930-1058.md) | @jinmingq | T34 | Native SUMO backend for a synthetic 2×2 grid (local tool, not wired into the page) |
| 30 Sep 16:09 | [Zemmeng-T33-0930-1609](Zemmeng-T33-0930-1609.md) | @Zemmeng | T33 | Step 2 2×2 junction microsimulation (`GridSim`), #85 review, SUMO backend merged as T34 |
| 30 Sep 16:10 | [Zemmeng-T6-0930-1610](Zemmeng-T6-0930-1610.md) | @Zemmeng | T6 | README judges' section and submission materials; references checked; stale finals Q&A flagged |
| 30 Sep 17:23 | [Unzzip-T35-0930-1723](Unzzip-T35-0930-1723.md) | @Unzzip | T35 | OSM vector basemap fetched at build time from OpenFreeMap |
