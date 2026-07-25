# Handoff D189 (close D188's remaining traversal, retry-escalation, and persistence-proof gaps)

## Review verdict on D188

D188 is not approved. Its focused tests pass and its atomic/capped state writer,
missing-prefix recovery rejection, lifecycle failure isolation, invalid-state
handling, and obvious hidden-option rejection are useful. Three required proofs
remain incomplete:

1. **The stable-control path allowlist still accepts an immediate traversal.**
   `scripts/reciprocal-relay.ps1:641` uses:
   `^tests[\\/](?!.*(?:^|[\\/])\.\.(?:[\\/]|$))...`.
   Because the lookahead begins after `tests/`, its `^` alternative cannot match
   the immediately following `..`; independent review confirmed that
   `tests/../outside.test.ts` is accepted while deeper traversals are rejected.
   The D188 negative test uses a separate `../outside.test.ts` token, so it does
   not cover this escape. Canonicalize/validate each token so no `.`/`..` segment,
   rooted path, drive path, option, or non-test token can escape the tests tree.
   Add direct negative cases for both slash styles and quoted/unquoted immediate
   traversal. Add positive baseline-replay cases for every supported command
   family (`npm test -- ...`, `npx vitest run ...`, and `vitest run ...`), not
   only negative commands.

2. **The environment-failure test does not prove repeated-failure escalation.**
   `tests/reciprocal-supervisor.test.ts:277-314` seeds attempt 2 in future
   backoff, then manually changes `blocker.category` to `hard-blocked` at line
   309. That proves display behavior for preconstructed states, but it never
   proves repeated real `environment-failure` retry results increment attempts
   and trigger `Update-BlockerState`'s circuit breaker. Use the fake relay/call
   log from the positive retry test to drive the same fingerprint through
   attempt 1, backoff with zero relay calls, elapsed-backoff attempt 2,
   elapsed-backoff attempt 3/hard-block, and a subsequent hard-blocked poll with
   zero relay calls. Assert the exact cumulative Resume/PassiveTest call count,
   attempt count, category, next action, and no calls during backoff or after the
   hard block. Do not manufacture the hard-block category in the fixture.

3. **The mutating-save test does not compare the persisted evidence that can
   amplify.** `tests/reciprocal-relay.test.ts:1329-1357` snapshots only
   classification and failure-identity arrays. It omits the persisted command
   outputs, baseline checks, skipped controls, and other `passiveFailure`
   content, so mojibake growth could recur while this test stays green. Exercise
   several genuine state mutations that preserve the same failure evidence, then
   compare the complete normalized `passiveFailure` payload byte-for-byte (remove
   only fields intentionally documented as volatile, if any), assert the exact
   Unicode text survives, and assert state/evidence byte sizes do not grow across
   cycles. The test must fail if any persisted evidence string is re-decoded and
   expanded.

## Constraints

- Keep D188's accepted source corrections and existing passing tests.
- Do not weaken the allowlist to accommodate test convenience.
- Do not manually set the expected hard-block result; exercise the production
  retry/escalation path.
- Do not touch live relay state, W0027, the quarantined 2.05 GB state, reciprocal
  worktrees, runtimes, or dashboard deployment.
- Preserve unrelated user changes.

## Acceptance

- `handoffs/D189_done.txt` names the corrected tests and explains the exact
  traversal, retry sequence, and byte-stability assertions.
- Focused relay and supervisor suites pass, including direct positive and negative
  allowlist coverage.
- `npm run typecheck`, `npm test`, and `git diff --check` pass.
- Commit as `D189-<n>:` and create `handoffs/D189_done.txt`.
