# Handoff D94 (fix: minimax/minimax-m3 fails as leader — narrow, well-scoped root cause found)

User reported "why cannot use minimax m3 as leader" earlier, without the error text. Reproduced
live tonight with a real orchestration run (leader=worker=minimax/minimax-m3, a simple stats task)
through the actual packaged desktop app — real, confirmed, not guessed.

## What's confirmed (don't re-derive)

`classifyPlanRequest()` in `src/agents/live.ts` (~line 222-248) is the leader's very first call
on every new request: a small `generateObject({ schema: TriageSchema, ... })` call (schema is
just `{ kind: "question" | "implementation" }`) used to route to question-answering vs. planning.
With minimax/minimax-m3 as leader, this call throws
`AI_NoObjectGeneratedError: No object generated: could not parse the response.` on all 3 retry
attempts, and the whole run terminates immediately — "Leader planning could not produce a valid
result after retries." The user never even gets to see a BuildPlan.

**This is narrowly scoped, not a general MiniMax incompatibility** — confirmed by a second live
run: setting `triage: "always-plan"` (which skips `classifyPlanRequest` entirely and hardcodes
`kind: "implementation"`, see the ternary at live.ts ~line 432-434) let the SAME minimax-m3 leader
immediately succeed at a MUCH larger, more complex `generateObject` call (the full `BuildPlan`
schema — title, objective, constraints, tasks, acceptanceCriteria, verification, all populated
correctly and sensibly for the task). The run then went on to build, hit two ordinary
self-correcting `CompletionReport` retries (ordinary review friction, not a crash), passed
review, and reached `DONE` — the worker's output (`stats.md`) was verified independently and
matched the real computed statistics exactly. So minimax-m3 handles `generateObject` fine in
general; it specifically fails on THIS ONE call.

## Likely fix, verify before committing to it

`src/agents/live.ts` already has exactly the right recovery mechanism for this class of failure —
`extractFromProse()` (~line 304-350+), built for "model reliably does the work but fails to
produce parseable structured output," already used at two other call sites (~685, ~775) but NOT
wired into `classifyPlanRequest`. The fix is almost certainly: catch the `AI_NoObjectGeneratedError`
in `classifyPlanRequest` and fall back to extracting the triage decision from whatever raw text
the model actually produced (AI SDK's `NoObjectGeneratedError` typically carries the raw model
output on a `.text` property — confirm this by inspecting the actual error object live, don't
assume the exact shape). Reuse `extractFromProse`'s pattern/helpers rather than writing new
recovery logic from scratch — this is a smaller, simpler schema than the artifacts
`extractFromProse` already handles, so it should be an easy fit, possibly even a direct call.

## What to do

D94-1: reproduce the exact failure live first (real minimax-m3 leader, a real `generateObject`
triage call) and capture the actual raw model output / error shape — confirm what `AI_SDK`
actually gives you before writing the fix, matching this project's established discipline of not
guessing fixes blind.

D94-2: add a fallback in `classifyPlanRequest` so a failed structured triage call recovers via
prose extraction (reusing `extractFromProse` or the same underlying pattern) instead of failing
the entire run. If the raw output can't be recovered as a valid `TriageKind` even via fallback,
consider defaulting to `"implementation"` (the safer of the two — worst case the leader
over-triggers full planning for a pure question, which is recoverable, vs. silently failing the
whole run) rather than throwing after retries are exhausted.

D94-3 (small, only if trivial while in this area): the failure message shown to the user
("Leader planning could not produce a valid result after retries: AI_NoObjectGeneratedError: No
object generated: could not parse the response.") gives no actionable hint that switching
`triage` to `"always-plan"` would work around it today. Not required to fix D94-2 properly, but if
D94-2 turns out to need more investigation than expected, consider surfacing that as an interim
tip in the error text.

## Acceptance

tsc + `npm test` green. A regression test for `classifyPlanRequest` using a mock/injected
generator (the function already supports `options.generator` injection for exactly this) that
simulates the `AI_NoObjectGeneratedError` failure mode and confirms the fallback recovers a valid
`TriageKind` rather than throwing. Live verification: rebuild, run a real orchestration with
leader=worker=minimax/minimax-m3 and `triage: "auto"` (the default — do NOT rely on the
`always-plan` workaround for this test, since the whole point is fixing the auto-triage path) on
a simple task, and confirm it completes without hitting `classifyPlanRequest` failures. Commit
`D94-<n>:`, create `handoffs/D94_done.txt`.
