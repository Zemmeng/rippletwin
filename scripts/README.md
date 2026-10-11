# scripts

Shell tooling for the repository: one quality gate (`check.sh`) shared by the git hooks and CI, a secret scanner, onboarding and deployment. Run each script from the repository root as `bash scripts/<name>` (any directory inside the repository also works, because the root is found from the current repository). `--help` prints a script's header comment. For the contribution workflow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Overview

| Script | What it does | Run by | When |
|---|---|---|---|
| `setup.sh` | Checks the tools (git, gh, node ≥ 20, python3 ≥ 3.9; wrangler and uv optional), enables `.githooks`, copies `.env.example` to `.env` (never overwrites), creates the local `logs/`, `out/` and `scratch/` directories, sets `git config hack.me` to your GitHub handle, then runs `check.sh --quick` and prints its summary | Every contributor | Once after cloning; again on a new machine or after pulling new hooks (idempotent) |
| `check.sh` | **The single check / test entry point**: nine numbered checks `[1]`–`[9]`, always ending with the `======== Summary X ❌ Y ⚠️` block; writes `logs/last-check.txt`; exits 1 on any ❌ | Everyone; called by pre-push, CI and `deploy.sh` | After each small step; before committing or pushing |
| `secret-scan.sh` | Scans for keys, tokens and private keys; prints only `file:line:pattern`, never the value | Called by pre-commit and check `[1]`; run `--history` by hand | Every commit (automatic); before making a repository public (`--history`) |
| `deploy.sh` | Preflight checks (you are the `DEPLOYER`, or the `BACKUP_LEAD` for a backup deploy; clean worktree; HEAD on `main` or a tag and in sync with origin; after the code freeze only a `demo-*` tag unless `--hotfix`; full `check.sh` with no ❌), then deploys module by module, runs `check.sh --e2e` and appends to `logs/deploy.log`; prints a rollback command on failure | The `DEPLOYER` in `hackathon.conf`; automated agents must ask a human first | Deliberate deploys only |
| `.githooks/pre-commit` | `secret-scan.sh --staged`; blocks staged secret files (`.env*`, `.dev.vars*`, `settings.local.json`, `keys.json`, `credentials*.json`, `*.pem`, `*.key`; `*.example` is allowed); blocks files over 1 MB (2 MB for `apps/*/public/*.json`, 10 MB for `docs/hackathon/pitch/*.pdf`) | git, once `setup.sh` has enabled the hooks | Every `git commit` |
| `.githooks/pre-push` | Refuses pushes to `main` unless `ALLOW_MAIN=1`; refuses to push a ref that is not the current HEAD; runs `check.sh --quick` (70 s per test, 90 s overall) and refuses on any ❌ or a missing summary line | git | Every `git push` |
| CI (`.github/workflows/check.yml`) | Runs the full `check.sh --base origin/main` and then `check.sh --selftest` on pull requests and on pushes to `main`; sets `ALLOW_CROSS=1` when the PR has the `cross-module` label; writes the summary block to the job summary on failure | GitHub Actions | Opening, updating or labelling a PR; merging to `main` |

The hackathon ended on 1 October 2026, so `check.sh --time` now reports the phase `deadline passed`, and `deploy.sh` needs either a `demo-*` tag pushed to origin or `--hotfix`.

## Options

