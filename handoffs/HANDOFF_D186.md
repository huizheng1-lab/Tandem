# Handoff D186 (make D185 passive-failure discrimination side-effect-safe, failure-equivalent, and correctly routed)

## Why D185 is not approved

D185's smoke-test repair and read-only stable-baseline test control work, and all
focused/full checks are green. Three actionable gaps remain.

### 1. The "isolated" control can replay live mutating lifecycle commands

`Invoke-StableBaselineControl` executes every supplied failed command in the detached
temporary worktree (`scripts/reciprocal-relay.ps1`, around lines 531-568). That only
isolates the current directory; it does not sandbox explicit paths or side effects.

`Pause-PassiveFailure` is also used after:

- package failure (around lines 1844-1862);
- Executor B runtime promotion failure (around lines 1891-1907);
- Executor B runtime launch failure (around lines 1929-1944).

Those commands contain the real admin repo, immutable package path, and/or live
`RelayRoot`. Replaying them as a "stable baseline" can rebuild release artifacts,
replace the live B runtime, stop/start processes, and rewrite live recovery evidence.
For promotion, rewriting the candidate SHA does not make the candidate package source
into a stable package. This violates D185's isolated-worktree/no-live-mutation safety
constraint.

### 2. "Same failure reproduced" is not actually proven

The classifier extracts only failing file paths, then sets `reproducedOnStable` when
*any* narrowed baseline command exits nonzero (around lines 480-566). A candidate-only
failure and a different pre-existing stable failure in the same test file are
therefore misclassified as `environment-failure`. The handoff requires the same
failure to reproduce, not merely the same file to contain some failure.

### 3. The new state is not safely routed by the supervisor/dashboard

`scripts/continue-reciprocal-automation.ps1` enters PassiveTest whenever
`state.candidateCommit` is present, even if the phase is paused (around lines
650-690). An `environment-failure` pause therefore causes the supervisor to invoke
PassiveTest while the relay rejects it with "valid only during passive-testing"; the
supervisor records that as an endpoint failure instead of performing a bounded
machine recovery.

The dashboard classifier also has no exact handling for either
`pauseReasonCode=environment-failure` or `candidate-failure`
(`dashboard-source/reciprocal-control-panel/lib.mjs`, around lines 273-330). Both can
fall through to an unrelated idle-dispatch action. The distinct D185 classification
is consequently not represented end to end.

## Corrective work

1. Separate read-only candidate validation failures from mutating package/promotion/
   launch failures.
   - Stable-baseline replay is allowed only for commands proven read-only and safe in
     the detached worktree.
   - Never replay package, runtime promotion, runtime start/stop, deployment, or any
     command carrying the live relay root as a baseline control.
   - Record lifecycle-operation failures durably as a distinct machine operational/
     environment prerequisite without blaming or rejecting the candidate. Preserve
     the candidate for a safe retry.
   - Keep all relay worktrees, runtime directories, processes, recovery journals,
     release artifacts, and live state untouched by diagnostic control runs except
     for the intended failure record/classification.

2. Prove failure equivalence conservatively.
   - For Vitest, capture comparable failed-test identities (file plus test name, with
     a normalized failure signature where necessary) from candidate and stable output.
   - Set `environment-failure`/`reproducedOnStable=true` only when at least one
     candidate failure identity is shown to reproduce on stable.
   - A different failure in the same file must not exonerate the candidate.
   - If equivalence cannot be established, retain a conservative non-environment
     classification and preserve enough evidence for review; never claim that stable
     reproduced the candidate failure without proof.

3. Route the classifications explicitly.
   - `candidate-failure` remains a hard, non-auto-resumable review gate.
   - A machine-origin `environment-failure` with a pending candidate is an
     auto-recoverable prerequisite. The continuation supervisor may perform the exact
     Resume -> PassiveTest retry only with bounded backoff and the existing circuit
     breaker.
   - Never auto-resume an explicit human pause, unknown-origin pause, candidate
     failure, or exhausted repeated blocker.
   - Do not invoke PassiveTest merely because `candidateCommit` is populated while
     the relay is paused.
   - Update canonical taxonomy consumers and dashboard status so both reason codes
     have accurate category, retryability, display state, and next action.

4. Preserve D185's good behavior:
   - console-independent candidate-preview smoke tests;
   - detached stable worktree for safe read-only controls;
   - candidate remains pending after an environmental/operational failure;
   - stable control never auto-accepts a candidate;
   - stale `passiveFailure` evidence clears at the established retry/accept boundaries.

## Required regression coverage

- A read-only candidate-only failing test remains `candidate-failure`.
- The exact same failing test on candidate and stable becomes
  `environment-failure`.
- Candidate and stable fail different tests in the same file: this must not be
  classified as the same environmental failure.
- Inject package, promotion, and launch failures. Assert each mutating helper is
  invoked only for the real candidate operation, never replayed by the baseline
  control, and assert live runtime/process/journal/release sentinels are unchanged by
  diagnosis.
- A machine-origin environment pause with a pending candidate is retried through one
  bounded Resume -> PassiveTest transition.
- Candidate-failure, human-origin pause, unknown-origin pause, and an exhausted
  circuit breaker are never auto-resumed.
- A paused relay with a candidate is never sent directly to PassiveTest before a
  permitted Resume.
- Dashboard/lib tests assert exact classification and next action for both
  `environment-failure` and `candidate-failure`.

Run the focused relay, supervisor, dashboard library, approval-flow, and candidate
preview suites, then `npm run typecheck`, `npm test`, and `git diff --check`.

## Live-state safety

The current W0027 candidate `83421bbc0cd5a8dd2832f194b66e8bf8e9d72eb1`
is paused on a newly proven candidate-only failure:
`tests\reciprocal-direction.test.ts` timed out on the candidate while stable passed
24/24. Do not auto-resume, exonerate, accept, deploy, or rewrite that candidate/state
as part of D186. It must remain a hard candidate-failure pending its normal human/
worker correction path.

If dashboard source is changed, deploy only through
`scripts\deploy-reciprocal-dashboard.ps1` and verify the managed source/target state;
do not hand-copy managed files. Preserve all unrelated user worktree changes.

Commit as `D186-<n>:` and create `handoffs/D186_done.txt` with the exact safety,
classification, orchestration, focused-test, full-test, and (non-mutating) live-state
evidence.
