# Handoff D192 (D190 closed only half the stale-script hole: the post-Complete PassiveTest still ran a pre-D185 relay via the stale injected template — evidence-free false gate on candidate efb3b06; add a hard version boundary, not more path fixes)

## Live incident (verified — don't re-derive)

W0027 step 3/3 candidate `efb3b06a37390fcf191eb9f07f4fa479d49faee7` completed and
entered passive testing at 18:11Z; at 18:27Z the relay paused
`pauseReasonCode: "candidate-failure"` with **`passiveFailure: null`** — the
evidence-free signature that the D185+ gate can never produce (it always writes a
baseline-control or lifecycle-operation record). An old relay script ran the gate
again. Verified:

- `copy-b` (Executor A's project dir) is checked out at the candidate `efb3b06`;
  its `scripts/reciprocal-relay.ps1` contains **0** occurrences of
  `passiveFailure` — the reciprocal branch lineage (`c06f659 → 83421bb → efb3b06`)
  has never contained D185–D191, which live only on admin master.
- `copy-b`'s `process/reciprocal/TANDEM_EXECUTOR_A.md` line 34 still instructs the
  bare relative `scripts/reciprocal-relay.ps1 -Action PassiveTest` (master's
  D190-updated template uses the absolute admin path, but the template the agent
  actually receives is injected from the stale checkout).
- D191's schedule prompt fixed the *Claim* entry point (admin path), and D190
  fixed the commands the *relay emits* — but after `Complete`, the agent followed
  the stale checkout template for the immediate PassiveTest chaining and executed
  the pre-D185 script. Old script → old blind pause: no baseline discrimination,
  no evidence, candidate blamed.

The `npm test` failure it reported is therefore **untrusted** — unknown whether
real (step 3/3 regression) or environmental; there is no evidence either way.

## Fix — a hard boundary plus the fair re-test

### Part 1: stale relay scripts must be unable to operate, period

Path/template fixes keep leaking because the executor consumes files from a
checkout that by design lags master. Add a **hard version boundary in the shared
state** so any pre-D185 (or generally, any older-generation) relay script
hard-refuses instead of silently running old logic. Recommended mechanism (choose
and justify; the requirement is the boundary, not the specific knob):

- Bump `schemaVersion` in `.git/tandem-relay/state.json` (e.g. 2 → 3) with the
  current admin script accepting/migrating the previous version once. Every stale
  script already throws on an unknown schemaVersion (they check `-ne 2`), which
  turns "silently ran the old gate" into a loud, immediate, attributable error.
- Additionally (defense in depth, cheap): keep updating templates/emitted commands
  to absolute admin paths, and have the admin relay's `COMPLETED` result carry the
  admin-path PassiveTest command the same way `Claim`'s `PASSIVE_TEST` outcome
  does, so the agent never needs the checkout template for chaining.

Regression: a fixture "stale" relay script (or a state file with the new
schemaVersion presented to the old parser expectation) proves the stale path now
fails loudly with a distinct error rather than producing an evidence-free pause.

### Part 2: also fix the underlying staleness where feasible

Evaluate and implement the sane subset (justify what you skip):
- Inject TANDEM.md / executor instructions from the **admin repo's current
  templates** rather than the project checkout, or overlay the admin gate-command
  section at injection time.
- Consider whether master reconciliation cadence should fold admin-side
  gate/process improvements into the reciprocal branch lineage more promptly, so
  worktree checkouts stop lagging the gate infrastructure by six rounds. Update
  PROTOCOL.md with whatever invariant you land on.

### Part 3: fair re-test of efb3b06

Clear the evidence-free pause (reference this handoff in the `-Summary`) and run
PassiveTest for `efb3b06` through the current admin gate. If it genuinely fails
`npm test`, the pause must show a full evidence record (failing test identities,
baseline discrimination) — that outcome is acceptable and simply routes W0027
step 3/3 back for correction. If it passes: this is the epic's final
source-changing step, so the relay must stop at `a-upgrade-pending` for the human
promotion gate — do NOT complete the A upgrade autonomously.

## Constraints

- No weakening of gate checks or classification rules.
- The schemaVersion migration (if chosen) must be one-time, explicit, audited,
  and fail-closed on anything unexpected — per the D187 lessons.
- Do not touch the D187 quarantine artifacts.
- Do not advance/accept `efb3b06` without a genuinely green admin-gate run, and
  do not cross the `a-upgrade-pending` human gate.

## Acceptance

`handoffs/D192_done.txt`: the chosen boundary mechanism and proof a stale script
now fails loudly; template/injection changes; live proof of `efb3b06` re-tested
under the admin gate with a full evidence record (whatever the verdict), ending
either at `a-upgrade-pending` (green) or a properly-evidenced candidate-failure
(red). tsc + `npm test` green. Commit `D192-<n>:`. Create
`handoffs/D192_done.txt`.
