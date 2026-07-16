# Handoff D103 (make worker step-budget exhaustion self-correcting instead of a static number)

Follow-up to D102. D102 raised the shipped default `maxStepsPerAgentTurn` from 60 to 150,
which helps but doesn't really fix the underlying problem: it is still a single static
number every project either inherits or has to discover-and-hand-tune after hitting
failures (exactly what happened on the real Age of Empire project - see [[D101]]/[[D102]]
history). The user's own framing: "why does maxStepsPerAgentTurn depend on the session?
shouldn't it be baked into tandem for all projects?" The right fix isn't a bigger constant,
it's making the orchestrator adapt when it detects genuine step-budget exhaustion, so no
one has to guess a number that fits every project's task complexity up front.

## Scope

SDK-backed worker builds only (`src/agents/live.ts`'s inline `build` implementation,
~line 666-689). Codex CLI and Claude Code CLI worker paths (`src/agents/codex-cli/`,
`src/agents/claude-code-cli/`) have no `maxSteps` concept at all (grepped, confirmed empty)
- they run until their own subprocess exits, so this doesn't apply there. Leave those
untouched.

## D103-1: detect step-exhaustion failures distinctly from other build failures

Currently `src/agents/live.ts:688` throws a generic
`new Error("Worker finished without submit_completion_report. Retry with an explicit report.")`
whenever `runAgentArtifact` returns no artifact (this fires both when the model genuinely
ran out of steps AND for other reasons the nudge in `runAgentArtifact` - src/agents/runner.ts
~line 375-390 - didn't produce an artifact). Distinguish the step-exhaustion case
specifically: `runAgentArtifact`'s result already has `stepsUsed`; you know the configured
`maxSteps` was passed in. Throw a distinguishable error (e.g. a small custom error class,
or at minimum a detectable message prefix) only when `result.stepsUsed >= maxSteps` (steps
were actually exhausted) as opposed to other paths that could leave `artifact` undefined.

## D103-2: escalate the step budget on retry when the failure was step exhaustion

`runOneStreamBuild` in `src/orchestrator/machine.ts` (~line 179-210) calls `retryArtifact`
with a producer that gets `previousError` on each of its 3 attempts, but always builds the
SAME `agents.build(...)` input regardless of what the previous error was - so a genuine
step-exhaustion failure just retries with the identical budget and fails identically. When
`previousError` is the distinguishable step-exhaustion error from D103-1, thread an
escalated step budget into the next `agents.build(...)` call (a new optional field on the
`BuildStreamInput` the `AgentFns.build` interface takes, e.g. `stepBudgetMultiplier`).
`live.ts`'s build implementation should use
`Math.round(options.config.maxStepsPerAgentTurn * (input.stepBudgetMultiplier ?? 1))` for
its `maxSteps` instead of the raw config value.

**Think carefully about the escalation schedule and total ceiling before picking numbers** -
don't just multiply every retry by an arbitrary factor. A genuinely-stuck task (not a
budget problem, e.g. a task that's actually impossible or the model is looping) will
consume proportionally MORE tokens/cost each time you raise the ceiling, and this project's
existing 3-attempt-then-takeover envelope was sized assuming a roughly constant per-attempt
cost. Consider bounding the *total* steps spent across all 3 attempts of one stream build
(e.g. attempt 2 gets 2x only if attempt 1's failure was genuinely step-exhaustion, attempt 3
gets at most 3x, hard cap around there) rather than letting it compound unbounded, and only
escalate when the previous failure was specifically step-exhaustion - a non-exhaustion
failure (e.g. a real error, a validation failure) should keep the original budget on retry,
not get a free budget increase it doesn't need.

## D103-3: emit a notice when escalating

Emit a `notice` event (matching the pattern already used for [[D101]]'s takeover
verification warning) when a retry uses an escalated budget, e.g. `"stream <id> ran out of
steps on attempt N (used X/Y); retrying with an increased budget"`. This makes the behavior
visible in session logs instead of silent, so a user (or future me) can tell step-budget
escalation happened without re-deriving it from raw tool-call counts the way I had to for
D102's investigation.

## Acceptance

tsc + `npm test` green. Regression with a scripted build agent that fails with the
step-exhaustion error on attempt 1 with a small declared budget, succeeds on attempt 2 with
a larger one, confirming: (a) the escalated `stepBudgetMultiplier`/step count is actually
higher on the retry, (b) the notice event fires, (c) a SEPARATE regression confirms a
non-step-exhaustion failure (e.g. a thrown validation error) does NOT get an escalated
budget on its retry - budget escalation must be conditioned specifically on the
step-exhaustion signal, not applied to every retry. No live model call required - this is
pure control-flow logic, testable by scripting `AgentFns.build` in the harness the same way
existing `tests/orchestrator.test.ts` cases already do. Commit `D103-<n>:`, create
`handoffs/D103_done.txt`.
