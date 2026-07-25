# Handoff D177 (Make D176 semantics real and recover W0027 at a safe boundary)

## Corrective outcome

D176 fixed W0027's false text-keyword metadata and installed a recurring dashboard
tick, but it did not complete the structural acceptance criteria. Finish only the
remaining control-plane work. Preserve W0027's ID, text, priority, plan, dirty working
copy, checkpoint, and W0023 ordering. Do not implement or edit W0027 product/plan
content in this round.

## Confirmed review findings

1. `process/reciprocal/gate-taxonomy.json` is never read. JS, PowerShell, relay, and
   retry code still hard-code separate values. It is not the authoritative shared
   taxonomy required by D176.
2. The authority shape exists only in the dashboard classifier. Direction has no
   guarded action that declares a complete exact-step authority request, pauses at the
   checkpoint, records approval, or resumes it. No test proves that lifecycle.
3. A live lease calls `Update-BlockerState`, increments attempts, and displays
   `retrying prerequisite`. This violates the rule that live ownership/waiting does not
   consume blocker attempts.
4. `nextAttemptAt` and `backoffSeconds` are recorded but never checked before another
   attempt. Only executor-prompt exceptions enter blocker state; passive tests, state
   writes, file locks, and other controller failures bypass persisted retry handling.
   The lease heartbeat is refreshed only before potentially long work.
5. The only new supervisor test covers live/dead lease acquisition. There is no test
   for startup idle dispatch, concurrent ticks/double claim, explicit human pause,
   machine-created pause recovery, enforced backoff/restart persistence, third
   identical escalation/reset, token-mismatched cleanup, or long-running heartbeat.
6. The updater writes transaction stages but never reads them. Therefore a
   `pushed-not-synced` retry creates a new tag/transaction instead of resuming. It still
   moves checked-out dirty `master` before branch/relay sync; failure can leave remote,
   branches, relay, local ref, and dirty-index interpretation split. There are zero
   updater transaction tests or fault-injection tests.
7. D176 source was not reconciled into Reciprocal. Live heads are
   `master=1f000ab`, `copy-a=copy-b=92a4f5b`, `stable=origin/master=974d64c`.
   Thus workers still use pre-D176 workspace scripts even though the dashboard uses
   D176 from the admin checkout.
8. The live relay is now machine-paused, not explicitly human-paused:
   `phase=paused`, `pausedFromPhase=working`, `activeRole=A`, `resumeCount=3`, summary
   `Auto-paused turn 2: executor A received 3 consecutive RESUME claims...`. D176
   incorrectly exposes this as `explicit-human-pause` / `human paused`. W0027 remains
   `IN_PROGRESS phase=PLAN autonomy=full`, with its checkpoint and one dirty plan file.

## Required corrective work

### 1. One authoritative taxonomy and pause provenance

- Load and validate one canonical machine-readable taxonomy/policy in every consumer.
  JS, direction/relay PowerShell, supervisor, dashboard status/audit, and tests must
  consume its categories, codes, retry limits, and display mapping. Remove duplicated
  literals or generate consumers deterministically from the canonical source.
- Extend relay state/audit with explicit pause provenance and reason code. A dashboard
  or CLI human Pause is `pauseOrigin=human` and sticky. A resume circuit breaker,
  machine planning pause, retry exhaustion, candidate failure, and runtime review are
  distinct structured origins.
- Never infer explicit human intent from `phase=paused` or `pausedFromPhase`. The
  current W0027 resume circuit breaker must display as a machine-created repeated
  blocker with its exact checkpoint/next safe action, not `explicit-human-pause`.
- Preserve compatibility by migrating legacy state conservatively from auditable
  fields/summary only when deterministic; ambiguous legacy pauses remain stopped and
  are labeled unknown, not falsely human.

### 2. Complete exact-step authority lifecycle

- Add guarded direction/control actions to declare an exact authority request and to
  record its approval/denial. Require and validate all structured fields: authority
  kind, precise action, checkpoint, and resume action. Reject incomplete or broad
  grants.
- Only the exact current plan step may carry a pending authority request. Starting or
  continuing that step returns one hard gate without losing ownership/progress.
  Approval resumes the same checkpoint once; denial remains stopped without altering
  unrelated item state. Ordinary prose never creates this metadata.
- Persist the same reason/category/action through relay, supervisor, audit, API, and
  UI. Preserve the final live-runtime approval as its own exact authority kind.

### 3. Enforce supervisor lease/retry behavior

- A valid live lease is `waiting-not-blocked`; it must not create/change blocker state
  or consume attempts. Token-mismatched cleanup must remain unable to remove it.
- Before retrying a stored blocker, enforce `nextAttemptAt`. Before that time return a
  no-transition `retry-backoff` result. At the third identical genuine failure enter
  hard-blocked and stop automatic retry until the fingerprint changes or an explicit
  diagnostic retry is requested. Reset after a real successful transition.
- Route all recoverable controller failures through the same persisted path, including
  passive test, endpoint startup, command/file-lock/JSON/state errors. Do not convert
  programming/invariant corruption into endless retries.
- Maintain lease heartbeat safely during long passive tests/prompts, or prove from
  process identity that a live owner cannot be stolen solely because TTL elapsed.
  Lease/state/audit writes must be atomic enough that a crash cannot leave malformed
  JSON as a permanent blocker.
