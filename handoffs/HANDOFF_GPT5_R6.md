# Handoff to GPT-5 — Round 6 (live failure in review fallback)

Context: R5 offline review APPROVED (25 tests, /help accurate, smoke test correctly tightened).
But live run 8 FAILED: Gemini 2.5 Pro (leader) again wrote its review verdict as prose without
calling `submit_review` (3/3 attempts), and the prose-extraction fallback (`extractFromProse` in
`src/agents/live.ts`) failed every time too — silently. Note runs 5–7 passed, so Gemini's direct
tool call succeeds sometimes; the fallback is the safety net and it is not working live. Your
unit tests mock the generator, so the real `generateObject`-against-Gemini path is untested.

## R6-1: Make fallback failures diagnosable (do this first)
`extractFromProse` catches the `generateObject` error and rethrows `originalError`, discarding
the actual cause. Change it to attach the underlying failure, e.g. throw
`new Error(\`${originalError.message} Fallback extraction also failed: ${String(cause)}\`, { cause })`,
and (where a machine `emit` is reachable) surface it as an error event. Update the unit tests.

## R6-2: Fix the real generateObject failure against Gemini
With R6-1 in place the reviewer will re-run live to capture the true error. Investigate likely
causes now, in this order:
1. Schema conversion: `ReviewVerdictSchema` uses `z.number().min(1).max(5)` and `z.enum`;
   check what `@ai-sdk/google` supports in `responseSchema` conversion for the installed version.
2. If schema-constrained generation is the problem, add a second-tier fallback that avoids schema
   conversion entirely: plain `generateText` asking for JSON only, then `JSON.parse` +
   `ReviewVerdictSchema.parse`. Chain: submit tool → generateObject → JSON-text parse → fail.
3. Also harden the reviewer prompt in `src/agents/live.ts`: state explicitly that prose verdicts
   are discarded and the turn is only complete when `submit_review` has been called.
Add unit tests for the new fallback chain (mock all generators; cover: generateObject fails →
JSON-text succeeds; both fail → combined error message).

## R6-3: Optional resilience — review failure should not kill the pipeline
Today, three failed review attempts throw out of `runOrchestration` (by design: leader failure →
surface to user). Given review is the flakiest phase, add a kinder terminal state: catch review
retryArtifact exhaustion in `machine.ts` and end with phase DONE, `takeover: false`, and a summary
that tells the user the build completed but the automated review could not be finalized, with the
last worker report attached. Unit-test it. Keep the thrown-error behavior for the PLANNING phase.

## Acceptance
tsc + `npm test` green; one commit per task (`R6-<n>:`); the reviewer will run the live smoke
test after R6-1/R6-2 land and expects either a pass or a diagnosable error message.
