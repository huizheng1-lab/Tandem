# Handoff D183 (Unify D182 recovery state and prove the real running-B path)

## Outcome

Correct only the remaining D182 lifecycle and verification gaps. Preserve the accepted
A-only producer model, dashboard topology, durable stage vocabulary, existing human
approval, and unrelated D181/D182 work.

There must be one authoritative recovery record from candidate packaging through
verified B, approved A replacement, and final B shutdown. The dashboard must adopt and
reconcile the B instance that the relay already verified; it must not try to overwrite
that running runtime. Tests must exercise real isolated child processes and loopback
endpoints rather than shipped bypasses or command mocks.

## Actionable D182 gaps

1. `scripts/reciprocal-relay.ps1:1619-1707` starts B, marks relay state
   `b-runtime-verified`, and leaves B running before the human gate.
   `dashboard-source/reciprocal-control-panel/server.mjs:1407-1416` instead creates a
   separate journal at `package-ready`, then
   `server.mjs:1509-1527` attempts to promote and start B again.
   `scripts/promote-reciprocal-runtime.ps1:83-86` correctly refuses to overwrite a
   running B. Therefore the real approval path fails before A replacement; the mocked
   E2E path hides this.
2. `scripts/start-reciprocal-tandem.ps1:182-219` reads only
   `state/runtime-recovery-flow.json`. Before the first dashboard approval that file
   does not exist even though relay state already says `a-upgrade-pending` /
   `b-runtime-verified`. A phase-aware `Role=Both` invocation falls through to normal
   A-only reconciliation and stops the verified B recovery authority.
3. `scripts/reciprocal-relay.ps1:1621-1632` ships
   `TANDEM_RECIPROCAL_TEST_B_READY`, which writes a fake token and skips the real B
   loopback check. `tests/reciprocal-relay.test.ts:121-135` uses that bypass for
   acceptance. This does not meet the required real endpoint/process test and is an
   unsafe verification bypass in production source.
4. `dashboard-source/reciprocal-control-panel/server.mjs:1538-1549` verifies an
   on-disk `BUILD_INFO` and endpoint target, but does not bind the endpoint PID to the
   expected executable, prove endpoint-reported runtime identity/source/capability, or
   verify the same immutable package identity used for B and A.
   `packageIdentity` at `server.mjs:1409` is a descriptive string, not a verified
   cryptographic package identity.
5. `server.mjs:277-280` silently treats an unreadable recovery journal as absent.
   Candidate/journal mismatch also starts a new flow instead of failing closed.
   Journal writes do not enforce monotonic stage/source/package binding.
6. The only dashboard crash test,
   `approval-flow.e2e.mjs:386-425`, crashes after the durable `a-stopped` step.
   It does not cover every stage, operation failures, or a crash after an external side
   effect but before its post-operation stage is persisted.
7. `tests/reciprocal-setup-script.test.ts:16-74` proves a stale B child is stopped but
   does not prove the newly launched A child remains alive/healthy. Executor commands
   in dashboard E2E remain mocked, and no tests independently reject wrong B source,
   worktree, capability, token/process identity, or package identity.

## Required corrective work

### 1. One authoritative journal across relay and dashboard

- Create/adopt the durable recovery journal during candidate packaging, before B
  promotion. The relay and dashboard must use the same schema, source SHA, package
  identity, stage ordering, and atomic-write rules.
- When passive acceptance reaches `b-verified`, the shared journal must contain the
  actual verified B proof. The subsequent approval request must load, validate, and
  continue that record; it must not create a second `package-ready` flow.
- If exact B is already running and verified, approval must reuse it. Do not re-promote
  or restart B. If reconciliation proves B is absent, stale, or wrong, recover only
  through a safe idempotent stage transition while A remains online.
- Phase-aware startup and dashboard controls must consult the same authoritative
  journal. An `a-upgrade-pending` / `b-verified` state must preserve A and B while
  awaiting approval. It must never classify B as stale merely because approval has
  not yet been clicked.
- Remove or migrate duplicate `runtimeRecoveryStage` authority so relay state and the
  journal cannot disagree silently. If both fields remain for compatibility, define
  one authority and fail closed on disagreement.

### 2. Fail-closed, cryptographically bound recovery proof

- Replace the descriptive package identity with a reproducible cryptographic identity
  for the immutable packaged runtime (for example a signed/hashed manifest covering
  managed runtime files plus exact source SHA and required capabilities).
- Persist that identity before B promotion. Verify B was promoted from that package,
  and verify A is later promoted from the identical package—not merely a directory
  currently named `release/win-unpacked`.
- Bind each real automation endpoint to:
  - the expected PID and process executable under the expected runtime directory;
  - the expected token file/port;
  - the expected allowed project/worktree;
  - exact source SHA, package identity, and required Reciprocal capabilities reported
    by the running runtime or a process-bound attestation.
