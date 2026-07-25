# Handoff D175 (Progress-first Reciprocal: remove bureaucratic deadlocks and start W0027)

## User outcome

Reciprocal has repeatedly accepted human work, then stopped on metadata, planning,
dispatch, source-sync, or recoverable-state gates before any implementation began.
The human has explicitly requested a comprehensive revision with as few blocking
reasons as possible. Make Reciprocal progress-first: a human-queued item is sufficient
authorization to plan, split, and implement safe increments without repeated human
intervention.

This is a structural workflow correction, not W0027's implementation. Complete and
verify the workflow correction first. At the very end, prove the repaired live system
actually dispatches W0027; do not implement W0027 within the D175 commits.

## Evidence and root causes to correct

The current behavior is encoded, not model-dependent:

- `process/reciprocal/PROTOCOL.md` tells A to pause when a human item appears too
  architectural, ambiguous, or large, even though the human already queued it.
- `process/reciprocal/TANDEM_EXECUTOR_A.md` treats every `PAUSED` result as terminal.
- `scripts/reciprocal-direction.ps1` can plan an item only if the item was already
  manually created with `epic=true phase=PLAN`; a normal queued item cannot promote
  itself into planning while preserving its ID.
- `scripts/continue-reciprocal-automation.ps1` continues only a narrow existing epic
  state; it does not dispatch ordinary human-queued work.
- the dashboard `/api/executor/kickstart` endpoint requires an idle relay and a manual
  button press; it cannot recover a self-created paused-from-idle planning stop.
- plan-only and intermediate epic transitions can reach runtime-upgrade gates even
  when no executable behavior needs human promotion.
- `scripts/reciprocal-main-update.mjs` treats unrelated admin working files as a hard
  blocker and therefore leaves both clean executor worktrees stale, even when those
  files can be preserved untouched through isolated integration.
- the live relay is currently `paused` from `idle`; its summary says W0027 was rejected
  as too broad/missing epic metadata. W0027 remains the highest-priority `QUEUED` human
  item.

Do not attribute this to model intent. Make the control plane deterministic so model
choice cannot invent extra gates.

## 1. Replace ad-hoc gates with an explicit taxonomy

Implement one shared, machine-readable classification used by relay, direction,
continuation, dashboard, and UI:

### Hard human gate

Only these may stop autonomous progress:

- an explicit human pause/cancel/reject;
- installation, credentials, authentication/pairing, permission or sandbox weakening,
  paid/external publication, destructive data/history operations, or another action
  requiring authority not already granted;
- promotion/replacement of the live Executor executable after a source-changing
  candidate is independently tested and previewed;
- a deterministic candidate/test failure that cannot be corrected within the same
  bounded lifecycle without changing the accepted objective.

### Auto-recoverable prerequisite

These must not become durable human pauses:

- a human-queued item is broad, architectural, multi-file, or lacks epic metadata;
- a plan or step breakdown is missing;
- relay is paused-from-idle by an executor for planning/breadth/no-safe-item wording
  while a human item is queued;
- executors are stopped but authenticated automation can be restarted;
- master/reciprocal source branches are stale while no candidate/rollback/owner exists;
- unrelated admin worktree files are dirty but can be proven untouched;
- transient process startup, file-lock, or fixed-timeout noise that succeeds on a
  bounded retry and does not indicate a semantic failure.

### Waiting, not blocked

An active owner, passive mechanical test, candidate preview review, or bounded retry
backoff is normal progress. Surface it honestly, but do not label it blocked.

Persist a structured reason code/category/next automatic action in state and audit
records. User-facing status must say what is happening and when the next automatic
attempt occurs.

## 2. Human-queued work must plan and split itself

Revise direction state and executor instructions so any normal `QUEUED` human item may
be atomically normalized into an auto-planned multi-step item while preserving the
same wishlist ID, priority, text, and audit history. The human must not have to predict
`epic=true`, a step count, plan path, or `phase=PLAN` when submitting work.

- Add a guarded direction action/API for this normalization; it must be idempotent and
  concurrency-safe.
