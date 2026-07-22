# Reciprocal Tandem Protocol

This protocol keeps the two-copy self-modification safety boundary while removing the old two-producer handoff. Executor A is the only producer. It edits and commits on copy B (`codex/reciprocal-b`), which is not the worktree or runtime it is running from. Executor B does no agentic wishlist work. B's copy (`codex/reciprocal-a`) is only the passive build/launch test subject for A's completed candidate.

## State Machine

The relay state lives in the common git directory under `tandem-relay/state.json`, with durable refs for `refs/tandem-relay/stable`, `refs/tandem-relay/candidate`, and rollback recovery.

Normal lifecycle:

1. `idle`, `nextRole=A`: A may `Claim`.
2. `working`, `activeRole=A`: A claims a human wishlist item, plans, implements, runs its internal Tandem leader/worker/review lifecycle, verifies, and reports the exact changed files. Tandem's unsandboxed app layer stages only those files, creates one `relay:` commit, marks the wishlist item `CANDIDATE`, and runs `Complete`.
3. `passive-testing`, no active owner: A's candidate is pending. No executor may start new wishlist work. `Claim -Role A` reports `PASSIVE_TEST`; `Claim -Role B` reports passive `WAIT`. Run `PassiveTest -Role A` from copy A (`codex/reciprocal-a`). It fast-forwards the passive copy to the candidate, runs mechanical checks, packages the Electron app into the admin repo's canonical `release/win-unpacked`, and refuses to call a model.
4. `a-upgrade-pending`, no active owner: the passive copy accepted a final source-changing candidate and the stable ref now points at it, but A's running runtime has not been promoted from that same verified build. `PrepareAUpgrade -Role A -DryRun` exposes the exact `promote-reciprocal-runtime.ps1 -TargetRole A` command and records the human gate. `CompleteAUpgrade -Role A -Force` is valid only after a human confirms the A runtime promotion. Plan-only candidates and accepted non-final epic steps return to `idle` and continue automatically; they do not require live runtime replacement.
5. Back to `idle`, `nextRole=A`.

Failure and recovery:

- `RESUME` still applies only to A's interrupted `working` turns and uses `.tandem/reciprocal-checkpoint.md`, pending candidates, or rollback state to distinguish real recovery from stale empty ownership.
- Passive check failure pauses the relay with `pausedFromPhase=passive-testing` and leaves the candidate for human inspection. It does not hand work to B.
- The older `Validate`, `Accept`, `Rollback`, and `CompleteRollback` commands remain manual recovery tools for legacy or human-directed rollback situations. They are not part of the normal producer lifecycle and must not be scheduled as B work.
- `Reset -Force` remains the heavy human recovery path.

## Gate Taxonomy

The control plane records and reports one of three categories for every stop or wait:

- `hard-human-gate`: only explicit human pause/cancel/reject, credentials/authentication/pairing, permission or sandbox weakening, destructive history/data operations, paid or external publication, final live Executor runtime replacement, or an uncorrectable deterministic candidate/test failure may stop autonomous progress.
- `auto-recoverable-prerequisite`: broad or architectural human work, missing epic metadata, missing plan files, paused-from-idle planning wording, stopped executors with authenticated restart available, stale reciprocal source branches, unrelated dirty admin checkout files that can be proven untouched, and transient endpoint/file-lock/timeout noise must be retried or repaired automatically with bounded backoff.
- `waiting-not-blocked`: an active owner, passive test, candidate review, runtime review wait, or retry backoff is normal progress and must not be described as a hard block.

A broad human-queued item is authorization to plan. It is not a reason to pause. The shared direction script may normalize any ordinary `QUEUED` item into `epic=true phase=PLAN` while preserving its ID, priority, text, and audit history.

## Executor A Producer Rules

