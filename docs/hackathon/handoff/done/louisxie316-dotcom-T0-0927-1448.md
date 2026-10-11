# T0 onboarding warm-up: handoff

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

## 1. Facts
- What was done: logged in to the GitHub CLI, verified repository access, cloned, enabled the hooks, initialised the local `.env` and configured identity.
- Where it stopped (09-27 14:48): T0 branch created; about to run the local check, commit and open a PR.
- Branch / PR: `louisxie316-dotcom/hello/T0-hello` · PR not yet created
- Verification: `LC_ALL=C bash scripts/check.sh --quick` → `======== Summary 0 ❌ 1 ⚠️`
- Not yet verified: remote CI, the PR flow
- Money spent this session: 0

## 2. Shared files to change (I don't have permission; the lead applies them)
| File | Section / line | Change to |
|---|---|---|
| `scripts/setup.sh` | identity prompt, line 100 | Change `$LOGIN（` to `${LOGIN}（`, so that under a UTF-8 locale the full-width bracket is not parsed into the variable name |
| `scripts/check.sh` | module prompt, line 830 | Add brace boundaries to variables that are followed by Chinese punctuation; for now `LC_ALL=C` is needed as a workaround |

## 3. For the lead
- Decisions needed: none.
- Risks: `hackathon.conf` does not set `DEADLINE` yet, so the check keeps 1 warning.
- Help needed from others: the lead to fix the variable-boundary problem in `scripts/setup.sh`.
- Other things noticed along the way: none.

## 4. Next steps
- First command for the next person: `bash scripts/check.sh --quick`
- Dev server name (launch.json): not applicable
