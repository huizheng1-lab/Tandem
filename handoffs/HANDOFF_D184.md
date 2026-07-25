# Handoff D184 (Make package promotion atomic, verifiable, and crash-proven)

## Outcome

Finish the remaining D183 safety work without redesigning the accepted A-only/B-recovery
topology or redoing the shared-journal integration.

The exact bytes verified in B must be the bytes promoted into A. Replacing A must be an
atomic, rollback-capable operation that preserves the previous A runtime until the new
A is running and verified. Journal transitions must reject illegal skips and reconcile
every pre/post side-effect crash. Critical acceptance must use the real isolated relay,
dashboard, promotion script, child processes, and authenticated endpoints.

## Actionable D183 gaps

1. `scripts/package-passive-runtime.ps1` calculates a SHA-256 package identity, but
   later verification only reads the stored value. In particular,
   `dashboard-source/reciprocal-control-panel/server.mjs:165-168` returns
   `BUILD_INFO.packageIdentity` without recomputing the manifest or file hashes.
   Neither relay B verification nor dashboard A verification detects changed runtime
   bytes when `BUILD_INFO` is left untouched.
2. `scripts/promote-reciprocal-runtime.ps1:88-99` stages a copy, then deletes every
   file in the target runtime in place and copies into the emptied directory. It does
   not retain the previous A runtime backup, does not atomically swap directories, and
   does not verify source/staging/target bytes against the package manifest. A copy
   failure or crash can destroy recoverable A.
3. Dashboard A promotion still sources mutable
   `release/win-unpacked` (`server.mjs:1480-1493`). The journal stores only the claimed
   package identity, not an immutable content-addressed package path/proof. Those files
   can change after B verification and before A promotion.
4. Relay journal writing at `scripts/reciprocal-relay.ps1:234-305` validates JSON,
   source, package, and regression only. It does not validate schema/stage of the
   existing record, reject skipped/illegal transitions, or reject disagreement with
   `state.runtimeRecoveryStage`.
   Dashboard writing at `server.mjs:296-341` likewise permits arbitrary forward stage
   skips.
5. Relay B attestation at `reciprocal-relay.ps1:1813-1855` does not require endpoint
   PID to equal token PID, endpoint token-file identity, or expected instance/role.
   Dashboard attestation at `server.mjs:1578-1600` does not require
   endpoint-reported capabilities and permits an omitted endpoint token-file field.
6. `approval-flow.e2e.mjs:184-198` still runs all executor start/stop/promotion
   commands through `TANDEM_DASHBOARD_TEST_HARNESS=1`. Its adoption and crash tests do
   not exercise the real promotion/process lifecycle.
7. The only crash test remains
   `approval-flow.e2e.mjs:462-502`, which crashes after the durable `a-stopped` step.
   There is no before-side-effect failure, after-side-effect/before-post-stage crash,
   and after-post-stage crash matrix for every durable operation.
8. The startup fixture serves one status and immediately exits; it proves one response,
   not that A remains healthy. No test tampers a managed package file while preserving
   the claimed `packageIdentity`, and no test proves the old A backup survives repeated
   `a-promote-started` recovery.

## Required corrective work

### 1. Shared package-integrity verifier and immutable package source

- Implement one canonical package-manifest/identity algorithm used by packaging,
  promotion, relay verification, dashboard reconciliation, and tests. Avoid duplicated
  PowerShell/JavaScript algorithms that can drift.
- Recompute every managed file's relative path, length, and SHA-256 from disk. Verify:
  source SHA, required capabilities, manifest equality, and derived package identity.
  Never trust the identity copied into `BUILD_INFO` without recalculation.
- After packaging, preserve the candidate under a content-addressed immutable path
  keyed by package identity. Record that exact canonical path and identity in the
  journal. Reject paths outside the controlled package root.
- B promotion, B verification, A promotion, A verification, and restart recovery must
  all revalidate against that immutable package. Do not source A promotion from a
  mutable alias such as `release/win-unpacked`.
- Detect any added, removed, renamed, resized, or modified managed file, altered
  manifest, changed source/capability, symlink/junction escape, or package-path
  substitution before stopping A.

### 2. Atomic promotion with durable previous-runtime backup

- Replace in-place target deletion/copy with a staged and verified directory swap:
  1. validate immutable source;
  2. copy to unique staging;
  3. recompute and verify staging;
  4. persist operation identity, source/package, target, staging path, and backup path;
  5. atomically rename current target to a unique backup;
  6. atomically rename verified staging to target;
  7. recompute and verify target.
- Never delete/overwrite the previous A backup during retry. Persist its path and
  package/source proof in the shared journal before moving A.
- If the swap or verification fails, leave B online and either restore old A
  atomically or retain both backup and diagnosable partial target for deterministic
  recovery. Never report `a-promoted` from copy completion alone.
- Reconciliation at `a-promote-started` must inspect operation/staging/target/backup
  proofs and continue exactly once. Repeated recovery must not create a chain of
  backups from partial candidates or lose the original stable A.
