# apps/

RippleTwin's code lives here, as eight self-contained modules. Each module has its own README, tests and, where it has them, its own run and deploy commands. At run time, modules interact only through the interfaces in [`docs/reference/interfaces.md`](../docs/reference/interfaces.md): same-origin URLs under `/<module>/public/`, JSON data files and the HTTP API.

In production one Cloudflare Worker, [`site`](site/README.md), serves every module's `public/` directory at `/<module>/public/` and forwards `/api/*`, so the whole demo runs on one origin: <https://hackathon-site.zemmmeng.workers.dev>.

## Module registry

| Module | Owner | Purpose | Local port | Production path |
|---|---|---|---|---|
| sim | @Zemmeng | The team's first prototype: a Swanston St × La Trobe St junction micro-simulation driven by real open data (static page) | 4174 | `/sim/public/` |
| roads | @louisxie316-dotcom | Data pipeline: Melbourne CBD road network, SCATS flows, signals, GTFS transit, walking network, buildings, equipment (static JSON) | — (offline Python build scripts) | `/roads/public/cbd/*.json` |
| web | @unicornnnnnny | The six-step workbench UI; zero-build, `build.py` concatenates `src/` into `public/index.html` | 4175 | `/web/public/` (the root `/` redirects here) |
| engine | @Zemmeng | Pure-JS traffic engine for the browser and Node: route choice driven by sign readings and road-user parameters | — (`node apps/engine/tools/demo.mjs`) | `/engine/public/js/` |
| api | @jinmingq | Cloudflare Worker `hackathon-api`: sign reading (LLM with keyword-rule fallback), plan explanations, worksite register, hire quote and export pack | 8788 | `/api/*` (through `site`), `/api/public/*` |
| params | @Unzzip | Literature-sourced behaviour parameters with confidence levels (static JSON) | — | `/params/public/params.json` |
| site | @unicornnnnnny (deployer) · @Zemmeng (code) | Same-origin Worker `hackathon-site`: serves every module's `public/` and forwards `/api/*` through service bindings | 8790 | `/` |
| sumo | @Zemmeng | Worker `hackathon-sumo` and a Cloudflare Container that ran Eclipse SUMO on the real network (deleted after the event), plus the pre-computed replays in `public/` | 8791 | `/api/sumo/v1/*` (through `site`; now `502 sumo_down`), `/sumo/public/` |

Owners match [`.github/CODEOWNERS`](../.github/CODEOWNERS); change both together. The `sumo` row is checked by `apps/sumo/tests/config.test.mjs` (owner and port 8791, the port of its `npm run dev`), so keep its column layout.

## Module conventions

- One module per subdirectory. The directory name is the module name, the commit subject prefix (`engine: ...`) and the module segment of a branch name (`<handle>/<module>/T<n>-<slug>`). Names match `^[a-z][a-z0-9-]*$`; `site/build.mjs` ignores any other directory.
- A module branch changes only its own `apps/<module>/`; `scripts/check.sh` check [3] enforces this. A change that has to touch producer and consumer together goes through the `cross-module` label (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
- Files served to the browser go in `apps/<module>/public/`. Only git-tracked files are deployed.
- Small sample data goes in the module's `fixtures/`. Large data and generated output go in `raw/` or `out/`, original media in `assets-src/`; all three are gitignored.

Every module must have:

| File | Requirement | Checked by |
|---|---|---|
| `README.md` | contains an `Owner: @handle` line | `scripts/check.sh` [4] |
| `test.sh` | executable in git; needs no `npm install` and no network; its last line prints `N passed, M failed`; exits non-zero on any failure | `scripts/check.sh` [4] and [5], which discovers every `apps/*/test.sh` |
| `npm run deploy` or `deploy.sh` | only for modules deployed on their own (listed in `DEPLOY_MODULES` in `hackathon.conf`) | `scripts/deploy.sh` |

A module README usually covers: what the module does, how to run it, how to test it, its interfaces (with a link to the matching section of `docs/reference/interfaces.md`), external APIs (variable names, limits, measured response shapes), a file map and known issues.

## Port conventions

| Kind | Ports | Notes |
|---|---|---|
| Workers (`wrangler dev`) | from 8788: `api` 8788, `site` 8790, `sumo` 8791 | 8787 belonged to a pre-event starter template, since removed |
| Static pages (`python3 -m http.server`) | from 4174: `sim` 4174, `web` 4175 | 4173 belonged to a removed starter template |
| SUMO job server (`apps/web/tools/sumo/serve.py`) | 8021 locally; 8080 inside the container, published as 8792 when the container runs on its own | see `apps/web/tools/sumo/README.md` and `apps/sumo/README.md` |

Anything that loads data from other modules needs the shared origin, so run `site` (port 8790) for the full app. A module's own port is only for previewing its page alone.

## Adding a module

1. Create `apps/<name>/` with a name matching `^[a-z][a-z0-9-]*$`.
2. Add a `README.md` with an `Owner: @handle` line and an executable `test.sh` that follows the rules above.
3. Add a row to the registry above (owner, purpose, local port, production path) and `/apps/<name>/ @handle` to `.github/CODEOWNERS`. Pick a free port following the port conventions.
4. Put browser-facing files in `apps/<name>/public/`. `site` serves the git-tracked ones at `/<name>/public/` with no further configuration.
5. If the module deploys on its own, give it a wrangler config and an `npm run deploy` script (or a `deploy.sh`) and add it to `DEPLOY_MODULES` in `hackathon.conf`. Order matters: a Worker that another Worker binds to must be deployed first.
6. Document its interface in `docs/reference/interfaces.md`.
