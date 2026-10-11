# How the AI fits into the pipeline (text version of the flow chart)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

Diagram: `4-ai-flow.pdf` / `4-ai-flow.png` (same content as this file; removed from the tree, available at the [`hackathon-final` tag](https://github.com/Zemmeng/rippletwin/tree/hackathon-final/docs/arch)) · Decision: `D-0929-1435` (the LLM only interprets, the engine chooses) · Interface: the persona-readings section of `docs/contract.md` (now [`docs/reference/interfaces.md`](../../reference/interfaces.md)) · T5 spec: [`T5-PRD.md`](T5-PRD.md)

**Principle: the LLM advises, the engine computes the numbers.** The LLM only interprets the words on the signs; how many people take each road, the minutes and the queue lengths are all computed by the engine. The engine exposes only `evaluate(plan)`: the same input gives the same result, and it can be re-run as often as needed. The front end is not in this chart; only the input and the output at either end are shown.

| Step | What it does | Who |
|---|---|---|
| Input | The works plan handed over by the front end: which section is closed, when, which equipment is placed, what the signs say | Front end, T2 |
| ① | Find the affected vehicles and the roads they could detour by (and how long each normally takes) | Engine, T4 |
| ② | Write down what each of the 4 road-user types sees: the signs in order, the sign text, and how many seconds they can read it at their speed | Engine, T4 |
| ③ | **Ask the LLM to interpret the sign text**: did they notice it, did they understand it, which road does it tell them to use or avoid, how many minutes does it say they save or lose, do they trust it, and a one-line reason | **AI · T5, @jinmingq** |
| ④ | Choice model: reading + per-type parameters → the share of each type on each road; the two-point calibration is applied here | Engine, T4 |
| ⑤ | Assign the traffic; compute delay and queues | Engine, T4 |
| ⑥ | Overlay other works nearby at the same time: compute A and B separately, then together; the extra is the clash cost | Engine, T4 |
| ⑦ | **Planning advisor (bonus)**: propose 3 changes (change the sign text · move equipment · stagger the dates) | **AI** |
| Output | Handed to the front end: where it jams, for how long, how much each type is affected, and each change before vs after | Engine, T4 |

*Note added when archiving: the planning advisor (⑦) shipped as a rule-based component; it does not call an LLM.*

Re-runs:

- ⑤ the queue gets longer → back to ④; the engine recomputes by itself and **does not ask the LLM again**
- Each change from ⑦ → back to ⑤, recomputed by the engine

How ③ is asked (T5):

- It depends only on the words and the person, not on traffic conditions, so each message is asked once per road-user type (3 times, to give a range) and the cache never goes stale
- It returns readings only, **never shares**
- Check the cache first; if the LLM is down, fall back to keyword rules
- The key lives only on Cloudflare

④ Per-type parameters (T4): in a hurry or not · familiar with the roads or not · trusts signs or not · averse to queues or not · allowed on truck routes or not. The LLM is not allowed to give shares directly: persona-only prompts produce very small behavioural differences, and LLMs are more risk-averse than real people (evidence in D-0929-1435).

Still open: which LLM provider and whose key; who does T4.
