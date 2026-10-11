# DeepSeek · deepseek-chat (an alias, actually deepseek-flash) — API card

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Author @louisxie316-dotcom · last tested 09-29 16:04 · variable names only, never key values
> There is already a card for the same provider by @jinmingq, [`jinmingq-deepseek.md`](jinmingq-deepseek.md) (pricing, forced JSON and the thinking-mode pitfall are all there). This card covers only **a second key** and **measurements that disagree with that card**, without copying the rest.

## 1. Basics

| Item | What to fill in |
|---|---|
| Provider / model | DeepSeek (official) / requested `deepseek-chat`; the `model` in the response is `deepseek-flash` (tested 09-29, see §5) |
| Endpoint | `https://api.deepseek.com/chat/completions`, OpenAI-compatible (tested) |
| Authentication | Request header `Authorization: Bearer $DEEPSEEK_API_KEY` |
| Environment variable name | `DEEPSEEK_API_KEY` |
| Who holds the key · whose credit | @louisxie316-dotcom · balance in my own account (amount not checked) |
| Price | Same as `jinmingq-deepseek.md` §1; not checked separately |
| Rate limit | Not tried |
| Callable from a Cloudflare Worker? | Not tried |
| Sign-up page | https://platform.deepseek.com/ |

## 2. Minimal call (key as a variable, never the value)

```bash
curl -sS https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

## 3. Measured response (write what actually comes back, don't guess from the docs)

1 call tested at 09-29 16:04 (HTTP 200, answer `pong`):

- Path to the answer text: `choices[0].message.content`; `finish_reason` is `stop`
- Path to the usage: `usage.prompt_tokens` (10), `usage.completion_tokens` (2), `usage.total_tokens` (12); there are also `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`
- How long one call takes: 1.3 seconds
- Can it be forced to return JSON only: not tried (@jinmingq tested it and it works; see §3 of their card)

## 4. Estimated cost of one demo for our use

Same as `jinmingq-deepseek.md` §4 (same service, same prices); not repeated here. This test used only 12 tokens.

## 5. Pitfalls / notes (where this disagrees with `jinmingq-deepseek.md`)

- **The old name `deepseek-chat` still worked on 09-29**: requesting `deepseek-chat` returned HTTP 200 with `deepseek-flash` in the response's `model` field, so it looks like an alias. @jinmingq's card says it was "retired on 2026-07-24", but at least on 09-29 it had not been. Tested only once; for production code it is still better to follow their card and use `deepseek-flash`, in case the alias really is withdrawn one day
- **No thinking seen with the alias**: this call did not pass `thinking`, the response had no `reasoning_content`, `completion_tokens` was only 2 and `content` was normal. That disagrees with their card ("thinking mode is on by default and uses up `max_tokens`"); perhaps the alias does not think by default, or perhaps it is because `max_tokens` was not set. Tested only once with no control, so **code should still follow their card and pass `"thinking":{"type":"disabled"}`**
- **Don't send a DeepSeek key to the DashScope (Alibaba Bailian) endpoint**: both providers' keys are `sk-` + 32 characters and look the same. While debugging on 09-29 I sent one to `dashscope.aliyuncs.com` by mistake and got 401 `invalid_api_key`, which looked like a broken key but was actually the wrong endpoint. Use two different variable names in `.env` (`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`)
- My local network can reach `api.deepseek.com` directly (tested 09-29); whether the Worker can reach it has not been tried
