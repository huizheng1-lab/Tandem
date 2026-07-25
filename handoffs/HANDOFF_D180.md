# Handoff D180 (Close the security and evidence gaps left by D179)

## Outcome

D179 is not approved. Keep its useful authority UI/relay plumbing and corrected
backoff ordering, but close the security hole and implement the omitted D179 tests and
lease behavior. Do not add any new policy gate or edit W0027 content.

## Confirmed findings

1. **The authority proof is readable and forgeable by the executor.** Relay stores
   `decisionProof` directly in shared `.git/tandem-relay/state.json` at
   `reciprocal-relay.ps1:1018-1032`. A worker can resolve the common Git directory,
   read that state, and call `ApproveAuthority -AuthorityProof <value>` itself.
   Hiding the field from `Status`/HTTP does not protect the file.
2. **Direction also accepts caller-fabricated proofs.** `Assert-AuthorityProof` at
   `reciprocal-direction.ps1:77-93` validates only caller-controlled JSON fields and a
   future timestamp. It never authenticates the proof against the pending relay
   request or a trusted signer. Any caller can create that file and mark the board
   approved directly.
3. **Long operations still lose lease protection.** `Test-LiveLease` rejects an
   expired lease at supervisor lines 364-369. Heartbeat calls occur only at entry and
   immediately before PassiveTest; there is no heartbeat during the updater,
   PassiveTest, or executor prompt. A valid operation lasting over 120 seconds can be
   reclaimed and duplicated.
4. **The required recovery tests remain absent.** Supervisor has only three tests; the
   sole D179 addition checks a pre-seeded backoff. Main-update still has one malformed
   JSON test. None of the required ready-reconciliation, overlap, actual failure,
   escalation/reset, long lease, startup dispatch, transaction-stage, fault-stage,
   dirty-index, or conflict scenarios exists.
5. **Policy fixture propagation is still helper-only.** No end-to-end test modifies
   taxonomy values and observes direction, relay, supervisor, API, and rendered UI.

Independent review: typecheck, nodecheck (15), authority/approval E2E (3), deployment
VerifyOnly, diff-check, and an isolated full suite (522 passed, one skipped) pass. A
parallel duplicate run caused one timeout, but the isolated rerun passed; that timeout
is not a product finding.

## Corrective work

### 1. Make human authority non-forgeable from the executor boundary

- Never persist an approval preimage, bearer token, signing secret, or reusable proof
  in relay state, either worktree, process arguments, API/status output, audit, or
  another executor-readable file. Relay state may persist only a one-way digest and
  request metadata.
- Bind approval/denial to the authenticated dashboard request using a one-time,
  request-specific mechanism that the executor cannot manufacture or replay (for
  example, process-private dashboard state plus a narrowly scoped local IPC validation
  exchange). The relay must validate request ID, decision, item, owner, authority,
  exact action, checkpoint, resume action, expiry, and one-time consumption.
- Remove direct direction-file proof trust. Direction approval/denial must be callable
  only as part of the validated relay decision transaction; arbitrary JSON supplied by
  a caller must fail. Make relay and board changes atomic/recoverable so they cannot
  disagree after a crash.
- Add adversarial tests from an executor worktree proving it cannot approve by reading
  common Git state, forging a JSON file, replaying an old grant, changing any bound
  field, invoking relay directly, or calling the API without authentication. The
  authenticated dashboard approval must still resume the exact checkpoint once;
  denial and final runtime authority stay stopped.

### 2. Keep one live supervisor owner for the whole child operation

- Add periodic lease refresh throughout every long child operation, or change reclaim
  logic so matching live PID/start-time ownership cannot be stolen merely because TTL
  elapsed. Do not allow a dead/reused PID to retain ownership indefinitely.
- Keep lease writes atomic and token-safe. A second overlapping tick during a simulated
  operation longer than TTL must return `lease-held` without changing blockers or
  dispatching work; after the owner exits, the next tick must reclaim normally.
- Ensure updater, PassiveTest, and executor-prompt failures all use the persisted
  fingerprint/backoff policy and respect the pre-action check already added by D179.

### 3. Implement the previously required end-to-end tests

Tests must invoke real scripts/process boundaries and real temporary Git repositories:

- Automatic ready reconciliation executes exactly once under overlapping ticks;
  unsafe state does not invoke it; stored backoff prevents it; repeated actual failure
  reaches the configured hard blocker; changed fingerprint/success resets it; success
  clears marker/blocker and permits queued dispatch.
- PassiveTest, endpoint/prompt, file-lock, malformed relay/supervisor state, and startup
  dispatch exercise the same real retry path. Prove single claim, long live lease,
  dead lease reclaim, and token-mismatched cleanup.
- Main updater resumes `merged-not-pushed`, `tagged-not-pushed`, and
  `pushed-not-synced`; inject every declared fault stage; preserve dirty tracked,
  staged, renamed, deleted, untracked, and space-containing paths plus exact index;
  converge without duplicate tags or force push; prove conflict changes no refs/state.
- A modified valid taxonomy fixture is observed through real direction, relay,
  supervisor, API, and rendered UI display paths. Missing/invalid fields stop safely.

Do not replace these with source-text assertions, mocks that never invoke the target
script, or a report claiming coverage without test cases.

Run focused suites, adversarial authority E2E, dashboard nodecheck, deployment
`-VerifyOnly`, `npm run typecheck`, `npm test`, and `git diff --check`.

## Preservation and safety

- Preserve W0027's board line, active role A, machine repeated-resume pause, dirty
  copy-B plan, checkpoint, and hashes. Do not resume it, clear it, or edit/commit its
  plan/product content in D180.
- Keep live source reconciliation pending while W0027 makes the boundary unsafe. Use
  isolated fixtures for safe-boundary proof.
- Preserve W0023 ordering, unrelated changes, and D174 archive. No reset, stash, broad
  clean, force push, rebase, amend, history rewrite, runtime promotion, or pinned
  runtime replacement.

Commit intended work as `D180-<n>:` and record `handoffs/D180_done.txt` separately.
List the exact new test names for every scenario above; do not mark D180 done while any
required scenario lacks a passing executable test.
