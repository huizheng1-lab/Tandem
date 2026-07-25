# Handoff D179 (Finish D178 with executable, tested behavior only)

## Outcome

D178 is not approved. Complete only the missing D178 behavior below. Do not add new
policy gates, workflow layers, or approval classes. Preserve W0027 and do not edit or
commit its plan/product content.

## Confirmed gaps

1. **Authority is still a board-only mutation.**
   `scripts/reciprocal-direction.ps1:515-550` directly declares, approves, and denies
   metadata. `ApproveAuthority` has no trusted-human guard. Neither
   `reciprocal-relay.ps1` nor dashboard server/UI contains an authority action or relay
   authority checkpoint. Candidate creation merely changes approved to consumed at
   `reciprocal-direction.ps1:574-578`; it does not resume or consume an exact relay
   checkpoint once. This does not satisfy the requested relay/audit/API/UI lifecycle
   and allows automation to call the same approval action as a human.
2. **Reconciliation ignores its own backoff.**
   `continue-reciprocal-automation.ps1:513-517` invokes ready reconciliation before
   `Test-BackoffReady` at lines 519-541. A failure records `nextAttemptAt`, but the next
   recurring tick invokes reconciliation again before checking it. Move the common
   backoff/hard-block decision ahead of every retryable action, including source
   reconciliation; diagnostic retry remains the only explicit bypass.
3. **Other controller failures and lease longevity remain unhandled.**
   PassiveTest at lines 543-569 can throw outside the persisted retry path. The lease
   heartbeat is refreshed only once at line 499, not during a long passive test,
   updater, or executor prompt. State/JSON/file-lock/startup failures likewise are not
   demonstrated through the common policy.
4. **The required integration tests were not added.**
   `tests/reciprocal-supervisor.test.ts` still has only the two D176/D177 tests.
   `tests/reciprocal-main-update.test.ts` has one test and checks malformed JSON only.
   There is no test invoking automatic ready reconciliation, overlap/one-shot behavior,
   unsafe deferral, backoff, real failure escalation/reset, long lease, startup
   dispatch, any updater fault stage, transaction-stage recovery, dirty index
   preservation, or conflict immutability. The authority tests mutate only the board;
   no authenticated dashboard-to-relay lifecycle is tested.
5. **Taxonomy remains partly duplicated.** Supervisor prompt results/errors still use
   literals at `continue-reciprocal-automation.ps1:448-463`; display strings/origins
   are also hard-coded. The canonical file has no display mapping, so the claimed
   fixture propagation through API/UI was not implemented or tested.

Independent review passed 43 focused tests, nodecheck, two existing approval E2E
tests, deploy VerifyOnly, typecheck, 520 full tests with one skipped, and diff-check.
Those results do not cover the missing behavior above.

## Corrective work

### A. One trusted, single-use authority checkpoint

- Add relay state/actions for declare, approve, and deny of one exact authority request
  containing item ID, owner, authority kind, exact action, checkpoint, and resume
  action. Declaring must preserve ownership/progress and pause that checkpoint once.
- Add explicit-human dashboard API/UI approve and deny controls using the dashboard's
  existing authenticated/confirmed control boundary. Write audit entries for declare,
  decision, and consumption.
- Prevent executor/supervisor/direct untrusted calls from invoking approval. The
  direction helper may perform the board mutation only when called from the trusted
  human control path with a short-lived request-bound proof that is validated against
  the pending relay request; do not use a static environment escape hatch.
- Approval must atomically match board and relay metadata, remove the hard gate, resume
  the same owner/checkpoint once, and mark it consumed at the first successful
  continuation boundary. A second tick/call must be an idempotent no-op, not another
  resume. Denial stays stopped. Final runtime replacement remains separately gated.

### B. Make retries and lease ownership real

- Evaluate persisted hard-block/backoff before source reconciliation, passive test,
  endpoint/prompt, or other automatic retries. A ready marker before `nextAttemptAt`
  returns `retry-backoff` without invoking the updater or consuming a transition.
- Route recoverable passive-test, updater, endpoint/prompt, file-lock, and state/JSON
  failures through the same fingerprint counter. Reset only after a real successful
  transition or changed fingerprint. Invariant corruption must stop truthfully rather
  than loop.
- Maintain the lease during long child operations with a safe heartbeat mechanism, or
  validate live owner PID/start time independently of TTL before reclaim. Preserve
  token-safe cleanup and one-owner execution.
- On successful automatic reconciliation, verify source/stable/branches, clear the
  marker and blocker, then permit normal idle dispatch without another handoff/click.

### C. Finish canonical policy consumption

- Add display mappings needed by supervisor/API/UI to the canonical taxonomy and load
  them in every consumer. Replace remaining gate category/code/origin/display literals,
  including supervisor lines 448-463. Validate all fields strictly.
- A modified fixture must be observed through real direction, relay, supervisor, API,
  and rendered UI status paths; missing/invalid fields fail safely.

### D. Add the tests D178 required

Use real process boundaries and temporary Git repositories. Tests must prove behavior,
not merely source strings or fixture schema:

- Authenticated dashboard declare/approve/deny -> relay + board + audit, exact
  checkpoint resume once, direct self-approval rejected, repeat approval/tick no-op,
  denial sticky, runtime authority still gated.
- Ready reconciliation executes once under overlapping ticks; unsafe state does not
  invoke it; stored backoff prevents invocation; configured repeated failures hard
  block; successful/changed-fingerprint transition resets; success clears marker and
  allows queued dispatch.
- Real passive-test/prompt/file-lock/malformed-state failures use the same policy;
  startup queued dispatch is single-claim; live long operation cannot be stolen; dead
  owner is reclaimed; mismatched cleanup is harmless.
- Invoke `reciprocal-main-update.mjs` in real temporary repositories for
  `merged-not-pushed`, `tagged-not-pushed`, and `pushed-not-synced`, every declared
  fault stage, dirty tracked/staged/renamed/deleted/untracked files including spaces,
  exact index preservation, retry convergence without duplicate tags/force push, and
  a conflict that changes no refs/state.
- Modified canonical taxonomy values reach each real consumer and UI display.

Run focused suites, dashboard nodecheck and authority/approval E2E, deployment
`-VerifyOnly`, `npm run typecheck`, `npm test`, and `git diff --check`.

## Live preservation and safety

- Preserve the current W0027 board line, active role A, machine repeated-resume pause,
  dirty copy-B plan, checkpoint, and their hashes. Do not resume/clear it in D179.
- Keep source reconciliation pending while that live boundary is unsafe. Prove the
  automatic safe-boundary path in isolation; do not claim live convergence unless it
  actually occurs safely.
- Preserve W0023 ordering, unrelated user changes, and D174 archive. No reset, stash,
  broad clean, force-push, rebase, amend, history rewrite, runtime promotion, or pinned
  runtime replacement.

Commit intended work as `D179-<n>:` and record `handoffs/D179_done.txt` separately with
exact commits and evidence for every required scenario. Do not report a scenario as
implemented unless its end-to-end test exists and passes.
