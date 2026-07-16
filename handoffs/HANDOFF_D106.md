# Handoff D106 (REVISE D105: the Claude Code CLI test fails deterministically; verification claim was false)

D105_done.txt claimed `npx vitest run tests/codex-cli.test.ts tests/claude-code-cli.test.ts`
passed 44/44 and `npm test` passed 347/348 (1 skipped). I re-ran both myself. `npm test`
fails with 1 real failure, and running `tests/claude-code-cli.test.ts` ALONE also fails
deterministically (not a flaky/ordering issue - reproduces every time):

```
FAIL tests/claude-code-cli.test.ts > claude code cli discovery > D105: cache invalidates
when the cached path no longer exists (claude background updater replaced the bundled binary)
AssertionError: expected undefined to be 'C:\bin\node_modules\@anthropic-ai\cla...'
```

## Root cause

The new test (`tests/claude-code-cli.test.ts` ~line 119) primes the cache with
`.../claude-code/bin/claude.exe`, then simulates an "updater" by making that path stop
existing while a DIFFERENTLY-NAMED file (`claude-new.exe`) exists instead, expecting the
post-invalidation re-resolution to find it. That can never happen with how
`locateClaudeCli` actually resolves paths: it calls the shared `resolveOnPath()` helper
(`src/tools/resolve-on-path.ts`), which only ever checks a FIXED list of literal filenames
(the node_modules-relative `claude.exe` path, `"claude.exe"`, `"claude"`, `"claude.cmd"| -
see `locate.ts` ~line 50-53) against each PATH directory. It has no directory-scan/pick-
newest-file fallback the way `locateCodexCli`'s `newestWindowsFallback()` does. So after
cache invalidation, re-resolution can only ever re-find one of those exact literal names -
it will never discover an arbitrarily-named replacement binary like `claude-new.exe`. The
test encodes a scenario that is structurally impossible for this resolver, so it fails
every time, not intermittently.

This also raises a real question about whether the Claude Code CLI "bonus fix" (bundled
into D105-1 per my original handoff's optional/only-if-you-find-the-same-pattern clause)
was actually addressing a real risk in the first place. The Codex CLI staleness bug was
specifically about a VERSIONED SUBFOLDER changing (`bin/<hash>/codex.exe` - the hash folder
itself changes on update, so the old file path stops existing entirely). Claude Code CLI's
locate.ts has no such hash-versioned-folder scanning - it resolves to a fixed relative path
under node_modules or PATH. If Claude Code CLI's own updater overwrites that file IN PLACE
(same filename, new content) rather than replacing it with a differently-named file, then
the cached path would still pass an `exists()` check after an update, and the self-healing
check added in D105 would never even trigger for a real update in that tool - meaning the
bonus fix may not correspond to any real observed failure mode, unlike the Codex side which
was confirmed live.

## Fix direction

Two things to resolve, and it's fine to combine them: (1) fix or remove the specific failing
test so the suite is actually green - either rewrite it to a scenario this resolver CAN
produce (e.g. cached path was the node_modules-relative `claude.exe`, it gets deleted, and a
DIFFERENT already-valid candidate from the fixed `names` list - like a plain `claude.exe` or
`claude.cmd` elsewhere on PATH - becomes reachable after invalidation), or drop the assertion
if it doesn't map to a real scenario. (2) Before spending more effort, briefly assess whether
the Claude Code CLI side of D105's fix is actually load-bearing given how that CLI's updater
behaves (in-place overwrite vs. renamed file) - if it isn't a real risk, say so plainly in
the completion report rather than leaving an untested/mis-tested change in place. Either
way, the Codex CLI side of D105-1 is solid and confirmed correct by me independently - don't
touch that part.

## Acceptance

Actually run `npm test` yourself and paste the real full pass/fail count in the completion
report - the previous marker's claim didn't hold up under a real re-run, so don't repeat
that pattern (this project has hit "verified passing" claims not holding up several times
before - see prior D41-D45 history if you want context). tsc + `npm test` fully green, no
skipped-except-the-one-pre-existing-skip. Commit `D106-<n>:`, create
`handoffs/D106_done.txt`.
