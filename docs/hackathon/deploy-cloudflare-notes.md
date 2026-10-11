# Deploying to Cloudflare: connecting, deploying, and giving teammates access

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> These notes come from the pre-event team template and describe a generic setup. For the deployment as it actually ended up (site, api and sumo Workers, service bindings, secrets, post-event status), see [docs/architecture/deployment.md](../architecture/deployment.md).
>
> This approach has been used in four of the lead's earlier live projects (room-based multiplayer, static sites, Durable Object state). Copy it and you are live.
> This file contains only variable names and commands, never a key. Account-related values live on the lead's machine or in GitHub Secrets.

## 0. In one sentence

One module = one Worker: the static pages in `public/` are served through the Worker's assets binding, `/api/*` and `/ws` go to the Worker code, and a Durable Object is bound if state is needed. `npx wrangler deploy` goes live in one command, and the URL works immediately.

**How this project actually deploys:** the demo URL has a single Worker, `apps/site`, which mounts each module's `public/` at `/<module>/public/` and forwards `/api/*` to T5's api Worker through a service binding. The deployer follows the "Deploy" section of [`apps/site/README.md`](../../apps/site/README.md).

## 1. Account and login (already set up on the lead's machine)

| Item | Current state |
|---|---|
| Cloudflare account | The lead's personal account; wrangler is logged in with `npx wrangler login` (browser OAuth) |
| Where the credentials are stored | `<local path>` (managed by wrangler itself, **not in the repository**) |
| Granted scopes | workers / workers_routes / workers_scripts (write), d1 (write), pages (write), workers_tail (read) |
| Domain | `<personal domain>` is hosted on this account, so any `<subdomain>.<personal domain>` can be bound with one line of configuration |
| workers.dev subdomain | The account comes with a `<account subdomain>.workers.dev`; with `workers_dev: true`, every Worker automatically gets `<name>.<account subdomain>.workers.dev` |

Self-check:

```bash
npx wrangler whoami        # if you see the account name and scopes, you are logged in
```

## 2. Standard configuration for one module (`apps/<module>/wrangler.jsonc`)

