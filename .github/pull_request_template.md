<!--
Title: <module>: <what changed, imperative> -- e.g. "engine: cap detour share at junction capacity"
Use the module name as the prefix (sim, roads, web, engine, api, params, site, sumo), or docs / ci / scripts.
Never include keys, tokens, passwords or personal details anywhere in this PR (screenshots and logs included).
-->

## Summary

<!-- One or two sentences: what this PR does and why. Link the issue it closes, if any (Closes #123). -->

## Changes

<!-- The main changes, as a short list. Call out anything that changes a module interface (docs/reference/interfaces.md). -->

-

## How it was tested

<!-- Commands you ran and their results. Paste the check summary line verbatim, e.g.:
     $ bash scripts/check.sh --quick
     ======== Summary 0 ❌ 0 ⚠️
     For UI changes, attach a desktop and a 375 px wide screenshot. -->

```
$ bash scripts/check.sh --quick

```

## Checklist

- [ ] Changes stay within one module, or the cross-module change is explained above
- [ ] `bash scripts/check.sh --quick` reports 0 ❌ (summary line pasted above)
- [ ] Tests added or updated for behaviour changes; every `test.sh` still ends with `N passed, M failed`
- [ ] Docs updated where behaviour or interfaces changed (module README, `docs/reference/interfaces.md`)
- [ ] No keys, tokens or personal information (including in screenshots and logs)
