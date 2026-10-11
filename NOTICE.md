# Notices

RippleTwin's source code is released under the [MIT License](LICENSE), Copyright (c) 2026 Team Uncapped. This file lists what in the repository is **not** covered by that licence or needs attribution: third-party data, third-party code, and software or services that the project uses but does not include.

## Data

All data was downloaded ahead of time by the scripts in [`apps/roads/tools/`](apps/roads/tools/) (and, for the first junction prototype, [`apps/sim/tools/`](apps/sim/tools/)) and committed as processed JSON. The page calls no data API at runtime. Full details of each dataset, its period and the script that builds it are in [docs/data/sources.md](docs/data/sources.md).

### OpenStreetMap-derived files (ODbL 1.0)

These files are derived from OpenStreetMap and are distributed under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/), a share-alike licence, **not** under MIT:

| File | Contents | Attribution |
|---|---|---|
| [`apps/roads/public/cbd/network.json`](apps/roads/public/cbd/network.json) | Road network: 805 nodes, 1,513 directed links, tram lines | © OpenStreetMap contributors |
| [`apps/roads/public/cbd/walk.json`](apps/roads/public/cbd/walk.json) | Walking network | © OpenStreetMap contributors |
| [`apps/roads/public/cbd/buildings.json`](apps/roads/public/cbd/buildings.json) | Building outlines, names and use tags (merged with City of Melbourne data, below) | © OpenStreetMap contributors; City of Melbourne Open Data |
| [`apps/roads/public/cbd/vectormap.json`](apps/roads/public/cbd/vectormap.json) | Background layers decoded from six OpenMapTiles vector tiles served by OpenFreeMap (OpenMapTiles schema CC BY 4.0) | Vector basemap © OpenMapTiles / OpenFreeMap, data © OpenStreetMap contributors |

Anyone who redistributes these files, or publicly uses an adapted version of them, must keep them under ODbL 1.0 and keep the attribution.

Other files carry OpenStreetMap-derived link ids or geometry, for example `flows.json`, `transit.json`, `peds.json` and the SUMO replays in [`apps/sumo/public/real/`](apps/sumo/public/real/). Their licence position was not assessed separately; if you redistribute them, treat them as possibly ODbL-derived as well.

### Other open data

| Source | Used in | Licence | Attribution line |
|---|---|---|---|
| DataVic: Traffic Signal Volume Data (SCATS), Department of Transport and Planning, Victoria | `flows.json`, `apps/sim/public/demand/`, the weather back-test | CC BY 4.0 | Traffic Signal Volume Data, Department of Transport and Planning, Victoria |
| DataVic: Victorian Traffic Signals (site list) | `signals.json`, signal flags in `network.json` | CC BY 4.0 | Traffic Signal Volume Data, Department of Transport and Planning, Victoria |
| DataVic: Traffic Signal Configuration Data Sheets (site 2921) | Detector-to-lane mapping in `apps/roads/tools/build_flows.py` and `apps/sim`; not redistributed | CC BY 4.0 | Traffic Signal Volume Data, Department of Transport and Planning, Victoria |
| DataVic: PTV GTFS Schedule (release of 26 Sep 2026; tram and metropolitan bus) | `transit.json` | CC BY 4.0 | Public Transport Victoria, via DataVic |
| City of Melbourne: Pedestrian Counting System (hourly counts and sensor locations) | `peds.json`, `apps/sim`, the weather back-test | **Unconfirmed**: the dataset page states no licence; the other datasets in the series are CC BY | City of Melbourne Open Data |
| City of Melbourne: 2018 Building Footprints | Building heights in `buildings.json` | CC BY | City of Melbourne Open Data |
| City of Melbourne: Building information (CLUE census 2024) | Building use and floor counts in `buildings.json` | CC BY | City of Melbourne Open Data |
| Open-Meteo Historical Weather API, model `ecmwf_ifs` | `weather_hourly.json`, `weather_backtest.json` (offline back-test only; not shown on the page) | CC BY 4.0; fetched once through the free API, whose terms allow non-commercial use | Weather data by Open-Meteo.com |
| Bureau of Meteorology: Daily Weather Observations, Melbourne (Olympic Park) | Manual check of rain days for the back-test; downloaded by hand and not committed | © Commonwealth of Australia; reference only | Bureau of Meteorology |

The web page shows these credits next to the layers that use them and in its footer, and the same lines close the printed execution pack and the copied playbook.

### Generated content

