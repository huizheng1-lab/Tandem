# Handoff D153 (reciprocal process should build the Electron package itself - stop requiring a human to manually run `npm run dist:app`)

## Why (real friction, not hypothetical)

This session, the human operator (me, the reviewing architect, standing in for the
actual human) manually ran `npm run dist:app`/`electron-builder` three separate times
to unblock `PrepareAUpgrade`/`CompleteAUpgrade` and the dashboard's `Launch Candidate`
preview, because nothing in the reciprocal pipeline produces the packaged Electron app
on its own. `PassiveTest` (D151) only runs `npm run build` - the `tsup` CLI/library
bundle - never the actual `electron-builder` app package. Two concrete failures
resulted directly from this manual gap:

1. Manual builds kept landing in throwaway directories (`release2`, `release3`,
   `release4`) to dodge a recurring Windows file lock (`EBUSY: resource busy or
   locked, unlink .../resources/app.asar`, hit on nearly every rebuild of a
   previously-used output directory - looks like transient antivirus/indexer scanning
   of the freshly-written `.asar`), while the dashboard's `Launch Candidate` feature
   (`server.mjs:20-21`, `candidateSource`/`candidateExe`) reads from a **hardcoded**
   `<repoRoot>/release/win-unpacked` path. The two never lined up automatically.
2. The human tried to use `Launch Candidate` to review the finished W0014 search
   feature and it silently showed a **build from 2026-07-17** (`583fff3`) - two days
   stale, completely unrelated to the actual accepted candidate - because nobody had
   ever built into the canonical path. This is exactly the kind of silent-wrong-content
   failure D152 was supposed to prevent, and it happened because the artifact D152's
   review note depends on was never actually produced.

## What to build

Make the reciprocal process build the Electron package itself, automatically, with no
human ever running `npm run dist:app` by hand:

1. **Add the Electron packaging step to `PassiveTest`** (`scripts/reciprocal-relay.ps1`,
   the mechanical check list around line 1024-1032) - either as one more command in the
   existing `$checks` array alongside `npm run typecheck`/`npm test`/`npm run
   build`/the diff-check, or as a distinct step immediately after those checks pass and
   before `PASSIVE_ACCEPTED` is written. Either placement is fine; the requirement is
   that by the time `PASSIVE_ACCEPTED` returns, a real, working packaged app exists on
   disk for that exact accepted commit.
2. **Write the output to the canonical path Launch Candidate actually reads**:
   `<repoRoot>/release/win-unpacked` in the admin repo (`C:\Users\huizh\Apps\HZ code`),
   matching `server.mjs`'s hardcoded `candidateSource`/`candidateExe`
   (`server.mjs:20-21`) - not a worktree-local `release/` folder. `PassiveTest` itself
   runs from the passive worktree (`copy-a`); build there and copy/sync the resulting
   `win-unpacked` folder (plus a `BUILD_INFO.json` stamped with the accepted
   `sourceSha`, matching the shape `scripts/stamp-app-build.mjs` already produces) into
   that admin-repo path as the last part of the step.
3. **Make the build robust to the observed file-lock flakiness.** Do not build directly
   on top of the previous output. Build to a fresh or temp-suffixed directory each time,
   verify `Tandem.exe` exists in the fresh output, then atomically replace the old
   `release/win-unpacked` (rename-swap, or delete-with-bounded-retry then move) rather
   than letting `electron-builder` try to `unlink` a possibly still-locked prior
   `app.asar` in place. If a lock is still held after a short bounded retry, fail the
   step clearly (mechanical check failure, same as a failed test) rather than silently
   leaving a stale build in place - a clear failure is far better than what happened
   here, where a stale unrelated build sat there silently passing as "the candidate."
4. **Let `promote-reciprocal-runtime.ps1` reuse this same build** instead of requiring
   its own separate build step - it already defaults `-Source` to
   `<repoRoot>/release/win-unpacked` (`promote-reciprocal-runtime.ps1:21-23`), so once
   step 2 lands there should be nothing left for the human A-upgrade confirmation to
   build; `PrepareAUpgrade -DryRun` and `CompleteAUpgrade` should just work against
   whatever `PassiveTest` already produced.
5. **Re-check D152's `previewReady`/review-note logic** (`server.mjs:487-513`,
   `reviewNoteForRelay`) once this lands - it currently treats "does the release build's
   sourceSha match stableCommit" as a real uncertainty and has a whole fallback message
   for the mismatched case ("release/win-unpacked still contains X; build the matching
   preview before launching"). Once builds are automatic and always match, that
   fallback path should rarely if ever fire - keep it as a safety net (don't delete it;
   if the automated build step ever fails, that's exactly when this message should
   still correctly warn), but don't leave dead/misleading UI copy implying a manual
   build step is still the normal path.

## Constraints

- Do not weaken or make automatic the actual human `CompleteAUpgrade` confirmation -
  this handoff only automates producing the *build artifact*, never the decision to
  promote it into Executor A's live runtime. That gate, and the "human reviews
  functional behavior, not code" principle behind it (D152), are unchanged.
- Do not let a slow/failing package build block or corrupt the mechanical typecheck/
  test/diff-check gates that already work correctly - if packaging is added as its own
  step after those checks, a packaging failure should pause the relay the same way a
  failed mechanical check does today (`PASSIVE_FAILED`, pausing from `passive-testing`
  with a clear reason), not silently skip past it.
- Do not change what "clean worktree" means for `Assert-Clean` in a way that makes a
  genuinely dirty producer worktree pass - only the build/staging directories
  themselves need lock-safe handling; this is not license to relax cleanliness checks
  generally.

## Acceptance

Explain in `handoffs/D153_done.txt` where in the lifecycle the build step was added and
how the lock-safety (fresh-directory-then-swap, bounded retry) was implemented. Live
proof: trigger a real `PassiveTest` acceptance and show, without any human running
`npm run dist:app` by hand, that `C:\Users\huizh\Apps\HZ code\release\win-unpacked`
ends up with a working `Tandem.exe` and a `BUILD_INFO.json` whose `sourceSha` matches
the newly-accepted `stableCommit` - then show the dashboard's `Launch Candidate`
actually launching that exact build (not a stale one). Also show
`PrepareAUpgrade -DryRun`/`CompleteAUpgrade` working against that same build with no
separate manual build step. tsc + `npm test` green. Commit `D153-<n>:`. Create
`handoffs/D153_done.txt`.
