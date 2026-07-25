# Handoff D182 (Finish D181 with a durable, restart-safe recovery lifecycle)

## Outcome

Correct D181 without replacing its accepted A-only producer model. Executor A remains
the only agentic producer, Executor B remains promptless, and B is launched only as a
temporary recovery authority from the exact mechanically verified candidate.

The complete lifecycle must be driven by durable state rather than the dashboard
process's memory:

1. A stays online on the previous stable runtime while candidate checks and packaging
   run.
2. The exact candidate package is promoted to dormant B, B is started, and B's real
   endpoint, target worktree, `BUILD_INFO`, capability, and source commit are verified.
3. Only then expose/reuse the existing human A-promotion approval.
4. After approval, verified B remains online while A is stopped, promoted from the
   same immutable package, restarted, and verified.
5. Return durable ownership to healthy A, then stop B and verify B is offline.

Do not add a second human gate, restore B as a producer, or redo unrelated D181 work.

## Actionable D181 gaps

1. `scripts/reciprocal-relay.ps1:1535-1635` persists packaging and B file-promotion
   stages, but stops at `b-runtime-promoted`. It does not launch B or verify B's real
   loopback endpoint before entering `a-upgrade-pending`.
2. `dashboard-source/reciprocal-control-panel/server.mjs:72` stores
   `approvalFlow` only in process memory. The B-start, B-verified, A-stopped,
   A-promoted, A-restarted, A-verified, relay-completed, and B-stopped transitions at
   `server.mjs:1290-1369` are not durably journaled. A dashboard crash loses the exact
   recovery point.
3. The current retry test at
   `dashboard-source/reciprocal-control-panel/approval-flow.e2e.mjs:321-363`
   injects one A endpoint-wait failure and retries through a new request. It does not
   restart the dashboard process or crash/reconcile every required boundary.
4. `scripts/start-reciprocal-tandem.ps1:170-195` chooses which executor to start but
   never reconciles an already-running executor that should be dormant. A stale B can
   therefore survive normal A work. This also makes B promotion fail closed at
   `scripts/promote-reciprocal-runtime.ps1:83-86`.
5. `dashboard-source/reciprocal-control-panel/lib.mjs:82-121` reports
   `a-upgrade-pending` as A offline/B online and mechanical checks as both offline.
   That is not the safe pre-approval topology: known-good A must remain online while B
   is built and verified, and A is stopped only after approval.
6. `tests/reciprocal-setup-script.test.ts:14-24` checks launcher source strings rather
   than an isolated process lifecycle. The D181 handoff explicitly required real
   lifecycle and crash-boundary coverage.

## Required corrective work

### 1. One durable recovery journal/state machine

- Make the relay-owned durable state (or a new atomically written relay recovery
  journal referenced by it) authoritative. Do not use the dashboard module-global
  `approvalFlow` as the source of truth.
- Bind the journal to the exact candidate source SHA, immutable package identity,
  existing review/approval identity, expected worktrees/endpoints, and previous stable
  A backup.
- Persist a monotonic transition before and after each destructive or externally
  visible boundary. At minimum represent:
  `package-ready`, `b-promote-started`, `b-promoted`, `b-start-started`, `b-started`,
  `b-verified`, `approval-recorded`, `a-stop-started`, `a-stopped`,
  `a-promote-started`, `a-promoted`, `a-start-started`, `a-started`, `a-verified`,
  `relay-completed`, `b-stop-started`, and `b-stopped`.
- Write state atomically and retain enough proof to reconcile ambiguous "operation may
  have completed before the crash" cases. Never infer success merely from the last
  attempted command.
- On dashboard/supervisor restart, reconcile the durable stage against actual process
  identity, endpoint target, runtime `BUILD_INFO`, source SHA, capability, relay phase,
  and approval record. Continue only the missing idempotent action.
- An already-recorded approval for the same immutable candidate must not be requested
  or recorded again. A different candidate must never inherit that approval.
- On corruption, conflicting evidence, or candidate mismatch, fail closed while
  keeping the known-good executor online and show one actionable recovery blocker.

### 2. Verify B before the human gate

- Extend the post-package mechanical lifecycle so B is stopped if necessary, promoted
  from exact package `C`, started, and verified before the relay presents
  `a-upgrade-pending` for human approval.
- Verification must use the real loopback endpoint and prove the expected B process,
  allowed/target worktree, exact `BUILD_INFO.sourceSha`, required Reciprocal
  capabilities, and immutable package identity.
- Keep A online on the previous stable runtime throughout B packaging/start/verification.
  A must remain available if B promotion, launch, or verification fails.
- Never send B `/prompt`, permit B to claim work, or schedule B. B exposes only the
  control/health path required to recover A.
- A B endpoint with a wrong commit, target, capability, token/process identity, or
  package must fail closed before approval is exposed.

