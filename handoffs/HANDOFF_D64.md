# Handoff D64 (planning has zero retry protection — a single transient leader hiccup kills the whole session)

## Bug (confirmed via a real live run against the tandem_hyperframe_video project)

`src/orchestrator/machine.ts:294`:
```ts
const planResult = await options.agents.plan({ request: options.request, goals: options.goals ?? [], history: options.history, attachments: options.attachments });
```
A bare `await`, no retry, no try/catch. Compare to the build step (`runOneStreamBuild`) and the
review step, both wrapped in `retryArtifact` (3 attempts) with a graceful fallback afterward
(build failure → takeover; review failure → preserve the report and end with a diagnosable
message). Planning is the only one of the three pipeline stages with zero resilience.

## What actually happened, live
Real session against `tandem_hyperframe_video` (leader `claude-code/cli`), session log confirms:
```
17:28:23 transition PLANNING "leader planning"
17:31:45 error "Claude Code permission denials: [Read C:\Users\huizh\scripts\verify-video.js (x2)]"
17:31:45 done {"error":true,"takeover":false}
```
The leader's streamed response text showed it had already composed a full, well-reasoned BuildPlan
(visible in the transcript as "I've submitted the BuildPlan...") — but the underlying
`claudeLeaderPlan()` call threw because it tried to `Read` a file at a wrong path (missing the
project subdirectory: `C:\Users\huizh\scripts\verify-video.js` instead of
`C:\Users\huizh\tmp_test_data\tandem_hyperframe_video\scripts\verify-video.js`), Claude Code CLI's
own sandbox correctly denied the out-of-project read, and `parseClaudeEnvelope` in
`src/agents/claude-code-cli/exec.ts` unconditionally throws on ANY non-empty
`permission_denials` array — no distinction between "the model tried something destructive and
was correctly blocked" and "the model made a recoverable typo in a read-only path during
exploration." Since `plan()` has no retry wrapper, that single throw ended the entire session with
`takeover:false` (takeover isn't reachable here — there's no plan to take over from yet).

This is the second time this exact class of wrong-path Read has been observed (the first time,
during a review call which DOES have retry, it self-corrected on attempt 2 and the run succeeded
normally). Same underlying leader quirk, wildly different outcome depending on which pipeline
stage it happens to hit.

## D64-1: Give planning the same retry resilience build/review already have
Wrap the `agents.plan(...)` call in `runOrchestration` (machine.ts) with the same
`retryArtifact`-style 3-attempt envelope used for build/review — reuse `retryArtifact` itself if
its signature fits (it currently takes a producer + parse function; adapt as needed for `plan()`'s
two possible result shapes, `{kind:"answer"}` vs `{kind:"plan"}`). Emit the same kind of
per-attempt error event on failure (`emit({type:"error", message: "plan failed on attempt N: ..."})`)
so a transient stumble is visible in the transcript instead of silent.

If all 3 attempts fail, end the session the same way review-exhaustion already does: don't crash
uncaught — transition to `DONE` with a clear, diagnosable summary explaining planning could not
produce a valid result after retries (there's no takeover fallback available at this stage since
no plan exists yet, so this must be a clean terminal state, not a swallowed exception).

## D64-2 (separate, smaller, optional — flag feasibility rather than necessarily build it)
Consider whether `parseClaudeEnvelope`'s unconditional throw-on-any-permission-denial
(`src/agents/claude-code-cli/exec.ts`) is too blunt. A denied READ during read-only exploration
(the model course-correcting on its own) is a different situation than a denied WRITE that
actually needed user approval. D64-1 alone (retry) already mitigates the observed failure mode
without touching this — only pursue D64-2 if D64-1's retry still isn't enough in practice, and
say so explicitly rather than making this change speculatively.

## Acceptance
tsc + `npm test` green. Add a test reproducing this: a mocked `plan()` that throws on attempt 1
(simulating a permission-denial-style error) then succeeds on attempt 2, confirming
`runOrchestration` completes normally instead of dying. Live check: re-run against a real
scenario if practical, or at minimum confirm via the new unit test that transient plan failures no
longer kill the session outright. Commit `D64-<n>:`, create `D64_done.txt`.
