# Handoff D185 (passive gate cannot distinguish "candidate broke tests" from "environment broke tests" - add a stable-baseline control run; also fix the console-dependent smoke tests that just caused a live false-negative pause)

## Live incident (confirmed by independent reproduction, don't re-derive)

W0027 step 2/3's candidate `83421bbc0cd5a8dd2832f194b66e8bf8e9d72eb1` failed passive
testing on `npm test` and the relay machine-paused with
`pauseReasonCode: "candidate-failure"` (state as of 2026-07-23T11:57Z, turn 6,
`pausedFromPhase: "passive-testing"`). Per the gate taxonomy this is treated as a
hard-human-gate - an uncorrectable deterministic candidate failure.

But the candidate is innocent. I reproduced the failure independently:

- The 2 failing tests are both in `tests/candidate-preview-smoke.test.ts` (D164's GUI
  smoke tests): "treats a responsive long-running GUI process as ready" and "times out
  readiness and cleans up the launched process". Both fail deterministically in
  `copy-a` at the candidate commit.
- **The same 2 tests fail identically on `master` (`512763e`) in the admin repo**,
  which contains none of the candidate's changes. Verified by running
  `npx vitest run tests/candidate-preview-smoke.test.ts` in both checkouts back to
  back. The failure is environmental drift, not the candidate.
- Mechanism: those tests simulate a long-running/hung GUI process with a `.cmd` that
  runs `timeout /t 60 /nobreak >nul`. Windows' `timeout` command exits immediately
  with an error ("Input redirection is not supported...") when stdin is not a real
  console. In the current launch context that makes the "hang" script exit instantly,
  so the smoke script sees an early exit (outcome "crash", exit code 4) where the test
  expects a hang (readiness-timeout, exit code 5). Something about the test-runner's
  console context shifted since D164 landed; the tests were always latently
  console-dependent.

Two earlier passive-gate failures this project already hit (W0014 step 2's and W0016
step 2's `npm test` timeouts, both resolved by manual human retry) were the same class
of gap in milder, flaky form: the gate blamed the candidate for a failure the
candidate didn't cause, and a human had to notice and intervene each time.

## Fix - two parts, both required

### Part 1: baseline control run in the passive gate

When any mechanical check fails during `PassiveTest` (`scripts/reciprocal-relay.ps1`),
before pausing with `candidate-failure`, automatically discriminate:

1. Identify the failing test file(s) from the failed check's output (for `npm test` /
   vitest, the failing spec paths are in the output; if parsing them is unreliable,
   re-running the whole failed command is an acceptable fallback).
2. Re-run just those failing test files (or the whole failed command as fallback)
   against the **current stable commit** in the same environment. The isolated
   temporary-worktree machinery that master reconciliation already uses (per
   PROTOCOL.md's "Master Reconciliation" section) is the right pattern for checking
   out stable without disturbing the relay worktrees - reuse it rather than switching
   a live relay worktree's checkout.
3. If the same failure reproduces on stable: this is NOT a candidate failure.
   Classify it distinctly (e.g. `pauseReasonCode: "environment-failure"` or an
   auto-recoverable-prerequisite category entry per the gate taxonomy), record which
   tests failed on both sides in the pause summary, and do NOT frame the candidate as
   rejected - the candidate should remain pending, eligible for automatic re-test
   after the environment issue is resolved, rather than requiring the human to
   exonerate it manually.
4. If the failure does NOT reproduce on stable: keep exactly today's behavior
   (`candidate-failure`, hard gate, human inspection).

Decide the details of how the baseline result is recorded/audited yourselves, but the
discriminating re-run and the distinct classification are the non-negotiable core.
Bound the extra cost sensibly (the control run only happens on failure, which is
already the rare path).

### Part 2: fix the console-dependent smoke tests

Replace the `timeout /t 60 /nobreak >nul` hang-simulation in
`tests/candidate-preview-smoke.test.ts` (both occurrences - the "responsive
long-running" test and the "readiness timeout" test, around lines 55-90) with a
console-independent long-running command - e.g. a `.cmd` that runs
`powershell -NoProfile -Command Start-Sleep -Seconds 60`, or a `ping -n 61 127.0.0.1
>nul` loop - something that keeps running regardless of whether stdin is a console.
Verify both tests then pass in the same context where they currently fail (plain
`npx vitest run tests/candidate-preview-smoke.test.ts` from a non-console-attached
runner in the admin repo at master + this fix).

### Unblock the live state

After Part 2 makes the suite genuinely green, recover the currently-paused relay so
W0027 step 2's candidate `83421bb` gets a fair re-test: resume from the pause and
re-run `PassiveTest` (or let the continuation supervisor do it if it now handles this
case). The candidate should pass once the environmental test bug is fixed - if it then
fails on something REAL, that's a genuine candidate-failure and should pause again
normally. Note W0023 step 3/3 (Telegram approval integration, PLAN_APPROVED) is queued
behind W0027's in-flight step, so unblocking this also unblocks that.

## Constraints

- Do not weaken, skip, or quarantine-forever any test as the "fix" - Part 2 is about
  making the hang-simulation robust, not about excluding the smoke tests from the
  gate. The smoke tests' actual assertions (ready / crash / timeout / missing-exe
  classification) must all remain fully enforced.
- Do not let the baseline control run mutate the relay worktrees' checkouts or the
  relay state beyond the new classification fields - isolated worktree only.
- Do not auto-accept a candidate just because the failure was environmental - the
  candidate still needs a genuinely green passive run before stable advances. The
  control run only changes the *classification and recovery path* of a failure, never
  grants a pass.
- Keep the hard gate for true candidate failures exactly as-is.

## Acceptance

Explain in `handoffs/D185_done.txt` how failing tests are identified, how the stable
baseline is checked out and exercised in isolation, and what the new classification
looks like in `state.json`/audit output. Regressions: (a) a candidate-failure that
does NOT reproduce on stable still pauses as `candidate-failure`; (b) one that DOES
reproduce on stable gets the environmental classification and leaves the candidate
pending rather than rejected; (c) the repaired smoke tests pass in a non-console
context and still correctly distinguish ready/crash/timeout/missing. Live proof: the
real currently-paused relay recovered, candidate `83421bb` re-tested fairly, and the
relay advancing (or pausing again only on a genuinely new, real failure) - show the
real state transitions. tsc + `npm test` green (which now includes the repaired smoke
tests). Commit `D185-<n>:`. Create `handoffs/D185_done.txt`.