[`apps/api/public/answers/demo.json`](apps/api/public/answers/demo.json) holds 92 sign readings that the team generated in advance through the DeepSeek API (`deepseek-flash`). It is model output, not a third-party dataset.

### Referenced only

These sources shaped the project, but no content from them is copied into the repository:

- **RPM Hire website product pages** (checked 29 Sep 2026): equipment types and specifications for the 16 items in `apps/roads/public/cbd/equipment.json`; the 7 hire products link to their product pages. Quantities and day rates are the team's own assumptions, because RPM Hire publishes no prices. No images or text were copied. RPM Hire names and trade marks belong to RPM Hire.
- **Transport for NSW sign register**: the sign codes `T1-1` (ROADWORK AHEAD) and `T2-16` (END ROADWORK) in `equipment.json`.
- **Published literature** behind the parameters in [`apps/params/public/params.json`](apps/params/public/params.json). The checked citations are listed in [docs/data/assumptions-and-validation.md](docs/data/assumptions-and-validation.md#references).

## Third-party code

### liquid-glass.js

The refraction effect on the analysis panel and the top bar, in [`apps/web/src/js/7-glass.js`](apps/web/src/js/7-glass.js) (and therefore in the built [`apps/web/public/index.html`](apps/web/public/index.html)), is adapted from liquid-glass.js by Deepika Rao: a canvas displacement map fed to staggered `feDisplacementMap` passes through `backdrop-filter`. The file header credits it.

- Source: <https://github.com/sven1577/liquid-glass>
- Licence: MIT

```text
MIT License

Copyright (c) 2026 Deepika Rao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Code written before the event

[`apps/api/tests/mini.mjs`](apps/api/tests/mini.mjs) (a zero-dependency assertion helper) and [`apps/api/test.sh`](apps/api/test.sh) (the module's test runner) were copied from the team's own pre-event template after the event started: `mini.mjs` unchanged and `test.sh` with one line changed. They contain no product logic and are covered by the MIT licence above. The event rules required this disclosure; see [docs/hackathon/submission.md](docs/hackathon/submission.md).

## Software and services used but not included

None of the following is vendored into the repository. Each is installed by a package manager or loaded at runtime under its own licence or terms.

| Item | Used for | Licence or terms |
|---|---|---|
| [Eclipse SUMO](https://eclipse.dev/sumo/) 1.27.1 and sumolib (PyPI `eclipse-sumo`, `sumolib`) | Micro-simulation in the container image and for local runs ([`apps/web/tools/sumo/requirements.txt`](apps/web/tools/sumo/requirements.txt)); the replays in [`apps/sumo/public/`](apps/sumo/public/) are SUMO output | EPL-2.0 OR GPL-2.0-or-later |
| NumPy 2.2.6 and SciPy 1.15.3 | Required by SUMO's `routeSampler` tool in the container image | BSD-3-Clause |
| Docker image `python:3.12-slim` and Debian packages (X11 and GL client libraries, `libatomic1`) | Base of [`apps/sumo/Dockerfile`](apps/sumo/Dockerfile) | Python Software Foundation License and the Debian package licences |
| `@cloudflare/containers` 0.3.7 (npm) | Container class and routing in `apps/sumo/src/worker.js` | MIT OR Apache-2.0 |
| Wrangler 4 (npm, development dependency of `api`, `site`, `sumo` and `web`) | Local development and deployment of the Workers | MIT OR Apache-2.0 |
| OSMnx and its dependencies (networkx, geopandas, shapely, requests) | Offline data preparation in `apps/roads` ([`requirements.txt`](apps/roads/requirements.txt)); not shipped | MIT; BSD-3-Clause; Apache-2.0 (requests) |
| Google Fonts: Inter, JetBrains Mono, Noto Sans SC, Space Grotesk (`apps/web`); Barlow, Barlow Condensed, IBM Plex Mono (`apps/sim`) | UI type, loaded from `fonts.googleapis.com` at runtime and not redistributed | SIL Open Font License 1.1 |
| GitHub Actions: `actions/checkout`, `actions/setup-node`, `actions/setup-python` | CI checks and the manual deploy workflow in [`.github/workflows/`](.github/workflows/) | MIT |
| Cloudflare Workers, Static Assets, KV, Durable Objects and Containers | Hosting the demo | Cloudflare terms of service |
| DeepSeek API (`deepseek-flash`) | Sign reading and plan explanations, called only from the API Worker | DeepSeek API terms |

The project uses no CDN JavaScript, stock images, audio, 3D assets or runtime map tiles. The map is drawn from the project's own JSON files.
