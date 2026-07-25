# Handoff D193 (tests/reciprocal-direction.test.ts's 5s default timeout has caused three false passive-gate failures today — give the process-spawning suite realistic timeouts, then fair re-test efb3b06)

## Evidence (all from today, don't re-derive)

Three separate passive-gate incidents were caused by 5000ms vitest timeouts in
`tests/reciprocal-direction.test.ts`, a different test each time, on runs where
the same tests pass standalone in ~2-3s:

1. ~13:23Z: candidate `83421bb` blamed for "canonicalizes an accepted abbreviated
   plan commit during auto-approval" timing out at 5010ms (reviewer later proved
   it passes standalone 3/3 runs; resume + quiet machine → PASSIVE_ACCEPTED).
2. 18:46Z: candidate `efb3b06` run — a timeout in this file failed on BOTH
   candidate and stable → correctly classified environment-failure, auto-retried.
3. 18:58Z: the bounded retry — "removes a queued item while preserving its
   original line and reason" timed out at 5000ms on the candidate while stable
   failed a different identity → conservative `candidate-failure` hard gate,
   which is where the relay sits now (candidate `efb3b06`, W0027 step 3/3,
   evidence record present and correct).

Every test in this suite shells out to `powershell` + git repeatedly; each child
process costs ~0.5-2s even unloaded. Under any concurrent activity (a second
executor, npm ci, another vitest run — all normal on this machine), 5s is
routinely exceeded. The file already acknowledges this by giving some tests
explicit `30_000` timeouts (e.g. around line ~415) — the rest of the suite just
never got the same treatment.

## Fix

1. Set a realistic timeout for the whole suite (file-level `testTimeout` — e.g.
   30-60s — via the describe/config options in that file, or a targeted vitest
   config entry for process-spawning integration suites), instead of per-test
   spot fixes. Audit the other suites that spawn PowerShell/git children
   (`reciprocal-relay.test.ts`, `reciprocal-supervisor.test.ts`,
   `reciprocal-main-update.test.ts` — the last one produced today's 9.9s timeout
   on stable during the 16:45Z incident) and apply the same standard where the
   default 5s is objectively marginal.
2. This is a timing-budget correction, not a weakening: no assertion changes, no
   skips, no quarantines. A genuinely hung child still fails at the raised limit.
3. After the fix commit exists: clear the current hard pause (reference this
   handoff in `-Summary`) and give `efb3b06` its fair PassiveTest under the admin
   gate. Note the gate tests the CANDIDATE tree, which won't contain this fix —
   if the same marginal timeout recurs on the run, prefer re-running on a quiet
   machine (no concurrent heavy processes) as the D193 live proof; do not
   hand-wave a red run into an acceptance.
4. If the re-test is green: the relay must stop at `a-upgrade-pending` (final
   source-changing step of the W0027 epic) for the human promotion gate — do not
   cross it autonomously.

## Constraints

- No assertion/coverage weakening anywhere; only timeout budgets.
- Do not touch the D192 boundary work (in flight) beyond rebasing normally.
- Do not advance `efb3b06` without a genuinely green run; do not cross the human
  A-upgrade gate.

## Acceptance

`handoffs/D193_done.txt`: which suites/timeouts changed and why those numbers;
tsc + `npm test` green; live proof of `efb3b06` re-tested fairly, ending at
`a-upgrade-pending` (green) or a full-evidence candidate-failure (red, with the
failing identity clearly not a timeout artifact). Commit `D193-<n>:`. Create
`handoffs/D193_done.txt`.
