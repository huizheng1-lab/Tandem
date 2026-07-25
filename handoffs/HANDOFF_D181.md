# Handoff D181 (Make Executor B an on-demand recovery/promoter, not an always-on idle process)

## Outcome

Finish the runtime lifecycle that D151 specified but the implementation did not fully
deliver. Executor A remains the sole agentic producer. Executor B must be stopped
during A's normal claim/plan/implementation/review work. B starts only after A's exact
candidate has been mechanically checked and packaged into B's runtime; once that B
runtime is proven healthy and the existing human runtime-promotion gate is approved,
B is the live recovery authority that upgrades and restarts A from the same immutable
verified candidate. After the upgraded A is healthy and owns the next idle cycle, stop
B again.

Do not restore the old two-producer alternation model. B must never claim, plan,
implement, review, or receive a wishlist prompt. Do not add a new human gate; reuse
the existing final runtime-promotion approval.

## Confirmed design gap

1. `process/reciprocal/PROTOCOL.md` says A is the sole producer and B has no schedule;
   B merely may be launched as a passive process.
2. `scripts/start-reciprocal-tandem.ps1` and dashboard Kickstart still launch both
   executors and wait for both automation endpoints.
3. The dashboard presents `2 / 2` continuously running processes as the healthy state,
   even while B is doing nothing. This wastes resources and obscures whether the
   passive runtime actually came from the current candidate.
4. The existing lifecycle packages and verifies the passive runtime, then exposes an
   A-upgrade gate, but it does not make the desired process ownership explicit:
   verified B should be the surviving process that safely replaces A; B should not
   have been running stale throughout A's development turn.

## Required implementation

### 1. Phase-aware process topology

- In `idle`, planning, and `working` with A as owner, only Executor A should run.
  Executor B being stopped is healthy and must not create a blocker, retry, warning,
  or failed guardrail.
- Kickstart and normal startup must start/wait for A only. They must not start B or
  require B's endpoint before prompting A.
- Keep explicit emergency controls capable of stopping all runtimes. Replace ambiguous
  `Start both` behavior with phase-aware recovery: start A in normal phases; start B
  only when the durable relay phase says a verified passive runtime is required.
- A stopped B is not unavailable infrastructure. The supervisor must not retry or
  escalate merely because B is intentionally dormant.

### 2. Just-in-time B build and launch

- After A submits a candidate, keep the existing authoritative and passive mechanical
  checks. Package B from the exact candidate commit into a fresh/staged location.
- Only after packaging and static checks succeed, replace/start Executor B from that
  package. Verify its loopback endpoint, target worktree, `BUILD_INFO`, protocol
  capabilities, and exact candidate commit before describing B as ready.
- Never send B `/prompt`, schedule B, or let B call `Claim`. B's endpoint/process is
  present only for launch verification, A promotion, and recovery.
- If B build or launch fails, leave A running on the previous stable version, preserve
  candidate evidence, and report one actionable blocker. Do not partially promote A.

### 3. Let verified B safely replace A

- Reuse/extend `scripts/promote-reciprocal-runtime.ps1` and the existing
  `a-upgrade-pending` human gate. Do not create a second approval gate.
- After the existing human confirmation, the verified B process/control path must:
  stop A at a durable checkpoint, promote A from the exact same immutable package and
  commit already proven by B, restart A, verify A's endpoint/target/`BUILD_INFO`, and
  confirm A is running the expected commit.
- Do not mark the cycle complete or return to normal `idle` until upgraded A is healthy.
  Once A is healthy and durable state names A as the producer for the next cycle, stop
  B and verify it is offline.
- If A promotion or restart fails, keep B online as the recovery authority, retain the
  previous A runtime backup, persist the exact recovery stage, and allow idempotent
  retry. Never leave both executors stopped and never claim success from file-copy
  completion alone.
- Make every boundary restart-safe: before B launch, B verified, A stopped, A files
  promoted, A restarted, A verified, and B stopped. Re-running recovery must converge
  without duplicate promotion, lost state, or another human approval for the same
  already-approved request.

### 4. Dashboard and operator truth

- Show the expected topology by phase, for example: `A producing / B dormant`,
  `B launch verification`, `B recovery authority / upgrading A`, and
  `A healthy / stopping B`.
- Normal health is `A online, B dormant`, not `2 / 2`. During handoff, both may be
  online briefly; while recovering A, B alone may be healthy.
- Show each runtime's source commit and whether it is expected to be online. A stale
  dormant B must not create a preview-protocol warning; a started B with the wrong
  commit/capability must fail closed.
- Disable controls that contradict durable ownership and explain the available safe
  action. Do not tell operators to use Kickstart when a live owner already exists.
- Update protocol, executor-role, README, and dashboard copy so they agree with the
  implemented lifecycle.

## Acceptance tests

Use isolated temporary runtime directories, worktrees, ports, and relay state. Do not
exercise the live W0027 executors.

1. Normal startup/Kickstart starts only A, accepts A's prompt, and reports B dormant as
   healthy. No B process or `/prompt` request is created.
2. A complete candidate runs mechanical checks, packages exact commit `C`, starts B
   only afterward, and refuses readiness when B reports the wrong commit, worktree, or
   capability.
3. B receives no agentic prompt and cannot claim wishlist work in any phase.
4. Existing human promotion approval causes verified B to stop A, promote exact `C`,
   restart and verify A, transfer durable recovery ownership back to A, and stop B.
5. Inject failure/crash at every persisted boundary. Recovery keeps at least one known
   good executor alive and converges idempotently. Failed A restart leaves B online;
   retry succeeds without rebuilding from an unverified source or requesting duplicate
   approval.
6. Dashboard/API tests prove expected online counts and controls for normal A work,
   B verification, A promotion, A-recovery failure, and completed return to A-only.
7. Existing pause, authority, lease, source-reconciliation, candidate, rollback, and
   dirty-worktree safety tests remain green.

Run focused reciprocal relay/supervisor/startup/promotion/dashboard tests,
dashboard nodecheck and approval-flow E2E, deployment `-VerifyOnly`,
`npm run typecheck`, `npm test`, and `git diff --check`.

## Preservation and safety

- W0027 is currently active in live copy B. Do not pause, stop, resume, prompt, clean,
  stash, reset, commit, promote, or otherwise mutate either live executor, live relay
  state, live control board, or either live reciprocal worktree for D181.
- Implement and verify against source plus isolated fixtures only. Do not deploy D181
  or replace pinned runtimes while W0027 or any candidate is active.
- Preserve unrelated root changes, untracked handoffs, D174 recovery archives, runtime
  backups, tokens, and audit history. No force push, rebase, amend, history rewrite,
  broad clean, or destructive reset.
- Do not change Tandem's internal leader/worker architecture or W0027 product files.
- Do not weaken authentication, sandboxing, candidate checks, rollback, the existing
  human runtime-promotion gate, or the invariant that an authoring runtime cannot
  overwrite itself.

Commit intended source work as `D181-<n>:` and record `handoffs/D181_done.txt`
separately with the exact state transitions, tests, and changed files. Do not mark the
round done based only on mocks or prose; the isolated process-lifecycle tests must pass.