- Retain the previous A backup through successful A process/package verification and
  durable relay completion. Define a safe later cleanup policy; do not remove it as
  part of the risky swap.

### 3. Strict journal transitions and complete endpoint binding

- Centralize legal journal transitions. Permit only:
  - same-stage idempotent proof enrichment; or
  - the explicitly defined next stage after its required proof.
- Reject unknown schema, unknown current stage, skipped stage, regression, source or
  package mismatch, missing required proof, completed-journal mutation, and relay
  `runtimeRecoveryStage` disagreement.
- Pre/post-operation stages must carry an operation ID so reconciliation can distinguish
  "not attempted", "side effect happened", and "verified complete".
- Relay and dashboard must apply the same validation rules. Prefer one shared helper or
  a single authority rather than parallel validators.
- Before exposing approval, B attestation must require token PID = endpoint PID =
  expected executable PID, exact token-file path/port, instance `B`, expected
  worktree, endpoint-reported source/package/capabilities, and recomputed on-disk
  package proof.
- Apply equivalent checks to A before relay completion. Endpoint token-file and
  capability fields are mandatory, not optional/fallback values.

### 4. Real integrated recovery and fault matrix

- Add an isolated executable fixture that remains running until explicitly stopped,
  serves authenticated `/status`, and can be configured to fail/tamper at precise
  boundaries. Injection belongs in the test fixture/process boundary, not production
  success branches.
- Run passive acceptance to a real `b-verified` journal, then start the real dashboard
  without `TANDEM_DASHBOARD_TEST_HARNESS` and approve through its authenticated API.
  Use the actual stop/start/promotion scripts and real isolated A/B endpoints.
- Prove the dashboard adopts running B with no second B promotion/start, preserves B
  through A replacement, starts exact A, completes the relay, and stops B.

## Acceptance tests

Use isolated temporary roots, repositories, worktrees, ports, tokens, executables, and
processes only. Do not touch live W0027 or the live Reciprocal installation.

1. Tamper each package condition independently after identity creation while leaving
   the claimed identity untouched: file bytes, size, added/removed/renamed file,
   manifest entry/hash, source SHA, capability, content-addressed path, and
   symlink/junction escape. B/A verification must reject every case.
2. Prove B and A recompute to the same package identity and exact manifest as the
   immutable journal source.
3. Inject failure/crash at every promotion sub-boundary: source verified, staging copy
   partial/complete, staging verified, backup intent persisted, old target renamed,
   new target renamed, and target verified. Restart with only durable state and prove
   deterministic convergence with original A backup intact.
4. Repeat recovery from `a-promote-started` multiple times. Exactly one original A
   backup remains authoritative; no retry deletes or replaces it.
5. For every lifecycle operation from B promotion through B shutdown, test:
   - failure before side effect;
   - crash after side effect but before post-stage persistence; and
   - crash after post-stage persistence.
   Restart relay/dashboard as new OS processes and verify at least one known-good
   executor remains available.
6. Independently reject journal unknown schema/stage, skip, regression, completed
   mutation, source/package mismatch, missing operation proof, and relay/journal stage
   disagreement.
7. Independently reject B and A endpoint PID, executable path, token file, port,
   instance ID, worktree, source, package, and capability mismatches before advancing
   their verified stages.
8. The real integrated dashboard test must not set
   `TANDEM_DASHBOARD_TEST_HARNESS`. Assert actual process liveness at every topology
   stage, no B `/prompt`, one approval record, final exact A online, B offline, relay
   idle, journal `b-stopped`, and original A backup still recoverable.
9. Keep the mocked E2E as fast supplementary coverage, but do not use it as evidence
   for process, promotion, integrity, or crash safety.

Run focused relay/supervisor/startup/promotion/dashboard/integrity tests, dashboard
nodecheck and E2E, isolated deploy followed by `-VerifyOnly`, `npm run typecheck`,
`npm test`, and `git diff --check`.

## Preservation and safety

- Do not deploy to or modify `C:\Users\huizh\Apps\Tandem Reciprocal`.
- Do not pause, stop, resume, prompt, promote, clean, stash, reset, or otherwise mutate
  live W0027, either live executor, live relay state, or either live worktree.
- Preserve unrelated root changes, untracked handoffs, archives, runtime backups,
  tokens, and audit history.
- No force push, rebase, amend, history rewrite, broad clean, or destructive reset.
- Do not weaken authentication, sandboxing, package/source checks, rollback, the
  existing human approval gate, or the invariant that a runtime cannot overwrite
  itself.
- Do not change Tandem's internal leader/worker architecture or W0027 product files.

Commit source corrections as `D184-<n>:` and record `handoffs/D184_done.txt`
separately with the canonical integrity algorithm, immutable package layout, atomic
swap/backup state table, complete fault matrix, real process topology evidence, tests,
and changed files.