Start each invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A
```

Interpret the result:

- `CLAIMED`: begin or continue one producer lifecycle in `working`.
- `RESUME`: inspect `.tandem/reciprocal-checkpoint.md` and resume the same A lifecycle.
- `PASSIVE_TEST`: switch to copy A and run the returned passive test command. Do not start new work.
- `A_UPGRADE_PENDING`: stop for the human A-runtime promotion gate only when the candidate is a final source-changing runtime replacement.
- `WAIT` or `PAUSED`: stop with a short status. If the pause is machine-created from idle because work was broad, architectural, missing a plan, or missing epic metadata, the continuation supervisor must recover it automatically rather than requiring another human decision.

Do not begin implementation until the relay is in `working`. Read live work state from `.tandem/shared-control/WISHLIST.md` with `scripts/reciprocal-direction.ps1 -Action Show`, then claim the highest-priority safe human item with `Start -Id <id> -Role A`. If the item is ordinary queued work without epic metadata and it is too large for one candidate, first run `NormalizeQueued -Id <id>` and produce `process/reciprocal/epics/<ID>-plan.md`; do not pause merely because a plan is missing. Durable human direction lives in `.tandem/shared-control/SHARED_DIRECTION.md`. If no human item exists, report idle status; do not invent `[AUTO]` work unless a human later changes this rule.

Maintain `.tandem/reciprocal-checkpoint.md` with the objective, wishlist ID, intended files, evidence, checks already run, current phase, and next action. Update it after each major phase.

Run focused tests for changed behavior plus, at minimum:

- `npm run typecheck`
- `git diff --check`

The plan must still list `authoritative-only: npm test`; Tandem's authoritative runner executes the full suite outside the producing Codex sandbox after the worker returns. The passive gate repeats the full suite mechanically before trust advances.

Never run `git add`, `git commit`, wishlist `Candidate`, or relay `Complete` inside the sandboxed producer turn. Return a completion report with exact `filesChanged` and a concise summary. The app layer performs the guarded commit and relay completion.

## Passive B Gate

B has no schedule and no wishlist prompt loop. It may be launched so copy A can run as a separate runtime/process, but it must not claim, plan, implement, review, validate, or autonomously continue wishlist items. Under D151, B's `Claim` always returns passive `WAIT`.

`PassiveTest -Role A` is the normal acceptance gate. It must run from copy A on `codex/reciprocal-a`; it fast-forwards to the candidate and runs:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --`
- `scripts/package-passive-runtime.ps1`, which runs Electron packaging in a fresh output directory, verifies `Tandem.exe`, stamps `BUILD_INFO.json`, and swaps it into the admin repo's `release/win-unpacked`

Passing passive checks advances `refs/tandem-relay/stable`, updates the shared direction item when a matching candidate is found, clears the candidate, and enters `a-upgrade-pending`. Failing checks pause from `passive-testing`.

## A Runtime Upgrade Gate

Self-modification safety also means A must not redeploy its own live runtime. After `PassiveTest` packages the verified candidate and the human confirms the candidate preview's functional behavior, a human uses the existing promotion helper to promote A from that same verified canonical build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/promote-reciprocal-runtime.ps1 -TargetRole A -SourceSha <stable-commit>
```

Use `-DryRun` to demonstrate the target and source without changing runtime files. Only after human confirmation may the relay be released:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action CompleteAUpgrade -Role A -Force -Summary "<human confirmation>"
```

## Epics

Epics still span multiple one-commit A lifecycles.

1. The first `Start` on a queued epic is plan-only. Commit only `process/reciprocal/epics/<ID>-plan.md` and mark it as a plan candidate.
2. Fully autonomous epic plan approval may return an `autonomousContinuation`, but D151 adds a human A-upgrade gate before any next step can start. The continuation is recorded for A and marked `requiresHumanGate=true`.
3. Approved epic steps remain one step per A candidate. Do not skip, reorder, or combine steps.
4. Plan-gated epics, authentication, credentials, pairing, remote-control surfaces, runtime promotion, master integration, and protocol safety changes remain human-gated.

## Safety Boundaries

- A edits only copy B while producing. Passive testing runs only on copy A. A never edits or rebuilds its own live runtime.
- B does no agentic reciprocal work.
- Synchronization is fast-forward-only. Never rebase, amend, force-push, reset, or rewrite relay history.
- Every improvement is one candidate commit whose parent is the current stable commit.
- Do not weaken required checks, suppress failures, disable assertions, or mark work done merely because the producer reported success.
- Treat pre-existing dirty work as a recovery signal. Resume only when the relay says `RESUME`.
- Keep turns narrow. If a change is architectural, ambiguous, or too large for one stable increment, normalize it into an autonomous plan and implement the smallest coherent vertical slice. Pause only at the exact sensitive step that requires new authority or after the same genuine blocker repeats three times without a successful state transition.

## Master Reconciliation

`master` remains trunk. Reconciliation must run through an isolated temporary worktree/index so unrelated dirty admin files are snapshotted, byte-hashed, and preserved untouched. The dashboard's main-branch gate verifies the stable commit, updates `master`, tags the update, and fast-forwards both reciprocal branches only after isolated validation and push succeed. If a D-round lands on `master` mid-batch, finish or pause the active reciprocal state first, then reconcile before A claims more work.
