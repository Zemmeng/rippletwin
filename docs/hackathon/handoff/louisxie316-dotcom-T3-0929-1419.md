# T3 phase 2: pedestrians, public transport, equipment inventory — handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done: built the three P0 items in @jinmingq's `PRD-2.md` (issue #11)
  - A `equipment.json` ✅ committed: 16 equipment types (3 barriers, 9 static signs, 2 VMS, arrow board, temporary pedestrian signal); `qty` and `day_rate_aud` are assumptions
  - B `transit.json` ✅ committed: 22 tram and 25 bus routes, 182 stops; 90.6% of route alignments match the road network; 98% of the links used by tram routes are marked tram in `network.json`
  - C `walk.json` + `peds.json` 🔨 generated and all tests pass, but at 1.7 MB and 1.8 MB they **exceed the pre-commit 1 MB limit and are not committed** (see section 2)
- Where it stopped (09-29 14:19): waiting for the lead to raise the size limit; the files are here locally and can be regenerated with one command
- Branch / PR: `louisxie316-dotcom/roads/T3-phase2` (branched from the T3 branch, includes the commits of PR #9), not pushed, no PR yet
- Verification: `bash apps/roads/test.sh` → `41 passed, 0 failed`; `bash scripts/check.sh --quick` → `======== Summary 0 ❌ 1 ⚠️` (the ⚠️ is these two untracked large files)
- Not yet verified: T4 / T2 have not read these files yet; the footpath side (left / right) is computed from geometry only, with no manual spot checks
- Cost this session: 0

## 2. Shared files to change
| File | Section / line | Change to |
|---|---|---|
| `.githooks/pre-commit` | [3] large files, `MAX_BYTES=1048576` | raise to 2 MB for `apps/*/public/**/*.json` (consistent with "each file < 2 MB" in `PRD.md` §7 and `PRD-2.md` §6); other files stay at 1 MB |
| `scripts/check.sh` | [6] hygiene, tracked files with `sz > MB` report ❌ | as above: `apps/*/public/**/*.json` reports ❌ only at 2 MB (500 KB–2 MB can still report ⚠️) |

## 3. For the lead
- Decisions needed:
  - A task number for T3 phase 2 (for now the branch name borrows T3, `louisxie316-dotcom/roads/T3-phase2`; rename it with `git branch -m` once a number is assigned)
  - `PRD-2.md` is on @jinmingq's branch `jinmingq/roads/T3-phase2-prd`; should it be merged into main? The new file formats are a draft; once final, they go into `docs/contract.md` (now [`docs/reference/interfaces.md`](../../reference/interfaces.md))
  - If the size limit is not raised, the alternative is: peds.json becomes "a table of 77 curves + a reference from each link" (about 300 KB), and walk.json drops the geometry of straight links and null fields and shortens ids — which would differ from the PRD-2 draft format
- Risks: this branch depends on PR #9 (network.json); merge PR #9 first, then merge main into this branch
- Needs from others: before T2 / T4 read `equipment.json` and `transit.json`, take a look at the phase 2 part of `apps/roads/README.md`
- Other things noticed along the way: the user asked about putting the LLM key on GitHub; refused under hard rule 3 and D-0929-1310, and suggested the route "the lead picks the provider → the deployer sets a Cloudflare secret"

## 4. Next steps
- First command for the next person: `apps/roads/.venv/bin/python apps/roads/tools/build_walk.py && bash apps/roads/test.sh` (once the limit is raised, then `git add apps/roads/public/cbd/walk.json apps/roads/public/cbd/peds.json`)
- Dev server name (launch.json): none (static data files)
