# Handoff D108 (leader silently answers instead of submitting a BuildPlan, even when triage says implementation)

User report: on the "three kingdoms" project, explicitly wrote "The leader has to write a
build plan and the worker has to code" - and the leader still ended the turn with a plain
answer, no BuildPlan, no worker build. I independently verified this against the real
session log (`C:\Users\huizh\.tandem\sessions\3f06666ea326\6ef2c9cb-...jsonl`, leader =
minimax/minimax-m3 via the SDK path, confirmed by the `dollars:0` cost events matching a
model with no configured costHints).

## This is NOT a token/context/step-limit failure

No timeout, no max-tokens error, no context-overflow error, no rate-limit error, no
AbortError anywhere near the event. The turn ran ~4 minutes with real tool activity. This
is a real, reproducible control-flow bug, not a resource-exhaustion incident.

## Root cause (confirmed by reading the code, not just the log)

`src/agents/live.ts`'s `plan()` implementation:
- Triage runs first (`classifyPlanRequest`, ~line 509-520). For this exact turn, triage
  correctly returned `"implementation"` (matches the "notice: triage: implementation"
  event in the log at 04:10:04, immediately after the user's explicit request at 04:10:00).
- The implementation branch (~line 563-617) runs a retry loop (3 attempts) calling
  `runAgentArtifact` with `stopToolName: "submit_build_plan"`.
- At **line 603**: `if (!result.artifact) { ...; return { kind: "answer", answer }; }` -
  if the model's agentic loop ends WITHOUT ever calling `submit_build_plan` (which is
  exactly what happened: the leader did real investigation, drafted full plan-shaped prose
  - problem statement, constraints, even a verification command list - then literally wrote
  "Now let me write the BuildPlan:" and stopped), this line converts that leftover prose
  into `{ kind: "answer" }` and returns **immediately, on the first attempt** - it does NOT
  enter the retry loop that already exists in this same function (that loop only retries
  when a SUBMITTED plan fails `validateBuildPlan`, never when no plan was submitted at all).
- `src/orchestrator/machine.ts` **line 397**: `if (planResult.kind === "answer") { transition
  "DONE", "leader answered without build plan"; return ...; }` - accepts `kind: "answer"`
  unconditionally. There is no way for machine.ts to tell "this was legitimately triaged as
  a question" apart from "this was triaged as implementation but the leader failed to call
  the tool" - both collapse to the identical `{ kind: "answer" }` shape.

Confirmed this is NOT a one-off: `grep -c "leader answered without build plan"` on that one
session log returns **11 occurrences**. I spot-checked several: at least 3 (including the
user-reported one) were triaged `"implementation"` from an explicit, unambiguous
implementation request and ended the same way - real investigation, plan-shaped prose,
missing tool call. (One of the 11 occurrences was legitimately `triage: question`, e.g. "is
this a bug?" - that one is CORRECT behavior and must keep working exactly as-is.)

Also checked: the existing D98-5 nudge mechanism in `runAgentArtifact`
(`src/agents/runner.ts` ~line 375-392, forces the tool call via `toolChoice` when
`remainingSteps > 0`) is real and already present, but only fires once and only if steps
remain - it does not explain or fix the retry-loop gap in `live.ts`'s `plan()` itself.

Scope confirmed SDK-only: I checked `src/agents/codex-cli/leader.ts` and
`src/agents/claude-code-cli/leader.ts` - both get a single schema-validated JSON response
(`kind: "question" | "implementation"` with the corresponding field required by the
schema), not an open agentic tool-calling loop, so the model cannot silently end without a
plan the same way. No changes needed there.

## Fix direction

In `live.ts`'s `plan()`, when triage is `"implementation"` and `result.artifact` is
undefined (line 603), do NOT immediately return `{ kind: "answer" }`. Instead, treat it the
same way the existing loop already treats a submitted-but-invalid plan: set
`validationFeedback` to something like "You classified this as implementation and were
required to call submit_build_plan with a real BuildPlan - you ended without calling it.
Call submit_build_plan now with your BuildPlan; do not just describe it in prose," and let
the same 3-attempt `for` loop retry. Only after all 3 attempts of the implementation branch
still produce no artifact should this fail - and it should fail the same clean way
`retryArtifact`'s exhaustion already does elsewhere (throw, so `machine.ts`'s existing
catch at ~line 388-396 turns it into "Leader planning could not produce a valid result
after retries" - already a clear, diagnosable terminal state, not a silent fake answer).
Do NOT touch the `triageKind === "question"` branch (~line 527-561) - returning
`{ kind: "answer" }` there is correct and must keep working unchanged.

## Acceptance

tsc + `npm test` green. Regression: script a fake leader model/tool-runner (matching this
file's existing test-injection patterns) that, when triage is "implementation," never calls
`submit_build_plan` on attempt 1 but does call it on attempt 2 - confirm the plan is
retried and returned as `{ kind: "plan" }`, not surfaced as an early answer. A second
regression: the same fake model NEVER calls `submit_build_plan` across all 3 attempts -
confirm the caller sees a thrown/rejected result (not a silent `{ kind: "answer" }`), and
that `machine.ts`'s existing "Leader planning could not produce a valid result after
retries" path is what surfaces it. A third regression confirms the untouched
`triageKind === "question"` path still returns `{ kind: "answer" }` immediately without
retries (prevents this fix from accidentally forcing plans onto real questions). No live
model call required - this is pure control-flow logic around an injectable agent runner,
same style as the existing `runOneStreamBuild`/step-exhaustion tests in
`tests/orchestrator.test.ts`. Commit `D108-<n>:`, create `handoffs/D108_done.txt`.
