# LLM API candidate cards

*Archived from the hackathon (29 Sep – 1 Oct 2026). Translated from the original Chinese; superseded details are kept as they were.*

> During the event this folder was `docs/llm-apis/`; the paths in the process below are as they were then. The provider chosen was DeepSeek (`deepseek-flash`); see [`docs/architecture/sign-reading.md`](../../architecture/sign-reading.md) for how the sign reader used it.

> Each member wrote up the LLM APIs they had access to as a card here, and T5 and the lead picked a provider from the cards (D-0929-1333: "we'll decide on the LLM API later").
> **The integration code is already in place (T19)**: whichever provider is chosen, the Worker reads only three variables, `LLM_API_KEY` (secret), `LLM_BASE_URL` and `LLM_MODEL`, and any OpenAI-compatible `/chat/completions` endpoint works. The two steps to add the key and switch it on, and the table for changing provider, are in the "Connecting an LLM" section of `apps/api/README.md`. Spending has two gates: a global limit in the Worker of at most `LLM_MAX_CALLS_PER_DAY` calls a day (default 600), and only a small balance topped up with the provider. Names on the cards such as `DEEPSEEK_API_KEY` are only for your local `.env`; in production the Worker gets `LLM_API_KEY`.
> **Cards contain variable names only, never key values.** Keys live only in your own `.env`, and the deployer puts them into Cloudflare for production (D-0929-1310).
> A pasted key is blocked at commit time by the pre-commit hook (provided you have run `bash scripts/setup.sh` once); without the hook, CI only turns red after the push, **by which time the key has leaked** and must be revoked immediately.

## Rules (checked automatically by `check [3]`)

| Allowed | Not allowed |
|---|---|
| Create your own card `docs/llm-apis/<your handle>-<provider>.md` | Editing or deleting someone else's card |
| Edit or delete your own card at any time | Creating subfolders; editing `README.md` or `TEMPLATE.md` (they belong to the lead) |
| Attach a measured response `<your handle>-<provider>-response.json` (remove ids and account details first) | File names with Chinese characters or spaces, or extensions other than `.md` / `.json` |

- "Your own" = the file name starts with `<the handle in your branch name>-`, case-insensitive. Examples: `jinmingq-deepseek.md`, `unzzip-gemini.md`, `louisxie316-dotcom-qwen2.5.md`
- If two people have keys for the same provider, each writes their own card; don't edit someone else's
- Cards follow `TEMPLATE.md`; for anything you can't fill in, write "not tried" rather than leaving it blank or guessing from the docs
- Never write key values, account names or email addresses: `check [1]` and the pre-commit hook scan for them (this rule is not part of `check [3]`)

## How to submit a card (task T8; like T0, anyone can do it without claiming it)

```bash
bash scripts/setup.sh                                                     # step 0: install the hooks, once only; skip if already done
git fetch origin && git switch -c <handle>/llm-apis/T8-<provider> origin/main
cp docs/llm-apis/TEMPLATE.md docs/llm-apis/<handle>-<provider>.md        # fill in from the template
bash scripts/check.sh --quick                                             # commit only when the summary line has no ❌
git add docs/llm-apis/<handle>-<provider>.md
git commit -m "llm-apis: add <provider> card — <one line: how much free credit / why it is worth considering>"
git push -u origin HEAD && gh pr create --fill                            # only your own card changed and CI green → squash-merge it yourself
```

## Sharing keys within the team (never in the repo)

- The card states only: the environment variable name (all-caps ASCII, e.g. `DEEPSEEK_API_KEY`), who holds the key and whose credit it is
- Locally: whoever has a key puts it in their own `.env` (for local development of a Worker module, in the module folder's `.dev.vars`; see the pitfall "`env.XXX` is undefined in `wrangler dev`" in [`docs/pitfalls.md`](../../pitfalls.md)); anyone without a key uses `MOCK=1`
- To borrow someone's key: hand it over in person or through a password manager, **never in the group chat, a PR, an issue or a handoff note**
- Production: once a provider is chosen, the key owner gives the key to the deployer, @unicornnnnnny, who runs `npx wrangler secret put LLM_API_KEY` in `apps/api` (D-0929-1322; the lead as backup deployer also works); it is never written to any file
- Before making real calls, report the number of calls and the cost first (D-09), and record any spending in the credit ledger in `docs/3-tasks.md` (now [`docs/hackathon/task-board.md`](../task-board.md))
- If you suspect a key has been in git or the group chat: revoke and regenerate it in the provider's console at once, then tell the lead

## Once a provider is chosen

The lead writes the chosen provider into `.env.example` (variable names only) and into the "External APIs" section of the README of the module that holds T5, and appends a decision. The cards that were not chosen stay as alternatives.

To see which cards exist: `ls docs/llm-apis/` (there is no master table, to avoid everyone editing the same table at once and causing conflicts).

## Known limitations (the lead is aware; not fixing for now)

- Whether a card is "your own" is judged only from the start of the file name: if someone's handle were ever exactly another handle's prefix plus `-` (e.g. `louisxie316` and `louisxie316-dotcom`), the former could edit the latter's cards. None of the 5 handles on the team does this today
- The card owner is taken only from the handle in the branch name, without checking who you are; opening a branch under someone else's handle also passes. Handoff notes follow the same rule, with the PR author name as the backstop
- Purely random keys without a fixed prefix (Mistral, Cohere, Cloudflare tokens, Baidu SK and so on) are not detected when written only in a table cell or in body text (without a label such as `API Key:` or `XX_KEY=` in front). There is no "block anything that looks like a random string" rule, because it would also hit the ids in response.json files. So don't paste values to save time
