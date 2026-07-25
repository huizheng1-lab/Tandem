# Handoff D176 (Finish D175 progress-first control path without interrupting W0027)

## Corrective outcome

D175 passed its existing tests but did not satisfy its required live behavior. Correct
the remaining structural gaps only. Preserve the currently owned W0027 planning turn,
its plan/checkpoint, and W0023 ordering. Do not duplicate, cancel, restart, or implement
W0027 product work in this round.

## Confirmed deficiencies to correct

1. `scripts/reciprocal-direction.ps1` classifies an entire wishlist sentence with a
   keyword regex. W0027 was therefore changed to
   `autonomy=plan-gated safety=security-surface` solely because its text says never to
   weaken sandboxing. `dashboard-source/reciprocal-control-panel/lib.mjs` repeats the
   same whole-text mistake. This violates the exact-sensitive-step requirement and
   will create another unnecessary human plan gate.
2. The exported gate taxonomy/classifier is used only by its nodecheck. Relay,
   direction, continuation, dashboard status/audit, and UI do not share or persist its
   reason code/category/next action.
3. The continuation script is invoked from the manual
   `/api/executor/kickstart` route and post-candidate code, but no dashboard startup
   tick, watchdog tick, or other persistent controller invokes it for ordinary idle +
   queued work. D175's W0027 proof was manually invoked.
4. `continuation-supervisor.lock.json` uses `CreateNew`; a crashed process leaves a
   permanent `lease-held` file. There is no owner token, PID/start-time validation,
   expiry, heartbeat, or stale reclamation.
5. Blocker attempt/fingerprint/backoff exists only as an unpersisted test argument.
   The live supervisor does not record or enforce bounded retries or the third
   identical genuine-blocker rule.
6. No new UI state distinguishes planning/testing/retrying/human-paused/hard-blocked,
   and the required end-to-end supervisor behaviors are untested.
7. `scripts/reciprocal-main-update.mjs` moves checked-out dirty `master` with
   `git update-ref` before push and before preservation validation. If preservation or
   push fails, it leaves refs/tags/relay state partially changed and offers manual
   follow-up rather than rollback or deterministic resume. Its staged snapshot does
   not preserve index blobs, and the temporary-path guard uses a prefix comparison.
   There are no reconciliation transaction tests.

## Required corrective work

### A. Exact authority metadata, not keyword gating

- Make one machine-readable gate taxonomy and structured reason shape authoritative
  across direction, relay/continuation, dashboard API/audit, and UI. Avoid parallel
  JS/PowerShell interpretations that can drift.
- An ordinary human-queued item always normalizes to autonomous planning. Do not infer
  a hard gate from arbitrary prose, negations, examples, acceptance-test text, or
  words such as `sandbox`, `permission`, `credential`, or `publish`.
- A hard authority gate must be explicit structured metadata attached to the exact
  plan step/action that needs new authority. Record authority kind, precise requested
  action, checkpoint, and resume action. Explicit human pause/cancel/reject remains
  sticky and separately recorded.
- Add a guarded, idempotent migration action that can correct already-normalized false
  positives while preserving ID, text, priority, status, phase, role, revision,
  completion, timestamps, plan path, audit history, and active checkpoint.
- Apply that action to W0027 only after verifying its current live state. Remove its
  false `safety=security-surface`, set ordinary autonomous planning semantics, and do
  not change or overwrite `process/reciprocal/epics/W0027-plan.md`. If W0027 has
  advanced by then, migrate its current state rather than reverting it. Preserve W0023
  behind it.

### B. One genuinely automatic supervisor

- Connect exactly one recurring controller to the existing managed dashboard/watchdog
  lifecycle. It must run once at startup and on a bounded recurring tick without a
  dashboard button, browser refresh, candidate completion, or human handoff.
- Keep manual Kickstart as a diagnostic call into the same controller, not a second
  dispatch implementation.
- The controller must safely handle idle + queued, machine-created recoverable pause,
  passive test, intermediate continuation, endpoint restart/retry, and no-op active
  ownership. It must never auto-resume an explicit human pause.
- Implement a token-owned lease with PID plus process-start identity, acquisition and
  expiry/heartbeat timestamps. A live owner is respected; a dead/expired owner is
  reclaimed atomically; cleanup removes only the caller's token. A crash cannot leave
  Reciprocal permanently idle.
- Persist a blocker state containing taxonomy category, reason code, normalized
  fingerprint, attempt count, last/next-attempt timestamps, backoff, and next automatic
  action. Reset it after a real transition. Escalate only the third consecutive
  identical genuine blocker; breadth/planning and active/waiting states never consume
  blocker attempts.
- Persist and audit each transition. Dashboard status/UI must truthfully show at least
  `planning`, `working`, `testing`, `waiting for review`, `retrying prerequisite`,
  `human paused`, and `hard blocked`, including the next retry time/action where
  applicable.

