# Handoff D178 (Complete the executable control path; no new policy gates)

## Corrective outcome

D177 improved pause provenance and basic retry reporting, but several acceptance
criteria remain represented only as metadata or helper assertions. Make those paths
actually execute end to end. This round must not add new gate categories, approval
layers, handoff requirements, or reasons that delay ordinary autonomous work.

Preserve W0027's ID, priority, status, owner, plan, dirty working-copy content,
checkpoint, and W0023 ordering. Do not edit or commit W0027 product/plan content.

## Confirmed review findings

1. The canonical taxonomy is loaded only by dashboard JS and
   `continue-reciprocal-automation.ps1`. `reciprocal-direction.ps1` and
   `reciprocal-relay.ps1` never load it and still write/compare literal categories,
   reason codes, and origins. The D177 fixture test therefore does not prove the
   required cross-process behavior.
2. Authority approval is internally contradictory. In
   `dashboard-source/reciprocal-control-panel/lib.mjs:128`, any supported
   `metadata.authority` is a hard gate regardless of `authorityStatus`.
   `ApproveAuthority` changes only `authorityStatus=pending` to `approved` while
   preserving `authority=...`; the dashboard/API therefore continue to classify the
   approved request as `hard-human-gate`. Direction can start that same approved item,
   so the consumers disagree. Declare/approve/deny also exist only as board mutations;
   there is no relay checkpoint state, guarded dashboard human action, or tested
   single-use resume of the exact checkpoint.
3. Deferred source reconciliation never executes. In
   `scripts/continue-reciprocal-automation.ps1:209-238`, the supervisor writes a
   pending/ready marker. At lines 441-451 it records an action only when status is
   `pending`; a `ready` marker invokes nothing. The only updater invocation is the
   manually confirmed `/api/main/update` route in `server.mjs:1648-1671`.
4. Main-update recovery handles only `pushed-not-synced`
   (`reciprocal-main-update.mjs:231-271`). A crash leaving
   `merged-not-pushed` or `tagged-not-pushed` is ignored and a second transaction can
   begin. Malformed transaction JSON is silently treated as no transaction at lines
   59-64. No test invokes this updater or any fault stage.
5. Supervisor recovery is still largely untested and partly unimplemented. The
   supervisor refreshes its lease once at entry, not during long passive tests or
   prompts. Passive-test, state/JSON, file-lock, and other controller exceptions can
   escape the top-level flow without entering the persisted retry policy. The entire
   D177 supervisor test file has only two cases: lease contention/reclaim and a
   pre-seeded backoff/hard-blocker object. It does not produce failures through the
   real controller or prove startup dispatch, overlap safety, retry escalation/reset,
   machine-pause recovery, or a long-lived owner.
6. Independent review checks all pass, but do not cover the defects above: 40 focused
   tests, dashboard nodecheck, 2 approval E2E tests, deploy `-VerifyOnly`, typecheck,
   517 full tests with 1 skipped, and `git diff --check`.

## Required corrective work

### 1. Make the existing taxonomy authoritative in every process

- Load and strictly validate the same canonical taxonomy in direction, relay,
  supervisor, dashboard/API, and their tests. Do not copy its values into another
  hard-coded table. Missing or invalid taxonomy must stop safely with an actionable
  error.
- Replace gate category/code/origin/retry literals in direction and relay with values
  from that loaded policy wherever they participate in decisions or persisted state.
- Add an integration fixture that changes representative category, code, origin, retry
  limit, and display values and proves each real consumer observes the changes. A test
  that merely returns the fixture object is insufficient.

### 2. Finish one exact, single-use authority checkpoint lifecycle

- Model a pending exact-step authority request in relay state/audit with the same
  authority kind, action, checkpoint, resume action, item ID, and owner as the board.
  Declaring it pauses that exact checkpoint once without dropping progress.
- Expose approve/deny through the existing authenticated/explicit-human dashboard
  control boundary. Executor/supervisor automation must not be able to self-approve.
  Keep the PowerShell mutation guarded so a direct automation call cannot impersonate
  a human approval.
- Pending is `hard-human-gate`; denied remains stopped. Approved must cease being a
  gate, resume the same owner/checkpoint exactly once, and be consumed/recorded so
  later ticks cannot repeat the authority action. API, UI, relay, direction,
  supervisor, and audit must report the same state.
- Preserve the separate final live-runtime replacement authority. Do not broaden any
  authority grant or infer it from prose.

### 3. Execute deferred reconciliation automatically at the existing safe boundary

