# T12 PRD: evidence for the engine parameters (sourced numbers for the 4 road-user types' choice model)

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Owner: @Unzzip · Module: `apps/params/` (new) · Branch: `Unzzip/params/T12-evidence` · Written 2026-09-29 15:15 (the lead, @Zemmeng)
> Consumer: the engine (`apps/engine`, being written in the lead's "AI flow base architecture" session, task T9). Decisions: D-0929-1435 (shares are computed by the engine from per-type parameters), D-0929-1515 (this task).

## 1. Why

D-0929-1435 settled it: the LLM is only responsible for interpreting the words on the signs, and **how many people take each road is computed by the engine from per-type parameters**. Right now these parameters are all guesses, marked [to verify] in the engine code and docs. If a judge asks "where does this number come from?", we have no answer. This task replaces them with sourced numbers and gives ranges where we are unsure.

## 2. Deliverables

| File | Contents |
|---|---|
| `apps/params/public/params.json` | The parameters, each number with a source (format in section 4) |
| `apps/params/README.md` | One line per parameter: value, range, source (author, year + link), how it was converted from the original, confidence |
| `apps/params/test.sh` | Validation: every value has a `source` and a `confidence`; shares are between 0 and 1; the 4 type shares sum to 1; key names are all ASCII; the last line prints `N passed, M failed` |

## 3. Parameters to find

**P0 (the sourced half by the 17:00 integration checkpoint, all of them by 21:00)**

| Parameter | Current assumption | What to look for |
|---|---|---|
| Type mix `mix`: commuter / local / tourist / delivery | 50 / 25 / 10 / 15 | Trip-purpose composition in the Melbourne CBD at peak times (VISTA travel survey, ABS commuting data, commercial-vehicle share) |
| Detour share when the sign only says "roadwork ahead" | About 3% | Measured effect of VMS and works warnings on diversion |
| Detour share when a route is recommended (USE X ST) | About 20% (Erke 2007, cited second-hand) | Check against the original, or find other measurements |
| Ratio of stated "would detour" in surveys to actual detours | About 1/5 (Chatterjee 2002) | Check against the original |
| Sign trust (share who follow what the sign says), per type | None | Studies of driver trust in, and compliance with, VMS |

**P1**

| Parameter | What to look for |
|---|---|
| In a hurry or not: value of time (AUD per hour), for cars and trucks separately; mean occupancy per vehicle | ATAP PV2 · Travel time (item E in section 4 of `apps/roads/PRD-2.md` originally went to @louisxie316-dotcom; it now belongs to this task) |
| Familiar with the roads or not: how well locals, commuters and tourists know the alternative routes | Studies of how route familiarity affects diversion |
| How far away the sign text is legible and how long it takes to read | Converting VMS character height to legibility distance; words read per second (Australian and US standards: AS 4852, MUTCD) |

**P2**

- Type mix by time of day (AM peak, midday, PM peak, weekend)
- Averse to queues or not: risk attitude towards queues and uncertainty

## 4. Format (draft; key names all ASCII, D-05)

```json
{
  "version": 1,
  "mix": {
    "commuter": { "value": 0.5, "range": [0.4, 0.6], "unit": "share", "source": "Author Year, link", "confidence": "low", "note": "how it was converted" }
  },
  "anchors": {
    "generic_warning_divert": { "value": 0.03, "range": [0.01, 0.06], "unit": "share", "source": "…", "confidence": "low" },
    "named_route_divert":     { "value": 0.20, "range": [0.10, 0.30], "unit": "share", "source": "…", "confidence": "low" },
    "stated_to_actual":       { "value": 0.20, "range": [0.10, 0.35], "unit": "ratio", "source": "…", "confidence": "low" }
  },
  "persona": {
    "commuter": { "sign_trust": { "value": null, "source": null, "confidence": "none", "note": "no reliable data found" } }
  },
  "vms": {},
  "value_of_time": {}
}
```

- `confidence` is one of `high` / `medium` / `low` / `none`
- **If you can't find it, write `null` with a one-line explanation; don't make anything up**; flag second-hand citations and name the original author
- If the engine later needs different field names, the engine wins; the lead will pass the change on

## 5. Rules

- Write only in `apps/params/`; the lead has already registered it in the `apps/README.md` register and in CODEOWNERS
- No spending: use public papers, government reports and open data; using an LLM to help search is fine, but every number must have a source you can open and check
- Deal with #5 first: split it as the lead commented on the PR, or simply close it (the challenge content is already in `docs/1-brief.md`, now [`docs/hackathon/challenge-brief.md`](../challenge-brief.md))
- When done, open a PR and say in it which numbers you are least sure about