- Keep exactly one recurring dashboard controller. Manual Kickstart must call that
  controller with an explicit diagnostic-retry flag and must not bypass hard human
  authority or duplicate dispatch.

### 4. Make main reconciliation actually resumable

- Read transaction state at startup and deterministically resume or roll back each
  stage. For `pushed-not-synced`, verify the remote SHA/tag and continue sync without a
  new tag or force push. For pre-push stages, either continue the exact transaction or
  remove its exact temp/tag/ref artifacts and restart cleanly.
- Do not reinterpret a dirty admin index by moving its checked-out branch ref. While
  admin is dirty, leave local `master` explicitly deferred or use a fully validated
  atomic index/ref transaction. Remote integration and clean reciprocal branch sync
  may proceed from an isolated ref without changing admin status/index entries.
- Add fault injection at before push, after push, after copy A, after copy B, after
  relay reconcile, and before cleanup. Every retry must converge to one remote commit,
  one tag, matching clean reciprocal heads/stable ref, and byte/index-identical admin
  dirt. Real merge conflicts must mutate none of those refs.
- Expose deferred/local-master and transaction stage truthfully in result/status; do
  not report reconciliation complete while any source/relay head is stale.

### 5. Safe live convergence without disturbing W0027

- Do not force reconciliation while W0027 has an active owner or dirty plan file.
  Persist a `source-reconciliation-pending` auto prerequisite for D176/D177 source and
  have the recurring controller execute it automatically at the first safe no-owner,
  no-candidate boundary. This must require no new handoff or Kickstart click.
- The current resume-circuit-breaker pause is machine-created but represents three
  failed resumptions. Do not blindly clear it. Inspect its durable checkpoint and
  workspace state through a guarded recovery decision. If the corrected control path
  can prove the existing plan candidate/checklist can continue without duplicate
  commit or data loss, recover the same owner/checkpoint once and record the reason.
  Otherwise leave one truthful hard blocker naming the exact unresolved condition.
- Never reset, clean, overwrite, regenerate, or commit the W0027 plan as part of D177.

## Required acceptance tests

Add focused deterministic tests, not helper-only assertions, proving:

- Changing taxonomy categories/codes/retry values in a fixture is observed by JS,
  direction/relay, supervisor, API, and UI; invalid/missing taxonomy fails safely.
- Explicit human pause stays sticky; machine planning pause recovers; the current
  three-RESUME circuit breaker is classified as machine `repeated-genuine-blocker`,
  never explicit human pause.
- A complete exact-step authority request pauses once and resumes the same checkpoint
  after approval; incomplete metadata is rejected; denial and final runtime authority
  remain stopped.
- Dashboard startup with idle + queued dispatches exactly once without Kickstart.
  Overlapping startup/watchdog/manual ticks do not double claim.
- Live lease contention leaves blocker attempts unchanged; dead lease reclaims;
  token-mismatched cleanup is harmless; long operation retains ownership.
- Retry occurs only at/after `nextAttemptAt`; restart preserves the counter; third
  identical genuine failure hard-blocks; changed fingerprint and successful transition
  reset it; passive-test and file/state failures use the same policy.
- Plan-only and non-final autonomous candidates bypass runtime promotion through the
  actual recurring controller; final source-changing runtime replacement remains hard.
- Real temporary Git repositories preserve dirty tracked, staged, renamed/deleted,
  untracked, and space-containing paths plus exact index entries. All required injected
  failure stages converge on retry without duplicate tags or force push; a conflict
  changes no refs/state.
- A deferred live source reconciliation does not run while W0027 is owned/dirty, then
  runs once at a simulated safe boundary and makes both reciprocal heads/stable match
  the integrated source.
- Existing D171-D176 tests continue to pass.

Run and record focused tests, dashboard helper/approval E2E, deployment VerifyOnly,
`npm run typecheck`, `npm test`, and `git diff --check`.

## Live completion evidence

- Record current W0027 relay state, board line, copy-B status, checkpoint hash, and plan
  file hash before/after; all content/progress must be preserved.
- Deploy canonical dashboard source and prove recurring ticks use D177.
- Record source reconciliation as pending while unsafe. If a safe boundary occurs,
  prove automatic convergence; otherwise show the durable pending action and exact
  automatic trigger condition without claiming reconciliation completed.
- Report whether the current W0027 machine circuit breaker was safely recovered or
  remains one truthful blocker, with the exact deterministic reason. Do not label it
  human-paused unless a human actually paused it.
- Do not promote or replace pinned Executor runtimes.

## Safety constraints

- Preserve all unrelated user changes and the D174 archive. No reset, stash, broad
  clean, force-push, rebase, amend, or history rewrite.
- Do not edit/commit W0027 product code or `process/reciprocal/epics/W0027-plan.md`.
- Do not cancel, duplicate, replace, or blindly resume W0027's owner/checkpoint.
- Never auto-authorize installation, credentials, authentication/pairing, permission
  or sandbox weakening, destructive data/history changes, payment/publication, or
  final live-runtime replacement.
- Do not weaken candidate tests, preview review, rollback, audit history, or final
  runtime approval.

Commit intended work as `D177-<n>:` and record `handoffs/D177_done.txt` separately with
exact commits, tests, transaction/fault proofs, deployment, live state, and preservation
hashes.