- The planning turn determines the smallest coherent vertical steps and records them
  in `process/reciprocal/epics/<ID>-plan.md`.
- For ordinary human-queued product/reliability work, planning is autonomous by
  default. A broad task is a reason to plan, not pause.
- Authentication, credential, pairing, permission/sandbox weakening, destructive, or
  external-publication steps remain plan-gated at the exact sensitive step—not merely
  because arbitrary text contains words such as "remote control".
- Do not mark a multi-step item DONE after only its first slice. Preserve item-level
  progress until the final accepted step.
- Update the templates, protocol, executor prompts, dashboard parser, and tests to use
  the same semantics. Remove contradictory "pause because too broad" instructions.

## 3. Remove plan-only and intermediate runtime bureaucracy

A plan-only commit and an accepted non-final epic step must not require replacing the
live Executor runtime merely to continue planning/implementation.

- Independently validate and record plan-only commits, then auto-approve ordinary
  human-queued plans and dispatch step 1.
- After a passing non-final step, advance stable/source state and dispatch the next
  step without entering a human runtime-promotion gate.
- Package/preview may still be produced where useful, but do not make runtime
  replacement a prerequisite for the next source step.
- Keep exactly one hard live-runtime gate for a final source-changing candidate whose
  tested build would replace the running Executor. Never self-promote the live
  executable.
- A docs/control-only plan must never claim that runtime promotion occurred.

## 4. Automatic dispatch and recoverable pause handling

Create one idempotent background supervisor (reuse/extend the existing continuation
and dashboard controller rather than adding competing loops) that:

1. inspects relay, queue, candidate, source-sync, and executor endpoint state;
2. resumes only machine/self-created recoverable pauses, never an explicit human pause;
3. performs safe source reconciliation when required;
4. starts/restarts authenticated hidden executors when safe;
5. dispatches the highest-priority human-queued item automatically;
6. normalizes it into planning when needed;
7. runs passive/continuation transitions without a manual Kickstart click.

Use a lease/idempotency key so dashboard refreshes, watchdog ticks, and scheduled runs
cannot double-dispatch. Persist a blocker fingerprint and bounded retry/backoff. Only
escalate after the same genuine blocker repeats three times with no successful state
transition; never escalate merely because a task is broad or requires a plan.

Manual Kickstart remains as a diagnostic/retry control, but normal queued work must not
depend on it. The UI must distinguish `working`, `planning`, `testing`, `waiting for
review`, `retrying prerequisite`, `human paused`, and `hard blocked`.

## 5. Dirty-admin-safe source reconciliation

Replace the growing filename allowlist in `scripts/reciprocal-main-update.mjs` with a
principled isolated integration path. It must be able to reconcile clean Reciprocal
worktrees while the admin worktree contains unrelated tracked or untracked user files,
without changing, staging, stashing, deleting, resetting, or rewriting those files.

- Perform merge/integration in an isolated temporary Git worktree/index or equivalent
  transaction, not through the dirty admin checkout.
- Snapshot admin status plus byte hashes for every dirty file before and after; prove
  exact preservation. Preserve staged state too, if present.
- Detect actual semantic merge conflicts in isolation. Only a real unresolved conflict
  is a blocker; unrelated dirty paths are not.
- Push normally and atomically; never force-push.
- Fast-forward both clean Reciprocal worktrees and reconcile relay refs/state only
  after validation and push succeed.
- Clean up only the temporary integration workspace created by this flow, with exact
  resolved-path checks. Never clean the admin or executor worktrees.
- Add crash/retry tests proving an interrupted transaction is discoverable and safely
  resumable or removable.

The current unrelated admin files, including modified
`scripts/setup-reciprocal-tandem.ps1`, monitor scripts, and `tmp/pdfs/stat_section/**`,
must remain untouched and byte-identical. The eight D174 scratch scripts must remain in
their recoverable archive.

## 6. Bootstrap and live activation

This correction must not deadlock on the stale copies it is designed to repair:

1. Commit only D175 workflow/source/test changes on `master`, preserving unrelated
   admin changes.
