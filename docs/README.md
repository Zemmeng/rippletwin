# Documentation

RippleTwin models the knock-on effects of a planned road closure in the Melbourne CBD on traffic, trams, buses and pedestrians before the barriers go out. It was built by Team Uncapped in about 50 hours at FEIT Hackathon Festival 2026 (University of Melbourne, Challenge 5, sponsored by RPM Hire) and won the RPM Hire Prize.

This folder holds the project's long-form documentation. For a first look, read the [project README](../README.md), then the [architecture overview](architecture/README.md).

## Architecture

| Page | What it covers |
|---|---|
| [Architecture overview](architecture/README.md) | System summary and diagram, the eight modules, the end-to-end flow of evaluating a plan, design principles, key design decisions, post-event status |
| [Traffic engine](architecture/engine.md) | The deterministic engine pipeline: detours, sign readings, persona choice model with two-point calibration, BPR and queue assignment, transit and pedestrian impacts, clash cost, options and advisor |
| [Sign reading](architecture/sign-reading.md) | How the LLM reads signs and VMS text, the reader fallback chain, caching, budget and cost caps, prompt-injection guards, and the number-checked plan explanation |
| [Traffic simulation](architecture/traffic-simulation.md) | Eclipse SUMO on the real CBD network, the cloud container, pre-computed (baked) replays, and the in-browser GridSim fallback |
| [Front end](architecture/frontend.md) | The zero-build web app: build step, source layout, the 6-step workbench, map rendering, SUMO replay streaming, bilingual UI, security policy and testing |
| [Deployment](architecture/deployment.md) | Cloudflare topology, Workers and bindings, secrets, the deploy procedure, costs, post-event status and running locally |
| [Decision log](decisions.md) | Every decision taken before and during the event, with reasons and rejected alternatives; superseded entries are kept |

## Reference

| Page | What it covers |
|---|---|
| [Module interfaces](reference/interfaces.md) | Data file formats, the sign-reading request and reading, the plan format, the engine and backend API, the HTTP API (`/api/health`, `/api/read`, `/api/explain`, `/api/worksites`, `/api/sumo/v1/*`) and the error format |

## Data

| Page | What it covers |
|---|---|
| [Data sources](data/sources.md) | Every dataset with its licence, attribution and the script that builds it |
| [Assumptions and validation](data/assumptions-and-validation.md) | What is real data and what is assumed, parameter confidence, the weather back-test, and known limitations |

## Project history (archive)

Records from the hackathon itself, translated from the original Chinese. They are kept as they were written, including details that later changed. The untranslated originals are in the git tag `hackathon-final`.

| Page | What it covers |
|---|---|
| [Hackathon archive](hackathon/README.md) | The event, timeline, team contributions and result; start here |
| [Challenge brief](hackathon/challenge-brief.md) | Challenge 5, judging criteria, timeline and rules |
| [Plan](hackathon/plan.md) | The plan written at kickoff: pitch, alternatives considered, MVP scope, milestones |
| [Task board](hackathon/task-board.md) | Tasks T0–T51 with owners, status and pull requests |
| [Demo script](hackathon/demo-script.md) | The 7-minute finals script, where each number came from, prepared Q&A |
| [Submission notes](hackathon/submission.md) | Third-party data and code, AI tools used, what existed before the event |
| [Cloudflare notes](hackathon/deploy-cloudflare-notes.md) | The deployment guide used during the event (replaced by [Deployment](architecture/deployment.md)) |
| [Specs](hackathon/specs/README.md) | Task specifications (PRDs) handed to team members, and the AI-flow description |
| [LLM API cards](hackathon/llm-apis/README.md) | Candidate LLM providers each member evaluated (variable names only) |
| [Pitch material](hackathon/pitch/README.md) | The pre-screen deck and the pitch diagrams with their generator |
| [Handoff notes](hackathon/handoff/README.md) | Session handoff notes written while the work moved between people and AI sessions |

## Contributing

| Page | What it covers |
|---|---|
| [Contributing guide](../CONTRIBUTING.md) | Setup, branch and commit conventions, module ownership, the checks every change must pass |
| [Security policy](../SECURITY.md) | How to report a vulnerability, and how secrets are handled |
| [Scripts](../scripts/README.md) | `setup.sh`, `check.sh` (the nine checks, `--quick`, `--e2e`), `deploy.sh`, git hooks and CI |
| [Pitfalls](pitfalls.md) | Problems hit during the build and how they were fixed |
| [Licence](../LICENSE) and [notices](../NOTICE.md) | MIT for the code; data licences (some files are ODbL share-alike) and third-party attributions |
| [Citation](../CITATION.cff) | How to cite the project |

## Module READMEs

Each module under [`apps/`](../apps/README.md) has its own README with how to run and test it, its interfaces and its owner.

| Module | README | Owner |
|---|---|---|
| `sim` | [apps/sim/README.md](../apps/sim/README.md) | @Zemmeng |
| `roads` | [apps/roads/README.md](../apps/roads/README.md) | @louisxie316-dotcom |
| `web` | [apps/web/README.md](../apps/web/README.md) | @unicornnnnnny |
| `engine` | [apps/engine/README.md](../apps/engine/README.md) | @Zemmeng |
| `api` | [apps/api/README.md](../apps/api/README.md) | @jinmingq |
| `params` | [apps/params/README.md](../apps/params/README.md) | @Unzzip |
| `site` | [apps/site/README.md](../apps/site/README.md) | @Zemmeng (code), @unicornnnnnny (deploy) |
| `sumo` | [apps/sumo/README.md](../apps/sumo/README.md) | @Zemmeng |

The SUMO job server and the real-network replay generator live in the web module: [apps/web/tools/sumo/README.md](../apps/web/tools/sumo/README.md).

## Images

[`images/`](images/) holds the logos, the six workbench screenshots, the architecture diagrams (light and dark variants), the demo video cover and the award certificate.
