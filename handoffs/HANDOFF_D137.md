# Handoff D137 (bashTool can hang indefinitely even after its own timeout+cleanup should have fired - core bug, affects every project)

Found live: executor B's peer-validation turn for W0013 Step 2 has been stuck for 2+
hours on a single `npm test` bash-tool call. This is NOT a reciprocal/sandbox issue -
the worker here is minimax-m3 via Tandem's own SDK `bashTool` (`src/tools/shell.ts`),
the exact same code path every project's worker/leader uses for shell commands. This
can happen in the user's own regular sessions too.

## Evidence (from the real session log - re-verify, don't re-derive)

`C:\Users\huizh\Apps\Tandem Reciprocal\state\executor-b\sessions\6fd69ea03b6c\cdb0a080-dd2d-4d20-a8ab-127bb7ab3a95.jsonl`

- Tool call started: `{"type":"tool","at":"2026-07-17T19:38:55.025Z",...,"target":"cd /d \"...\\worktrees\\copy-a\" && npm test 2>&1","phase":"start"}` - no matching `"phase":"end"` event exists anywhere after it, through at least 21:31 UTC (~113 minutes).
- `git diff --check`, called immediately after in the same turn, completed normally in
  237ms - only the `npm test` call is stuck.
- I independently confirmed the underlying OS process for this command no longer
  exists on the machine (checked via `Get-CimInstance Win32_Process` - nothing
  matching). The process is gone; Tandem's own session bookkeeping still reports the
  run as active (`running:true` via the automation `/status` endpoint).
- The SAME mechanism worked correctly TWICE EARLIER in this identical session: two
  prior `npm test` invocations completed normally (full vitest summary in the output),
  then the tool's own descendant-tracker found and killed exactly one leftover worker
  process each time: `"[SYSTEM] Cleaned up 1 shell child process(es): 19524"` and
  `"...25524"`. So the cleanup path is real and does work - this is a rarer failure
  mode of the same mechanism, not a totally untested code path.
- `bashTool` (`src/tools/shell.ts`) has `DEFAULT_BASH_TIMEOUT_MS = 120000` and
  `MAX_BASH_TIMEOUT_MS = 300000` - a real timer (`setTimeout` at line ~117) that should
  force-kill the process tree and resolve/reject well before 113 minutes elapse,
  regardless of whether the awaited `execa` promise itself is healthy. It did not
  visibly fire (no "Command timed out" text, no cleanup note in this specific call).

## What to investigate

1. Reproduce a hang deliberately: run `npm test` (the real ~400-test suite, which
   spawns vitest's own worker pool) via `bashTool` directly (unit-test the function or
   drive it through a minimal harness) many times if needed to catch the rare case, or
   instrument it (temporary logging) to see whether the `setTimeout` callback at line
   ~117 actually fires and what `cleanupWindowsProcessTree`/`subprocess.kill` do when
   it does.
2. Determine precisely why the awaited `subprocess` promise from `execa(...)` can fail
   to resolve even after: (a) the timeout's kill signal fires, and/or (b) the
   underlying process independently exits on its own. Leading hypothesis: `all: true`
   merges stdout+stderr into one stream that only closes when EVERY process holding a
   handle to it closes theirs; on Windows, a `shell: true` (cmd.exe-wrapped) invocation
   of `npm test` -> `node` -> `vitest` -> vitest's worker pool can leave a grandchild
   holding that pipe open in a way the 75ms-interval descendant tracker occasionally
   misses (race: a very short-lived or very-late-spawned worker process that appears
   AFTER the tracker's last poll before the parent already exited). Confirm or refute
   with evidence, don't just patch around a guess.
3. Check whether `execa`'s `cleanup: true` option and the manual `subprocess.kill()` +
   `taskkill /T /F` calls can conflict or race (e.g., killing via taskkill while execa
   is independently also trying to clean up, leaving the stream in a state where
   neither the 'exit' nor 'close' event execa waits on ever fires).

## Fix direction (adjust once the mechanism is understood - don't guess-patch)

The awaited `subprocess` promise must NEVER be allowed to hang past the timeout,
independent of whatever a stream/pipe is doing. Consider: after the timeout fires and
kills the process tree, if `await subprocess` still hasn't resolved within a short
grace period (e.g. 5-10s), force-resolve the tool call with a synthetic timeout result
(what the code already tries to build for the normal timeout path) INSTEAD OF
continuing to await the original promise - i.e., race the awaited execa promise
against a second timer that always wins. This guarantees the tool call itself always
returns, even if the underlying execa/stream layer never truly settles. Preserve all
existing correct behavior (the two working prior calls in the same session should
still behave identically).

## Immediate operational note (do not action without the human)

Executor B is currently wedged in this exact hang (real, live, right now). Recovering
it requires stopping and restarting the executor (its checkpoint/relay design should
resume cleanly) - this is a human decision, not something to do as part of writing this
handoff. Do not restart executor B yourself as part of this round; investigate using
the session log evidence above plus your own reproduction attempts. If reproducing
requires running the real suite repeatedly and that's slow/expensive, say so and use
the fastest reliable repro you can find (a shorter but still worker-pool-spawning
vitest command may reproduce the same class of issue).

## Acceptance

Root cause explained with evidence (not guessed). Fix demonstrated: a regression that
forces a hang-like scenario (e.g. inject a subprocess that never closes its stdout
pipe even after being killed, if reproducible in a controlled test) and confirms
`bashTool` still returns within a bounded time. Confirm the two previously-working
cleanup cases (single leftover worker, normal completion) are unregressed. tsc +
`npm test` green. This is core product code - normal D-round discipline, live
verification where the bug is timing/OS-dependent should include your own repro
evidence, not just unit mocks. Commit `D137-<n>:`. Create `handoffs/D137_done.txt`.
