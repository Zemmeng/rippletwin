# DeepSeek · deepseek-flash — API card

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> Author @jinmingq · last tested 09-29 15:47 · variable names only, never key values

## 1. Basics

| Item | What to fill in |
|---|---|
| Provider / model | DeepSeek (official) / `deepseek-flash` (DeepSeek-V4.1-Flash). The old names `deepseek-chat` and `deepseek-reasoner` were retired on 2026-07-24; don't use the model names from old tutorials |
| Endpoint | `https://api.deepseek.com/chat/completions`, OpenAI-compatible (tested) |
| Authentication | Request header `Authorization: Bearer $DEEPSEEK_API_KEY` |
| Environment variable name | `DEEPSEEK_API_KEY` |
| Who holds the key · whose credit | @jinmingq · ¥10 topped up personally (no free credit) |
| Price | Per million tokens: input (cache miss) peak ¥2 / off-peak ¥1; input (cache hit) peak ¥0.04 / off-peak ¥0.02; output peak ¥8 / off-peak ¥4. Peak = Beijing time on working days 9:00–12:00 and 14:00–18:00; all other times are half price; weekends that are make-up working days and Chinese public holidays are off-peak all day. The official docs mention no sign-up credit for new users |
| Rate limit | The official docs give a concurrency limit of 2,500; not load-tested |
| Callable from a Cloudflare Worker? | Not tried |
| Sign-up page | https://platform.deepseek.com/ (Google sign-in works; top up first, then create a key on the "API keys" page; the key is shown only once, at creation) |

## 2. Minimal call (key as a variable, never the value)

```bash
curl -sS https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","thinking":{"type":"disabled"},"messages":[{"role":"user","content":"ping"}]}'
```

Always include `"thinking":{"type":"disabled"}`; see §5 for why.

## 3. Measured response (write what actually comes back, don't guess from the docs)

- Path to the answer text: `choices[0].message.content`; with thinking mode on, the reasoning is in `choices[0].message.reasoning_content`
- Path to the usage: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
- How long one call takes: about 1.2 seconds (4 calls measured on 09-29, 1.2–1.4 seconds)
- Can it be forced to return JSON only: yes. Add `"response_format": {"type": "json_object"}` to the request body and include the word json in the prompt. Tested by reading `RUSSELL ST CLOSED / USE SWANSTON ST`, which returned `{"notice": true, "advice": {"Russell St": "avoid", "Swanston St": "use"}}`; it parses directly with `JSON.parse`, and `finish_reason` is `stop`

## 4. Estimated cost of one demo for our use

One sign message = 4 road-user types × 3 calls each = 12 calls (the LLM only interprets the sign text and the engine computes the shares; the call count follows [`docs/hackathon/specs/T5-PRD.md`](../specs/T5-PRD.md)).
The minimal JSON prompt tested was 90 input + 26 output tokens; the real prompt has to include the vehicle speed, the reading time in seconds and the candidate road names, so estimate about 400 input + 120 output tokens per call → about ¥0.02 per message (peak price), and about ¥0.2 for 10 messages of demo preparation (about ¥0.1 off-peak). At peak prices the ¥10 balance covers about 470 messages.

## 5. Pitfalls / notes

- **Thinking mode is on by default**: without `"thinking":{"type":"disabled"}`, thinking uses up `max_tokens` first and `content` comes back as an empty string. Tested on 09-29: with `max_tokens` of both 20 and 200 the budget was used up and `content` was `""`, and it was still billed
- **Some networks block DeepSeek**: on 09-29 the network I normally use reset every connection to `*.deepseek.com` during the TLS handshake (sign-up, docs and API all failed to load); switching to a phone hotspot worked. Switch networks for local debugging; in production the Worker sends the requests and does not go through the local network, but whether the Worker can reach it has not been tested yet
- There is no free credit, so top up first; the balance and call counts are on the platform's "Usage" page, with a delay of about 5 minutes
- The Australian federal government has banned DeepSeek on government devices since 2025, so delivering to a council may require a different provider; the call layer is written to be replaceable as per T5-PRD (model name in `LLM_MODEL`), which is worth a mention in the pitch