- When the durable source marker changes to `ready`, the leased recurring supervisor
  must invoke the resumable updater exactly once, with an auditable noninteractive
  system comment/idempotency key. Do not require a click, another handoff, or another
  approval; the previously approved source update is already pending.
- Re-read state immediately before execution and abort back to `pending` if an owner,
  candidate/rollback, non-idle phase, or dirty reciprocal worktree appears. One
  controller lease must prevent overlapping invocations.
- On success, verify both reciprocal branch heads and the stable ref equal the
  integrated source, clear the pending marker, reset the related blocker, and allow
  ordinary idle dispatch in the same or next bounded tick. On recoverable failure,
  persist the existing retry/backoff category; on invariant corruption, surface one
  truthful hard blocker.
- Do not make admin cleanliness a reason to block remote/reciprocal convergence. Keep
  local `master` deferred when the admin worktree is dirty, preserving its exact index
  and files.

### 4. Complete transaction and supervisor crash recovery

- At updater startup, validate the transaction schema and deterministically resume or
  roll back every declared stage: `merged-not-pushed`, `tagged-not-pushed`, and
  `pushed-not-synced`. Never silently discard malformed transaction state or start a
  second operation over it.
- Make every injected stage converge on retry to one remote commit, one annotated tag,
  matching reciprocal heads/stable ref, and byte/index-identical admin dirt. A real
  conflict must mutate no remote, tag, reciprocal branch, stable ref, or admin index.
- Route recoverable passive-test, endpoint/startup, command, file-lock, JSON/state
  write, and prompt failures through the existing persisted fingerprint/backoff
  policy. Enforce backoff, hard-block only on the configured identical-failure limit,
  and reset after a real transition or changed fingerprint.
- Keep the lease alive during long work, or use a process-identity proof that prevents
  stealing a live owner after TTL. Token-mismatched cleanup must remain harmless.

## Required acceptance tests

Use real process boundaries and temporary repositories where applicable:

- Modified taxonomy fixture values are observed by JS, direction, relay, supervisor,
  API/UI status; invalid/missing taxonomy fails safely.
- Pending authority pauses one exact checkpoint. A dashboard-authenticated approval
  resumes it once and clears the hard gate; a second tick does not repeat it. Direct
  automation self-approval fails. Denial and final runtime authority remain stopped.
- A ready source marker is executed automatically by the recurring supervisor, exactly
  once under overlapping ticks. An unsafe boundary stays pending without mutation.
  Successful reconciliation clears the marker and enables idle dispatch.
- Temporary Git repositories cover all updater fault stages and all transaction stages,
  malformed transaction data, dirty tracked/staged/renamed/deleted/untracked paths
  including spaces, exact index preservation, and a real merge conflict.
- Supervisor tests cause real failures for passive test, endpoint/prompt, file lock,
  and malformed state; prove persisted restart/backoff, configured escalation, changed
  fingerprint/success reset, long-operation lease retention, dead lease reclaim, and
  overlap without double claim.
- Startup idle plus queued work dispatches once without Kickstart. Explicit human pause
  stays sticky; machine-created planning pause recovers; the current repeated-resume
  circuit breaker remains a truthful machine blocker until a guarded checkpoint
  decision is made.
- Existing D171-D177 tests continue to pass. Run focused tests, dashboard nodecheck and
  approval E2E, deployment `-VerifyOnly`, `npm run typecheck`, `npm test`, and
  `git diff --check`.

## Live completion evidence and safety

- Record before/after W0027 board line, relay owner/checkpoint, copy-B status, plan
  hash, and checkpoint hash. They must be unchanged by D178.
- Deploy D178 dashboard source. While W0027 is still unsafe, leave source
  reconciliation pending and do not claim convergence. Prove automatic execution in a
  safe isolated fixture; if the live safe boundary occurs naturally, record the exact
  one-time transition.
- Do not manually clear or resume the current repeated-resume circuit breaker, edit or
  commit W0027 plan/product content, reset/clean/stash either reciprocal worktree, or
  promote/replace pinned Executor runtimes.
- Preserve unrelated user changes and D174 archive. No reset, stash, broad clean,
  force-push, rebase, amend, or history rewrite.
- Do not add policy gates. Existing explicit human authority remains limited to
  credentials/authentication/pairing, permission or sandbox weakening, destructive
  data/history changes, payment/publication, and final live-runtime replacement.

Commit intended work as `D178-<n>:` and record `handoffs/D178_done.txt` separately with
exact commits, tests, deployment proof, transaction/fault evidence, and preservation
hashes.