### 3. Idempotent A replacement and topology reconciliation

- After the existing approval, verified B is the surviving recovery authority while
  A is stopped and promoted from the already-verified package `C`.
- Verify upgraded A's process identity, endpoint target, `BUILD_INFO`, capability, and
  exact source SHA before completing the relay gate or stopping B.
- If A promotion/start/verification fails or the dashboard crashes, leave B online,
  retain the previous A backup, and resume from the durable stage. Never leave both
  executors stopped.
- After durable relay completion names A as the next producer, stop B, verify it is
  offline, and persist `b-stopped`. Repeating completion must converge harmlessly.
- Make normal startup, Kickstart, and phase-aware recovery reconcile actual processes,
  not merely start the desired role. During normal A phases, safely stop a stale B
  only when durable state proves B is not the active recovery authority. During an A
  recovery stage, never stop B automatically.
- Unknown/corrupt state must fail closed rather than guessing which executor to stop.

### 4. Truthful dashboard and controls

- Derive displayed topology and enabled controls from the durable recovery stage plus
  reconciled process facts.
- Show these distinct safe states:
  `A running / B dormant`, `A running / verifying B`,
  `A running / B verified / awaiting approval`,
  `B recovery authority / A upgrading`,
  `A verified / stopping B`, and `A running / B dormant`.
- Before approval, do not report A as expected offline. During mechanical checks, do
  not report both runtimes as expected offline while known-good A is still running.
- A dormant B is healthy only in normal A stages. Once B launch/verification is
  required, wrong or absent B must be a blocker. Do not show an in-memory flow that
  will disappear on dashboard restart.
- Disable contradictory actions and explain the exact durable recovery action.

## Acceptance tests

Use isolated temporary relay roots, runtime directories, worktrees, ports, tokens, and
state. Do not touch the live W0027 executors, dashboard target, relay state, or
worktrees.

1. A real isolated normal startup/Kickstart starts A only. If an isolated stale B is
   already running and durable state says normal A operation, reconciliation stops B
   and preserves A. No B `/prompt` or claim occurs.
2. A candidate `C` runs mechanical checks, packages exact `C`, promotes and starts B,
   and verifies B before the approval gate appears while A remains online.
3. Real loopback/process tests reject B readiness independently for wrong source SHA,
   worktree, capability, token/process identity, and package identity. Every failure
   leaves known-good A online and preserves actionable evidence.
4. Approval stops A only after durable `b-verified`, promotes exact `C`, starts and
   verifies A, completes the relay transition, then stops and verifies B offline.
5. For every persisted boundary listed above, inject both:
   - an operation failure; and
   - a process crash after the side effect but before/after the durable transition.
   Restart the dashboard/supervisor as a new OS process, reload only durable state,
   and prove reconciliation converges without duplicate approval, wrong-source copy,
   lost backup, or both executors offline.
6. Include an A-restart failure followed by a fresh dashboard process. B must remain
   online, and retry must verify/reuse the existing approved candidate without
   rebuilding from an unverified source.
7. Dashboard/API tests prove expected counts, source SHAs, stages, and controls before
   B launch, during B verification, awaiting approval, during A replacement, after A
   failure, while stopping B, and after return to A-only.
8. Keep existing authority, pause, lease, rollback, source-reconciliation,
   dirty-worktree, authentication, and sandbox safety tests green.

Do not satisfy lifecycle acceptance with source-string assertions or command mocks
alone. The focused suite must create actual child processes/loopback endpoints and
restart the controlling dashboard process.

Run focused reciprocal relay/supervisor/startup/promotion/dashboard tests, dashboard
nodecheck and approval-flow E2E, an isolated dashboard deploy followed by
`deploy-reciprocal-dashboard.ps1 -TargetRoot <isolated-target> -VerifyOnly`,
`npm run typecheck`, `npm test`, and `git diff --check`.

## Preservation and safety

- Do not deploy to or modify `C:\Users\huizh\Apps\Tandem Reciprocal`.
- Do not pause, stop, resume, prompt, promote, clean, stash, reset, or otherwise mutate
  live W0027, either live executor, live relay state, or either live worktree.
- Preserve unrelated root changes, untracked handoffs, recovery archives, backups,
  tokens, and audit history.
- No force push, rebase, amend, history rewrite, broad clean, or destructive reset.
- Do not weaken authentication, sandboxing, immutable source checks, candidate checks,
  rollback, the existing human approval gate, or the rule that a runtime cannot
  overwrite itself.
- Do not change Tandem's internal leader/worker architecture or W0027 product files.

Commit source corrections as `D182-<n>:` and record `handoffs/D182_done.txt`
separately with the exact durable transition table, fault-injection matrix, process
restart evidence, tests, and changed files.
