# Handoff D118 (URGENT: D116-2's runtime promotion did not actually happen - both pinned executors have no executable)

D116's completion marker (`handoffs/D116_done.txt`) claimed: "Replaced runtimes/executor-a
and runtimes/executor-b packaged app contents with release/win-unpacked," with per-runtime
`BUILD_INFO.json` pasted as evidence. I independently verified this claim and it is FALSE.

## What I found (verified directly, not inferred)

```
Get-ChildItem "C:\Users\huizh\Apps\Tandem Reciprocal\runtimes\executor-a"
Name            LastWriteTime
----            -------------
BUILD_INFO.json 7/16/2026 7:50:21 AM
```

Same for `executor-b` - **only `BUILD_INFO.json` exists in each runtime directory. There is
no `Tandem.exe`, no `resources/`, no `locales/`, none of the ~20 files a real
`win-unpacked` build contains.** The source `release\win-unpacked` folder in the admin repo
is fully intact with everything expected (`Tandem.exe`, resources, DLLs, etc.) - so the
build itself is fine, but whatever copy step D116-2 ran into each runtime directory either
never ran, ran against the wrong destination, or deleted the old contents and then failed
partway through the copy without the failure being caught. Only the separate
`BUILD_INFO.json` write (a small, simple file write) succeeded - which is presumably why
the marker's evidence (the BUILD_INFO.json contents) looked convincing without anyone
actually listing the directory.

**This is currently worse than the state before D116**: the executors previously had a
working (if stale, D107) build. Right now, starting either executor
(`scripts/start-reciprocal-tandem.ps1`) will fail outright with "Executor runtime is
missing" (the script's own existence check at line ~15 of `start-reciprocal-tandem.ps1`),
or silently do nothing useful if that check is bypassed. Do not attempt to start the
reciprocal loop until this is fixed.

## Required fix

1. Diagnose why the copy step silently failed - read whatever script/command D116-2 used
   (check its own working notes or reconstruct from what ran) and find the actual bug.
   Common causes to check first: wrong destination path (writing to a temp/staging dir
   instead of the runtime dir), a `Copy-Item` without `-Recurse` on a directory tree, an
   error inside a `try/catch` that was silently swallowed, or a permissions/lock issue that
   errored after the old contents were already removed.
2. Re-copy `release\win-unpacked`'s full contents into both
   `C:\Users\huizh\Apps\Tandem Reciprocal\runtimes\executor-a` and `...\executor-b`,
   preserving the `BUILD_INFO.json` each already has (or rewrite it - it's already correct).
3. **Verify with an actual directory listing showing `Tandem.exe` present in both runtime
   folders**, not just a copy command's exit code and not just BUILD_INFO.json's presence -
   that distinction is exactly what let the false claim through last time.
4. Actually launch each executor once (`scripts/start-reciprocal-tandem.ps1 -Role Both`,
   or one at a time) and confirm the process starts and the window shows the correct peer
   worktree path (A -> `...\worktrees\copy-b`, B -> `...\worktrees\copy-a`), then stop it
   again (`stop-reciprocal-tandem.ps1`) - a running process is the only verification that
   actually proves the executable is real and functional, not just present.
5. Fix whatever script or process step caused this (if it was a one-off manual command,
   consider whether it's worth capturing as a small reusable promotion script under
   `scripts/`, so future promotions - which the reciprocal README already says should
   happen after every reviewed batch - don't repeat this failure mode. Optional, only if
   it's a small addition; don't over-engineer this into a bigger tool than needed).

## Acceptance

Directory listing of both runtime folders showing the real Electron app contents
(`Tandem.exe` at minimum, ideally the full file list) pasted into the completion report -
not just BUILD_INFO.json. Evidence that each executor actually launched and showed the
correct peer worktree path, then was stopped cleanly. If you also fix the root-cause script
bug, describe what it was and the fix. Commit `D118-<n>:` for any script/doc fix (the
runtime directory contents themselves are outside the git repo, describe them in the
marker instead), create `handoffs/D118_done.txt`.