2. Use the new isolated reconciliation path to integrate current stable plus the D175
   source into both Reciprocal branches/worktrees.
3. Deploy the canonical dashboard through
   `scripts/deploy-reciprocal-dashboard.ps1`; verify managed hashes and loopback status.
4. Do not rebuild, promote, replace, or restart the live Executor runtime merely for
   source reconciliation. Restarting an existing hidden executor process is allowed
   only if the automation endpoint is unavailable and the same pinned executable is
   reused.
5. Convert the current W0027 state, if necessary, into the new auto-planning state
   without changing its ID/text/priority. Preserve W0023 behind it.
6. Recover the current machine-created paused-from-idle breadth/metadata pause.
7. After all D175 commits/checks/reconciliation/deployment are complete, let the live
   supervisor dispatch W0027. Record proof that it transitions beyond `QUEUED`/idle
   into a real planning or working owner state. The D175 implementation commits must
   not contain W0027 product changes.

If live dispatch exposes an implementation failure, leave W0027 owned/checkpointed for
normal continuation; do not convert it back into a breadth/metadata human pause.

## Required regression tests

Add focused deterministic tests proving:

- an ordinary broad human-queued item auto-normalizes, plans, and reaches step 1 with
  the same ID, without prior epic metadata or human plan approval;
- a genuinely sensitive step requests one precise human authority and resumes from the
  same checkpoint after approval;
- explicit human pause remains sticky and is never auto-resumed;
- the current self-created paused-from-idle W0027-style reason auto-recovers;
- idle plus queued work dispatches exactly once without clicking Kickstart;
- no queued work remains quietly idle without a retry storm;
- concurrent watchdog/controller ticks cannot double-claim;
- transient endpoint/file-lock/timeout failures retry with bounded backoff and only the
  third identical genuine blocker escalates;
- plan-only and non-final steps do not enter runtime-promotion pending;
- final source-changing runtime replacement still requires explicit human approval;
- unrelated dirty tracked, staged, and untracked admin files survive a successful
  isolated main reconciliation byte-for-byte and status-for-status;
- a real isolated merge conflict stops before refs/push/branch sync and reports one
  actionable conflict rather than a generic dirty-worktree error;
- failed reconciliation leaves relay/source refs coherent and retryable;
- existing D171/D172 approval recovery and D174 archive behavior remain intact.

Also run and record:

- all new focused tests;
- canonical dashboard helper and approval-flow tests;
- `scripts/deploy-reciprocal-dashboard.ps1 -VerifyOnly` after deployment;
- live `GET http://127.0.0.1:4782/api/status`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

Do not hide fixed five-second Windows test timeouts. Where a command is semantically
healthy but regularly exceeds that limit under parallel suite load, make the test use
a justified deterministic timeout or faster fixture and retain its assertion.

## Safety constraints

- Preserve all unrelated user changes; do not reset, stash, discard, broadly clean, or
  commit them.
- No force-push, rebase, amend, or history rewriting.
- Do not weaken independent tests, candidate review, rollback, audit history, or the
  final live-runtime human approval.
- Do not silently install software, request credentials, weaken sandboxing, or perform
  external publication/payment.
- Do not implement W0027 inside D175 commits.
- Do not mark W0027 DONE merely because planning or dispatch began.
- Do not attribute workflow choices to model motives; record deterministic state and
  reason codes.

## Completion evidence

Use `D175-<n>:` commits for intended workflow/source/tests and commit
`handoffs/D175_done.txt` separately. The done marker must include:

- a gate inventory before/after, identifying every removed, automated, and retained
  hard human gate;
- exact files and commits;
- isolated reconciliation transaction evidence and before/after hashes/status for all
  unrelated dirty admin files;
- both Reciprocal heads, relay stable, and runtime BUILD_INFO before/after;
- proof no runtime promotion/replacement occurred;
- deployment manifest/live-status proof;
- all test results, including any initial timeout and focused rerun;
- W0027's exact before/after metadata and live relay transition proving it was actually
  dispatched beyond the previous bureaucracy;
- confirmation W0023 was not reordered ahead of W0027 and W0027 was not falsely marked
  complete.
