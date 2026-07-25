# Handoff D143 (redesign the reciprocal VALIDATE phase: mechanical checks + one leader-only review, not a full agentic peer session)

## Context and rationale (read this before touching code)

The reciprocal protocol currently runs peer validation as a FULL Tandem orchestration
session: the opposite executor triages the "validate this candidate" request as
`implementation`, its leader writes itself a BuildPlan, its worker executes
typecheck/test/diff-check and writes a CompletionReport, its leader reviews that
report, and only then does `Accept` get called. This is architecturally wrong for what
validation actually is, for two separate reasons the human and I worked through
together:

1. **Tandem's own leader/worker split already does the real validation.** The
   PRODUCING executor's own session already runs plan -> implement -> internal review
   -> (D97) authoritative verification before it ever commits a candidate. The peer
   turn is not "the first real check" - it's a second, independent-eyes check, and it
   should be sized like one.
2. **Running three mechanical shell commands through a full agentic session is
   wasteful and was the direct cause of real incidents this session** - the "turn 4
   oscillation" (executor B repeatedly re-stating an already-decided validation
   conclusion, hitting the D133 circuit breaker twice) was exactly a full agentic
   session getting confused playing what should be a simple state-machine role.

The two things peer validation genuinely needs are NOT the same size:
- **Mechanical checks** (`npm run typecheck`, `npm test`, `git diff --check`) are
  deterministic, require zero judgment, and should cost zero model tokens.
- **A scope/direction judgment** ("does this diff match its plan/step, is it the
  right size, does anything look wrong that passing tests wouldn't catch") is the one
  part that genuinely benefits from an independent leader's eyes - and Tandem ALREADY
  HAS a standalone mechanism for exactly this: `AgentFns.review(plan, report, diff) ->
  ReviewVerdict` in `src/orchestrator/machine.ts` - leader-only, no worker, no
  BuildPlan cycle. This is the primitive to reuse, not reinvent.

**Producer turns are NOT changing** - plan-then-implement-then-internal-review inside
one executor's own Tandem session already matches the leader-plans/worker-implements
design correctly. This round is scoped to VALIDATE only.

## D143-1: relay script runs mechanical checks directly, no LLM

Add a mechanical gate to `scripts/reciprocal-relay.ps1`'s `Claim` (or a new dedicated
action) that, when a candidate is pending validation, runs `npm run typecheck`, `npm
test`, and `git diff --check` as PLAIN POWERSHELL COMMANDS against the candidate in
the validating executor's own worktree - no Tandem session, no automation endpoint,
no model call. Capture pass/fail and output for each. If any fail, the candidate is
rejected/rolled back through the existing rollback lifecycle (reuse it - don't
reinvent rollback) with the real command output as the reason - still zero tokens
spent. Only if all three pass does the flow proceed to D143-2.

## D143-2: one lightweight leader-only scope review

When mechanical checks pass, invoke a SINGLE leader-only call - reusing Tandem's
existing `review()` agent function/ReviewVerdict pattern, NOT a new full orchestration
session. Investigate the cleanest way to invoke this outside the normal
plan->build->worker pipeline:
- Check whether `createLiveAgents()`'s returned `review` function can be called
  directly by a small standalone script/entry point (given a plan/step description,
  the diff, and the mechanical check results already gathered in D143-1), without
  going through `runOrchestration`'s full state machine.
- If a clean standalone entry point doesn't exist, add a minimal one (a small CLI
  command or automation-server verb that takes plan+diff+checks and returns a
  ReviewVerdict) rather than forcing this through the full triage/build/worker path.
- The review call gets: the epic plan (or step description), the actual diff, and the
  mechanical check results (so the leader isn't re-deriving "did tests pass" itself -
  it only judges scope/direction/quality, which is its actual job).
- Verdict `approve` -> call `Accept` (existing relay mechanism, unchanged). Verdict
  `revise` -> reject/rollback with the leader's specific feedback as the reason.

## D143-3: update PROTOCOL.md and both TANDEM_EXECUTOR templates

Rewrite the VALIDATE section to describe the new two-step gate (mechanical, then one
leader review call) instead of "run a full validation turn." Remove references to the
validator producing its own CompletionReport/BuildPlan for this path. Keep the
producer-turn description unchanged. Document the cost expectation explicitly (near-
zero for mechanical checks, one bounded leader call for the judgment) so future
readers understand why this is architected differently from a producer turn.

## D143-4: dashboard updates if needed

Check whether `dashboard/server.mjs`/`public/app.js` display or reason about VALIDATE-
phase turns in a way that assumes the old full-session shape (e.g. expecting a
CompletionReport artifact, a specific relay-state field only the old path set).
Update only what's actually broken by the new shape - don't redesign dashboard UI
beyond what's needed for correctness. If nothing needs to change, say so plainly
rather than making unnecessary edits.

## Constraints

- Do not change how producer turns work (plan or implement-one-step) - only VALIDATE.
- Do not weaken what gets checked - the SAME three mechanical checks plus the SAME
  kind of scope judgment must still happen; this round is about HOW they run, not
  removing any of them.
- Preserve the existing rollback/circuit-breaker/audit machinery - reuse it, don't
  duplicate or bypass it.
- The relay is currently PAUSED with a real pending candidate (`7eebb3f`, W0014's
  plan). Do not resume it yourself; validate that specific candidate under the NEW
  mechanism as your live proof (see acceptance), then leave the relay paused for the
  human to resume.

## Acceptance

tsc + `npm test` green. Live evidence required (this changes a core protocol path):
run the new VALIDATE flow for real against the actual pending W0014 plan candidate
(`7eebb3f`) - paste the mechanical check output (real command output, not summarized)
and the leader's real ReviewVerdict. Compare token/cost evidence: the old path's
typical cost for a comparable validation (cite a real prior example, e.g. from the
session logs) versus the new path's actual cost - this should be a dramatic reduction,
demonstrate it's real. Confirm a deliberate failure case still works: inject a failing
check (or use a real one if available) and confirm rejection/rollback fires correctly
with no candidate wrongly accepted. Confirm PROTOCOL.md and both executor templates
are updated and internally consistent with the new flow. Leave the relay PAUSED when
done. Commit `D143-<n>:`. Create `handoffs/D143_done.txt`.
