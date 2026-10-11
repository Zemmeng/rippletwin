# Archived task specs

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

During the event the lead (@Zemmeng) wrote a short spec (a "PRD") for each larger task and handed it to the module owner. They are kept as a record of how the work was split and specified, and they describe the product as it stood when each one was written. For the current design see [`docs/architecture/`](../../architecture/README.md) and [`docs/reference/interfaces.md`](../../reference/interfaces.md). Decision IDs such as D-0929-1435 are rows in [`docs/decisions.md`](../../decisions.md).

| File | Written | What it is |
|---|---|---|
| [`ai-flow.md`](ai-flow.md) | 29 Sep | Text version of the AI flow chart: which steps the engine computes and which two ask an LLM ("the LLM only interprets, the engine chooses", D-0929-1435). |
| [`T5-PRD.md`](T5-PRD.md) | 29 Sep | T5 for @jinmingq: the sign reader in `apps/api`, covering the keyword-rule fallback, LLM prompting, caching, VMS text limits and tests. |
| [`T12-params-PRD.md`](T12-params-PRD.md) | 29 Sep 15:15 | T12 for @Unzzip: find published sources for the persona choice-model parameters and deliver `apps/params/public/params.json`. |
| [`T13-web-wiring-PRD.md`](T13-web-wiring-PRD.md) | 29 Sep 16:00 | T13 for @unicornnnnnny: replace the page's preset numbers with engine results through `backend.js`, with a field-by-field mapping. |
| [`T14-liquid-glass-PRD.md`](T14-liquid-glass-PRD.md) | 29 Sep 17:20 | T14 for @unicornnnnnny: restyle the web UI in the Apple Liquid Glass style (appearance only), with contrast, accessibility and frame-rate limits. |
| [`judge-panel-0929.md`](judge-panel-0929.md) | 29 Sep 20:15 | A **simulated** review: three AI agents role-playing an industry, a technical and a presentation judge critiqued the 29 Sep UI. Not feedback from the real judges. |
| [`T20-addendum.md`](T20-addendum.md) | 29 Sep 21:25 | Five UI fixes added to T20 from that simulated panel. |
| [`T26-T27-web-PRD.md`](T26-T27-web-PRD.md) | 29 Sep 23:54 | T28 (a per-link `extra_min` from the engine), T26 (finishing T20) and T27 (the map shows the whole CBD), all for @unicornnnnnny, with the merge order. |
| [`T31-weather-backtest-PRD.md`](T31-weather-backtest-PRD.md) | 30 Sep 10:03 | T31 for @louisxie316-dotcom: back-test the page's weather multipliers against real hourly weather, SCATS volumes and pedestrian counts. |

The original index also listed Chinese architecture PDFs drawn on 29 Sep (`1-system-flow.pdf`, `2-agent-integration.pdf`, `3-architecture-v1.pdf`, `4-ai-flow.pdf` / `.png` and `5-llm-api-detail.pdf`). They were superseded during the event and have been removed from the tree; they are available at the [`hackathon-final` tag](https://github.com/Zemmeng/rippletwin/tree/hackathon-final/docs/arch).
