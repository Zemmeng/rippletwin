# Security policy

## Scope and support

RippleTwin is a hackathon project (FEIT Hackathon Festival 2026). It is maintained by [@Zemmeng](https://github.com/Zemmeng) on a best-effort basis, with no fixed response times. Security fixes are made on `main` only, and the live demo at <https://hackathon-site.zemmmeng.workers.dev> is redeployed from `main` when needed.

In scope:

- the code in this repository, in particular the Cloudflare Workers in `apps/site` and `apps/api`;
- the live demo (`hackathon-site` and the `hackathon-api` Worker behind it);
- the repository tooling: `scripts/`, `.githooks/` and `.github/workflows/`.

## How secrets are handled

- Secrets live only in local, gitignored files (`.env`, `apps/<module>/.dev.vars`) and in Cloudflare Worker secrets (`npx wrangler secret put <NAME>`). They are never written into source, config or docs. `.env.example` and `apps/api/.dev.vars.example` list variable names only.
- `scripts/secret-scan.sh` checks for about 20 key and token formats (cloud providers, LLM providers, GitHub, Slack, PEM keys, JWTs, bearer tokens and generic `key=` / `token=` / `password=` assignments). It prints only `path:line:pattern`, never the matched value.
- The scanner runs at every stage of the [quality gate](CONTRIBUTING.md#quality-gate): on staged changes in the `pre-commit` hook, which also blocks secret files such as `.env`, `.dev.vars`, `*.pem` and `*.key`; and as checks [1] and [2] of `scripts/check.sh` in the `pre-push` hook and in CI on every pull request and push to `main`.
- A scan of the full git history (`bash scripts/secret-scan.sh --history`) reported **zero findings** on 2026-10-11.
- The site build (`apps/site/build.mjs`) copies only git-tracked files from each module's `public/` directory, so gitignored files on a developer's machine can never be deployed.

### The LLM key

- The LLM API key is a secret of the API Worker only (`LLM_API_KEY` on `hackathon-api`). The browser never receives it: the page calls `/api/read` and `/api/explain` on its own origin, and the `site` Worker forwards them through a Cloudflare service binding.
- `hackathon-api` has no public `workers.dev` route; it is reachable only through `site`.
- Spending is bounded by a KV cache of readings, a Durable Object budget (50,000 calls per day and 600 per minute as deployed) and a keyword-rule fallback when the budget is exhausted or the provider fails. `/api/health` reports whether a key is present, never its value.
- The hosted key was removed after the event. The live API now reads signs with keyword rules and the pre-computed readings that ship in `apps/api/public/answers/demo.json`.

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion for a vulnerability.

- Preferred: GitHub private vulnerability reporting. On the repository's **Security** tab, choose **Report a vulnerability** (<https://github.com/Zemmeng/rippletwin/security/advisories/new>).
- If that option is not available, contact the maintainer [@Zemmeng](https://github.com/Zemmeng) through GitHub: open an issue that asks for a private channel, without any details of the vulnerability.

There is no email contact. Include what is affected (file, endpoint or URL), steps to reproduce, and the impact you expect. If you find a credential, tell us where it is but do not use it.

## Out of scope

- The SUMO Worker and Cloudflare Container (`hackathon-sumo`), which were deleted after the event. `/api/sumo/*` on the live site returns `502 sumo_down` by design.
- Denial-of-service and volume testing against the demo, which runs on a small Cloudflare plan.
- The public demo endpoints being unauthenticated. This is intentional for a demo; abuse is bounded by request-size limits, a daily write cap on the worksite register and the LLM budget.
- Personal names and email addresses in the commit history and the hackathon archive. The team chose to keep them public (decision D-0930-0133 in `docs/decisions.md`).
- Content in `docs/hackathon/`, which is a historical archive of the event.
- Third-party services and data (Cloudflare, the LLM provider, OpenStreetMap, DataVic, PTV), and reports from automated scanners without a demonstrated impact.