Below is the generic sample (originally in the pre-event `starters/web-worker/`, deleted under D-0929-1311; for this project's real configurations see `apps/api/wrangler.jsonc` and `apps/site/wrangler.jsonc`):

```jsonc
{
  "name": "<module name>",            // Worker name, also the prefix of the workers.dev link
  "main": "src/worker.js",
  "compatibility_date": "2026-08-01",
  "workers_dev": true,                // on during the event for the demo link; set to false afterwards to turn it off
  "preview_urls": false,
  "observability": { "enabled": true },                       // live logs appear in the dashboard under Workers Logs
  "assets": { "directory": "public", "binding": "ASSETS" },   // static pages
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  // Uncomment to bind a custom domain (the DNS record is created automatically, no dashboard clicks needed):
  // "routes": [{ "pattern": "<module>.<personal domain>", "custom_domain": true }]
}
```

Key points:
- **Use `new_sqlite_classes` for Durable Objects** (it works on the free plan too), not the old `new_classes`
- A migration `tag` is only ever added, never edited: renaming a class needs a new migration, not a change to the old one
- A purely static page needs neither `main` nor `durable_objects`, only `assets`
- Don't collide with subdomains already in use: check the names already taken under Cloudflare dashboard → Workers & Pages first

## 3. Commands

```bash
cd apps/<module>
npm ci                               # installs only wrangler (package-lock.json pins the version)
npm run dev                          # = wrangler dev --port <this module's port, see the registry in apps/README.md>; Claude users start it with the preview tool by its launch.json name
npm run deploy                       # = wrangler deploy; live within seconds, prints the URL
npx wrangler tail                    # live production logs (for chasing 500s)
npx wrangler deployments list        # deployment history
npx wrangler delete                  # take the whole Worker offline (post-event clean-up)
```

Variables for local development go in `apps/<module>/.dev.vars` (copied from `.dev.vars.example`, git-ignored). wrangler dev reads `.dev.vars` in the **module directory** first and only falls back to `.env` in the module directory. The `.env` at the repository root does not reach the Worker's `env` (it does reach the wrangler process environment, though, so do not put `CLOUDFLARE_API_TOKEN` in the root `.env`).

## 4. Secrets

```bash
npx wrangler secret put <NAME>       # paste interactively; the value never appears in the shell history
npx wrangler secret list             # names only
npx wrangler secret delete <NAME>
```

Code reads them as `env.<NAME>`. For a local value, put it in `.dev.vars`; to pass one temporarily on the dev command line, use `wrangler dev --var NAME:value` (this is where `--var MOCK:1` in launch.json comes from).

Secrets live in exactly two places: Cloudflare secrets and the local `.dev.vars`. Docs, handoff notes, the README and commits mention variable names only.

## 5. How teammates deploy (choose one of three at kickoff)

| Option | Suits | How |
|---|---|---|
| **A · Only the DEPLOYER deploys** (default) | 3–5 people, deploying every few hours | Teammates merge PRs into main → the DEPLOYER runs `bash scripts/deploy.sh all`. `DEPLOYER` in `hackathon.conf` names this person |
| **B · Add a second person to the Cloudflare account** | Someone who can fight fires when the lead is asleep or unreachable | ① Cloudflare dashboard → Manage Account → Members → invite by email, with the role *Administrator* (simplest) or an Admin role with "Workers" in its name; once added, have them check that they can actually deploy ② They run `npx wrangler login` on their own machine; **if they also have a Cloudflare account of their own, they will see two accounts**, so before deploying they run `export CLOUDFLARE_ACCOUNT_ID=<the lead's account ID>` (given privately by the lead, never committed) and confirm with `npx wrangler whoami` ③ Add them as `BACKUP_LEAD` in `hackathon.conf`, and `deploy.sh` lets them through (it prints ⚠️ and marks the run as a backup deploy in `logs/deploy.log`). **Never bypass `deploy.sh` with a direct `npm run deploy`** |
| **C · Deploy with a button on the GitHub website** | When the DEPLOYER has no local environment or wrangler at hand | The lead creates a token in the Cloudflare dashboard → My Profile → API Tokens using the *Edit Cloudflare Workers* template, and puts `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into the GitHub repository's Settings → Secrets → Actions. Then run the `deploy` workflow manually from the Actions page (`.github/workflows/deploy.yml`: manual trigger only, only the DEPLOYER can run it, and it runs the full check and the freeze check before deploying) |

Whichever option you use, **`bash scripts/check.sh` must be fully green before deploying**: for A and B, `deploy.sh` checks this itself; for C, the workflow does.

## 6. Domains

- For the event the workers.dev link is enough (`workers_dev: true`; the terminal prints it after a deploy). Put it in `DEMO_URL` in `hackathon.conf` and at the top of the README
- For a nicer custom domain: uncomment the `routes` line, change it to `<module>.<personal domain>` and deploy again; DNS and certificates are configured automatically and take effect within a minute or two
- Backup link: the workers.dev link stays available, so if one fails during the demo, switch to the other

## 7. Three Durable Object rules (learned the hard way)

1. **Persist every state change to storage with `commit()`**, because the instance can be evicted at any time; `v` increases monotonically, and clients use it to tell newer broadcasts from older ones
2. **Await points inside `fetch()` interleave**, so never assume the state is unchanged between two awaits; serialise every place that writes state (one queued `commit()`)
3. **Trim the view per user before broadcasting** (`viewFor()`); broadcasting the whole state hands other people's private fields to everyone

## 8. Common problems

| Symptom | Cause / fix |
|---|---|
| `Not logged in` | `npx wrangler login`; in CI, `CLOUDFLARE_API_TOKEN` is not set |
| `A route with this pattern already exists` | The subdomain is taken by another Worker; choose another name or unbind it in the dashboard |
| Deploy fails with a migration error after renaming a DO class | Add a new `migrations` entry (`renamed_classes` or `deleted_classes`); don't edit the old tag |
| Changed CSS/JS but the live site looks the same | Browser cache. Run `bash bump.sh` to increment `?v=`, then deploy again |
| A static page returns 404 although the file is in `public/` | Check the `assets.directory` path. For an SPA (the front end handles its own routing), add `"not_found_handling": "single-page-application"` to `assets`, so unmatched navigation requests fall back to `index.html` while `/api/*` and `/ws` still reach the Worker |
| WebSocket will not connect | `ws://` locally, `wss://` live; the front end decides from `location.protocol` |
| `.wrangler/` shows up in `git status` | It is git-ignored; if it was ever added with `git add -f`, run `git rm -r --cached .wrangler` |
| Want to see live errors | Keep `npx wrangler tail` running and reproduce the problem again |

## 9. Another route for purely static sites: Cloudflare Pages

When no backend is needed, you can also deploy straight to Pages (the lead's earlier static site was deployed this way):

```bash
npx wrangler pages deploy public --project-name <name>
```

Pages can also be bound to `<subdomain>.<personal domain>`, under dashboard → Pages → Custom domains. But don't use both routes for the same project; pick one.