| Command | Option | Meaning |
|---|---|---|
| `bash scripts/check.sh` | (none) | Full run: scans every file and runs every `apps/*/test.sh` |
| | `--quick` | The secret scan and the tests cover only files / modules changed since the base (everything if there is no base) |
| | `--base <ref>` | Diff base; defaults to `origin/main`, then `main`. If neither exists (no commits yet, no remote), diff-based checks are skipped with a ⚠️ |
| | `--e2e [URL]` | Live smoke test only: `GET /` returns 200 and contains `data-smoke`; `/api/health` contains `"ok":true`; the HTML does not reference `localhost`; each request within 3 s. **Without a URL it reads `DEMO_URL` from `hackathon.conf`** (❌ if empty). Results go to `logs/last-e2e.txt` |
| | `--selftest` | Builds 16 scenarios in throwaway repositories and confirms that each check turns red or green as expected (see [Self-test](#self-test)) |
| | `--time` / `--time-raw` | Prints only the current time, the time to the deadline and the phase; `--time-raw` prints `KEY=VALUE` lines (`PHASE=`) for scripts |
| `bash scripts/secret-scan.sh` | `--all` (default) | All tracked files plus untracked files that are not ignored |
| | `--staged` | Only the staged content about to be committed (used by pre-commit) |
| | `--files <path>…` | Only the given files (used by `check.sh --quick`) |
| | `--history` | Every line ever added in git history; prints `commit:file:pattern` |
| `bash scripts/deploy.sh` | `<module>` / `all` | `all` means `DEPLOY_MODULES` in `hackathon.conf` |
| | `--hotfix` | Allows a deploy that is not from a `demo-*` tag during the code freeze or after the deadline (urgent fixes; tag it and record a decision afterwards) |
| | `BACKUP_LEAD` | When `hack.me` equals `BACKUP_LEAD` in the conf, the deploy is also allowed, with a ⚠️, and is marked "backup deploy" in `deploy.log` |

## The nine checks in check.sh

| # | Check | ❌ | ⚠️ |
|---|---|---|---|
| [1] | Secret scan (`--quick` scans only changed files) | Any pattern matches | — |
| [2] | Secret files tracked | `.env*`, `.dev.vars*`, `settings.local.json`, `keys.json`, `credentials*.json`, `*.pem` or `*.key` is tracked by git (`*.example` is allowed) | — |
| [3] | Branch & module boundary (the branch name `<handle>/<module>/T<n>-<slug>` determines the module; a `lead/*` branch may change the whole repository) | Changes on `main`; a non-conforming branch name with changes; files outside `apps/<module>/`; deleted lines in `docs/decisions.md` or `docs/pitfalls.md` (append-only) | No commits or no base yet; detached HEAD without `BRANCH`; a `lead/*` branch used by someone other than `LEAD` / `BACKUP_LEAD`; anything let through by `ALLOW_MAIN=1` or `ALLOW_CROSS=1` |
| [4] | Module structure | An `apps/*` directory without `README.md`, an `Owner:` line, or an executable `test.sh` | `Owner:` is still a placeholder |
| [5] | Module tests (each `test.sh` runs in its own process group with `MOCK=1` and a `CHECK_TEST_TIMEOUT` limit, default 120 s) | Non-zero exit code; the last line is not `N passed, M failed`; failures reported with exit code 0; timeout | No `test.sh` at all; a `test.sh` left background processes behind (they are killed) |
| [6] | Repo hygiene | A tracked file over 1 MB (`.json` data files under `apps/<module>/public/`: 2 MB; `.pdf` files under `docs/hackathon/pitch/`: 10 MB) | A tracked file over 500 KB (data JSON and pitch PDFs excepted); an untracked file over its limit; a `*.sh` file or hook without the executable bit or with CRLF line endings; `$var` directly followed by a non-ASCII character in a shell file (crashes macOS bash under `set -u`; write `${var}`) |
| [7] | RULES block | `README.md` does not contain exactly one `<!-- RULES:BEGIN -->` / `<!-- RULES:END -->` pair | `README.md` does not exist |
| [8] | Handoff notes (only the top-level `handoff/` directory; the check passes when it does not exist, and the hackathon's notes are archived in `docs/hackathon/handoff/`) | — | File name is not `<handle>-T<n>-<MMDD-HHMM>.md`; a missing section (`## 1. Facts`, `## 2. Shared files to change`, `## 3. For the lead`, `## 4. Next steps`); a note pending for more than 12 hours |
| [9] | hackathon.conf | Missing file; a line that is not `KEY=VALUE`; invalid `TZ`; a badly formatted time; `START` not before `DEADLINE` | Duplicate or missing keys; empty `DEADLINE`, `LEAD` or `DEPLOYER`; `DEMO_URL` not found in `README.md`; a `DEPLOY_MODULES` entry with no `apps/` directory |

The summary block is one `======== Summary X ❌ Y ⚠️` line followed by a copy of every ❌ / ⚠️ line. pre-push, CI and `deploy.sh` read only this block, and **a missing summary line always counts as a failure** (a crash must never pass as green). pre-push extracts the ❌ count with `sed -nE 's/^======== Summary ([0-9]+) ❌.*/\1/p'`, so keep the `<marker> N ❌ M ⚠️` shape if you ever change the line.

### Self-test

`bash scripts/check.sh --selftest` builds 16 throwaway repositories under `$TMPDIR` and runs `check.sh --quick` in each. The scenarios are: an all-green baseline; changes on `main`; a fake AWS key; a cross-module change; a crashing test; a missing count line; a non-conforming branch name; missing RULES markers; a deleted line in the append-only `docs/decisions.md`; two files with five and four kinds of fake keys (the values must never appear in the output or the log); placeholder-only `Bearer` headers (no false positive); the 2 MB data-file limit; the 1 MB general limit; the 10 MB pitch-PDF limit; and the warning for `$var` followed by a full-width character. CI runs it on every pull request; run it locally after any change to `check.sh` or `secret-scan.sh`.

## hackathon.conf

`hackathon.conf` holds the event metadata as `KEY=VALUE` lines (comments and surrounding quotes are stripped). It is read by `check.sh`, `deploy.sh` and `.github/workflows/deploy.yml`, and two module tests (`apps/site` and `apps/sumo`) read `DEPLOY_MODULES`, so keep the file.

| Keys | Used for |
|---|---|
| `TZ`, `START`, `DEADLINE`, `FEATURE_FREEZE_HOURS`, `CODE_FREEZE_HOURS` | Countdown and phase (`--time`, check `[8]` note ages, check `[9]`) |
| `LEAD`, `BACKUP_LEAD`, `DEPLOYER` | Identity on `lead/*` branches (check `[3]`, warning only) and the `deploy.sh` identity gate |
| `DEMO_URL` | Default `--e2e` target; must appear in `README.md` (check `[9]`) |
| `DEPLOY_MODULES` | `deploy.sh all`; each entry must exist under `apps/` |
| `EVENT_NAME`, `EVENT_URL`, `VIDEO_URL` | Metadata only (check `[9]` warns if a key is missing) |

`check.sh --time-raw` prints the phase as `PHASE=<value>`, one of `not set`, `pre-event`, `development`, `🧊 feature freeze`, `🔒 code freeze` or `deadline passed`. `deploy.sh` and `deploy.yml` treat values matching `*code freeze*` or `*deadline passed*` as frozen, so change all three together.

## Principles

- **Idempotent**: running a script twice does no harm (`setup.sh` never overwrites `.env`).
- **Progress output**: `[i/N]` or `[N] Name ✅/❌/⚠️`, one line per step for long tasks.
- **Print the fix on failure**: after a ❌ comes the reason and the next command to type, not just "failed".
- **Header comment with purpose, usage and exit codes**: `--help` prints it.
- Compatible with macOS's bundled bash 3.2 and Ubuntu (CI), and with Python 3.9 (CI pins 3.9). All times are computed with python3 `zoneinfo` in the `TZ` from `hackathon.conf` (Melbourne's daylight saving starts on the first Sunday in October, which was 4 October in 2026, just after the event, so no offsets are hard-coded).
- Scripts never commit or push on their own, and never read or print key values.

## Environment variables

| Variable | Effect | When to use it |
|---|---|---|
| `ALLOW_MAIN=1` | pre-push allows a push to `main`; check `[3]` downgrades "changes on main" to ⚠️ | Small changes by the lead: `ALLOW_MAIN=1 git push` (give the reason in the commit message) |
| `ALLOW_CROSS=1` | check `[3]` downgrades cross-module files and non-conforming branch names to ⚠️ | Set automatically by CI when the PR has the `cross-module` label; for an agreed cross-module change, run `ALLOW_CROSS=1 git push` and add the label to the PR |
| `CHECK_TEST_TIMEOUT=<seconds>` | Time limit per `test.sh`, default 120; pre-push passes 70 | Genuinely slow test suites (consider splitting them first) |
| `BRANCH=<name>` / `GITHUB_ACTOR` | The branch name `check.sh` uses, and the identity checked on `lead/*` branches (locally `git config hack.me`) | Set by CI (a PR checkout is a detached merge commit) |
| `MOCK` | Passed to every `test.sh`; `check.sh` sets `MOCK=1` (mock mode: no paid LLM calls) unless it is already set | Leave it unset |