- On-disk `BUILD_INFO` alone is insufficient because it can disagree with the running
  process.
- An unreadable, unknown-version, non-monotonic, source-mismatched,
  package-mismatched, or conflicting journal must produce one actionable blocker and
  preserve the known-good executor. Never silently treat corruption as no journal or
  overwrite an active record for a different candidate.
- Enforce monotonic stages and legal transitions in the writer itself. Reconciliation
  may repeat an idempotent side effect, but it may not regress or skip proof.

### 3. Remove verification bypasses and make recovery genuinely idempotent

- Remove `TANDEM_RECIPROCAL_TEST_B_READY` and any equivalent production-source path
  that fabricates readiness or skips HTTP/process/package verification.
- Use injectable isolated executable/endpoint fixtures at the process boundary, not
  conditional success branches in application scripts.
- Reconcile every ambiguous pre/post boundary against actual state:
  B promotion/start/verification, approval record, A stop/promotion/start/verification,
  relay completion, and B stop.
- A crash after promotion copied files but before `*-promoted` persistence must not
  create another destructive backup or overwrite the previous stable A backup.
  Persist and verify operation identities/backup paths so retries converge.
- A crash after process start/stop but before the post-stage must detect the actual
  process and advance or safely repeat without leaving both executors offline.
- Preserve B online after any A-side failure. Stop B only after exact A process and
  package verification plus durable relay completion.

### 4. Keep dashboard truth aligned

- Derive topology from the shared journal and reconciled process proof.
- Awaiting approval after passive acceptance must show exact verified B and known-good
  A online. It must not display or enable an action that re-promotes running B.
- Surface journal corruption/mismatch and failed attestation explicitly. Do not
  silently offer a normal approval or Kickstart path.

## Acceptance tests

Use only isolated temporary relay roots, repositories, runtime directories, worktrees,
ports, tokens, and child processes. Do not touch the live W0027 executors, dashboard,
relay state, or worktrees.

1. Run the real passive-acceptance path with a real isolated B executable and real
   authenticated loopback endpoint. Prove the gate appears only after B process,
   endpoint, target, source SHA, capability, and package identity are verified. No
   readiness bypass environment variable is allowed.
2. Without stopping B, run the real dashboard approval path from that exact
   pre-approval state. Prove there is no second B promotion/start command, A remains
   online until approval, then exact B safely replaces and recovers A.
3. Invoke phase-aware `Role=Both` while awaiting approval. Prove it preserves both
   exact A and verified B; normal A-only state still stops a stale B.
4. Independently tamper each of B's source SHA, package manifest/hash, capability,
   worktree, token/port, endpoint-reported identity, PID, and executable path. Every
   case must fail before A stops and leave known-good A online.
5. Corrupt/truncate the journal, use an unknown schema, regress/skip a stage, conflict
   relay and journal stages, and substitute another candidate/package. Each case must
   fail closed without overwriting the journal or inheriting approval/proof.
6. For every durable stage, inject:
   - command/endpoint failure before the side effect;
   - crash after side effect but before post-stage persistence; and
   - crash after post-stage persistence.
   Restart the controller as a new OS process and prove convergence from durable state.
7. Specifically prove A's previous runtime backup remains recoverable across repeated
   `a-promote-started` reconciliation and that approval is recorded exactly once.
8. The startup process test must prove both outcomes: stale B exits and expected A
   remains running with the correct endpoint. Dashboard lifecycle tests must use real
   isolated executor processes/endpoints for the critical path; command-log mocks may
   remain only as supplementary assertions.
9. Prove B never receives `/prompt` or claims work, and final success leaves exact A
   online, B verified offline, relay idle, and journal completed at `b-stopped`.

Run focused reciprocal relay/supervisor/startup/promotion/dashboard suites, dashboard
nodecheck and approval-flow E2E, isolated deploy plus `-VerifyOnly`,
`npm run typecheck`, `npm test`, and `git diff --check`.

## Preservation and safety

- Do not deploy to or modify `C:\Users\huizh\Apps\Tandem Reciprocal`.
- Do not pause, stop, resume, prompt, promote, clean, stash, reset, or otherwise mutate
  live W0027, either live executor, live relay state, or either live worktree.
- Preserve unrelated root changes, untracked handoffs, recovery archives, runtime
  backups, tokens, and audit history.
- No force push, rebase, amend, history rewrite, broad clean, or destructive reset.
- Do not weaken authentication, sandboxing, source/package checks, rollback, the
  existing human approval gate, or the invariant that a runtime cannot overwrite
  itself.
- Do not change Tandem's internal leader/worker architecture or W0027 product files.

Commit source corrections as `D183-<n>:` and record `handoffs/D183_done.txt`
separately with the shared-journal transition table, cryptographic package proof,
real-process test topology, complete failure/crash matrix, tests, and changed files.
