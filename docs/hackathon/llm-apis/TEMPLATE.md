# <Provider> · <model name> — API card

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Author @<handle> · last tested MM-DD HH:MM · variable names only, never key values
> Copy this file to `docs/llm-apis/<handle>-<provider>.md` (the folder's path during the event) and fill it in; for anything you can't fill in, write "not tried".

## 1. Basics

| Item | What to fill in |
|---|---|
| Provider / model | e.g. DeepSeek / deepseek-chat |
| Endpoint | e.g. `https://api.deepseek.com/chat/completions`; whether it is OpenAI-compatible |
| Authentication | e.g. request header `Authorization: Bearer $DEEPSEEK_API_KEY` |
| Environment variable name | e.g. `DEEPSEEK_API_KEY` (all-caps ASCII) |
| Who holds the key · whose credit | e.g. @jinmingq · sign-up credit |
| Price | Input / output cost per million tokens; how much free credit and when it expires |
| Rate limit | Requests / tokens per minute |
| Callable from a Cloudflare Worker? | Yes / no / not tried (some providers restrict regions) |
| Sign-up page | URL |

## 2. Minimal call (key as a variable, never the value)

```bash
curl -sS https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $EXAMPLE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model name>","messages":[{"role":"user","content":"ping"}]}'
```

## 3. Measured response (write what actually comes back, don't guess from the docs)

- Path to the answer text: e.g. `choices[0].message.content`
- Path to the usage: e.g. `usage.prompt_tokens`, `usage.completion_tokens`
- How long one call takes: e.g. 1.2 seconds (measured MM-DD)
- Can it be forced to return JSON only: yes / no (and the parameter to use)

## 4. Estimated cost of one demo for our use

One sign message = 4 road-user types × 3 calls each = 12 calls (the LLM only interprets the sign text and the engine computes the shares; the call count follows [`docs/hackathon/specs/T5-PRD.md`](../specs/T5-PRD.md)).
About ___ input tokens + ___ output tokens per call → about ___ per message; about ___ for 10 messages of demo preparation.

## 5. Pitfalls / notes

-