### C. Verify plan/intermediate continuation semantics in the live path

- Ensure an accepted ordinary plan-only candidate auto-approves and dispatches step 1
  without a live-runtime promotion gate.
- Ensure each accepted non-final epic step advances and dispatches the next step
  without runtime promotion. Preserve the one explicit final source-changing live
  runtime approval gate.
- Wire these decisions through the shared structured taxonomy and persisted supervisor
  state rather than summary-string matching.

### D. Make isolated reconciliation transactional and retryable

- Add deterministic tests around real temporary Git repositories before changing the
  live updater.
- Preserve dirty tracked, staged, renamed/deleted, untracked, and space-containing
  paths byte-for-byte and index-entry-for-index-entry. Do not stash, reset, clean, or
  stage the admin checkout.
- Do not move a checked-out dirty branch ref while leaving its index based on the old
  tree. Either defer that local ref safely while integrating/pushing from an isolated
  ref, or update ref/index as one validated rollback-capable transaction.
- Use explicit transaction state and idempotent resume for interruption before push,
  after push, and before/after branch/relay synchronization. A failed pre-push run must
  restore local refs/tags/state automatically. A post-push retry must converge without
  force-push or duplicate tags.
- Validate admin preservation before irreversible mutation wherever possible and again
  afterward. Use component-aware `path.relative` containment checks for cleanup, not
  string-prefix checks. Remove only the exact temporary workspace created by this run.
- A genuine merge conflict must stop before refs/push/sync with exact conflicting
  paths. Unrelated dirty admin state must not block clean executor reconciliation.

## Required acceptance tests

Add deterministic tests proving all of the following, not just helper return values:

- A W0027-equivalent sentence containing `Python`, `permission`, `sandbox helper`, and
  `never weaken sandboxing` normalizes to autonomous planning and never becomes a hard
  gate from prose.
- An exact plan step with explicit structured new-permission authority pauses once,
  records the precise request/checkpoint, and resumes from that checkpoint after
  approval.
- The live shared classifier is consumed by direction, supervisor, status/audit, and
  UI; persisted reason/category/action is visible through `/api/status`.
- Server/watchdog startup with idle + queued work dispatches once without calling
  Kickstart. Concurrent ticks do not double-claim.
- A live lease blocks a second owner; a fabricated dead/expired lease is reclaimed;
  token-mismatched cleanup cannot delete another owner's lease.
- Transient endpoint/file-lock failures persist bounded backoff. Only the third
  consecutive identical genuine blocker escalates; a successful transition resets the
  counter; restart preserves the counter and retry time.
- Explicit human pause is never auto-resumed. Machine-created paused-from-idle breadth
  is recovered.
- Plan-only and non-final candidates do not enter runtime-promotion pending; the final
  source-changing candidate still does.
- Reconciliation preserves dirty tracked/staged/untracked/renamed/deleted files and
  index entries exactly; conflict and injected crash points leave refs, tags, branches,
  relay state, and admin state coherent and converge on retry.
- Existing D171/D172 approval recovery, D174 archive, and D175 direction/relay tests
  continue to pass.

Run and record focused tests, dashboard nodecheck and approval-flow E2E,
`scripts/deploy-reciprocal-dashboard.ps1 -VerifyOnly` after deployment,
`npm run typecheck`, `npm test`, and `git diff --check`.

## Live completion proof

- Preserve the currently active W0027 owner/checkpoint during implementation.
- Deploy/reconcile through the corrected transactional path without promoting or
  replacing the pinned Executor runtimes.
- Show the recurring supervisor tick in audit/state without manually pressing
  Kickstart.
- Report W0027 before/after metadata and exact live transition. It must retain its ID,
  text, priority, plan/checkpoint, and current progress while no longer being falsely
  plan-gated. If its plan has already been accepted, prove automatic progression to its
  next legitimate state without duplicate dispatch.

## Safety constraints

- Preserve all unrelated user changes and the D174 recoverable archive. No reset,
  stash, broad clean, force-push, rebase, amend, or history rewrite.
- Do not edit, regenerate, commit, or implement W0027 product/plan content in D176.
- Do not cancel or replace a live W0027 owner. If it is actively writing, wait for a
  safe control-plane boundary and then migrate metadata in place.
- Never auto-approve installation, credentials, authentication/pairing, permission or
  sandbox weakening, destructive history/data actions, payment/publication, or final
  live-runtime replacement.
- Do not weaken independent candidate tests, preview review, rollback, audit history,
  or the final runtime human gate.

Commit intended changes with `D176-<n>:` messages and record completion separately in
`handoffs/D176_done.txt` with exact commits, tests, deployment/reconciliation evidence,
supervisor audit records, lease/retry proofs, and W0027 preservation/progression proof.
