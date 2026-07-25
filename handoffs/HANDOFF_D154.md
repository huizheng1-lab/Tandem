# Handoff D154 (dashboard's "Approve & Promote" flow does the entire runtime promotion but never releases the D151 A-upgrade gate - leaves the relay stuck showing `a-upgrade-pending` forever)

This is dashboard-only work (`C:\Users\huizh\Apps\Tandem Reciprocal\dashboard`, outside
this repo, same as D151/D152/D153's dashboard-side changes).

## Live bug (confirmed, don't re-derive)

A human used the dashboard to review the real W0014 search feature (via `Launch
Candidate`), then clicked **Approve & Promote**. The flow genuinely worked end to end -
audit log confirms every step succeeded: `relay-paused` -> `review-recorded` (decision
`approve`, comment "the search function works") -> `executors-stopped` -> `runtime-
promoted` (both A and B confirmed running `sourceSha 396a18d`, real `Tandem.exe` file
listing with matching timestamps) -> `executors-restarted` (both PIDs confirmed alive
and responding) -> `relay-resumed`. The final audit entry is
`update.approvePromote {"ok":true,...,"status":"completed"}`.

But the relay's own `state.json` still shows `phase: "a-upgrade-pending"` with the same
`stableCommit` as before, completely unchanged by any of this - as if the human upgrade
confirmation never happened, even though it functionally already did (both executors
are verifiably running the promoted build right now). The dashboard's "Relay Phase"
card is stuck reading "A-Upgrade-Pending" forever after a fully successful approval,
which is exactly what surfaced this: the human asked "what's going on now after i have
hit approve and promote," correctly confused because nothing visibly changed on the
one card that matters.

## Root cause (confirmed by reading the code, don't re-derive)

`runApprovalFlow` (`server.mjs:887-938`) and its helpers `waitForApprovalBoundary`
(`server.mjs:830-876`) / `resumeApprovalPause` (`server.mjs:823-828`) predate D151's
`a-upgrade-pending` / `CompleteAUpgrade` state machine addition. They generically
`Pause` the relay (whatever phase it's in) before doing the stop/promote/restart work,
then call a plain `relayControl("Resume", ...)` at the end
(`resumeApprovalPause`, `server.mjs:825`). `Resume` (in `reciprocal-relay.ps1`) simply
restores whatever `pausedFromPhase` was recorded at pause time - so pausing from
`a-upgrade-pending` and then resuming just puts the relay right back into
`a-upgrade-pending`, as if nothing happened. Nothing in this flow was ever updated to
know that D151 introduced a *different*, more specific un-pause action -
`CompleteAUpgrade -Role A -Force -Summary <text>` - which is what actually closes the
A-upgrade gate and returns the relay to `idle`. `CompleteAUpgrade` did not exist when
this approval flow was written; D151 added it as a new relay action without updating
this older, still-active consumer of the generic pause/resume primitives.

## Fix

In `runApprovalFlow`, after the runtime promotion genuinely succeeds (after the
`executors-restarted` step, in place of or immediately alongside the existing
`resumeApprovalPause` call at `server.mjs:923`), check
`flow.interruptedPhase` (already captured in `waitForApprovalBoundary`,
`server.mjs:832-833`) - if it was `"a-upgrade-pending"`, call
`relayControl("CompleteAUpgrade", ...)` instead of a plain `Resume`, since that's the
action that actually matches what this flow just did (a human-confirmed runtime
promotion). `relayControl` (`server.mjs:806-813`) currently only passes
`-Action`/`-Summary`/`-Workspace` - extend it (or add a small variant) to also pass
`-Role A -Force` when the action is `CompleteAUpgrade`, matching the CLI invocation
already used elsewhere (e.g. `PrepareAUpgrade`'s dry-run command string built in
`reciprocal-relay.ps1`'s `Claim` handler). For every other `interruptedPhase` (the
flow's original generic case - relay was mid-`working`/`idle`/already-`paused`, not at
the upgrade gate), keep the existing plain `Resume` behavior exactly as it is now -
this fix must be additive for the `a-upgrade-pending` case only, not a rewrite of the
whole flow.

## Constraints

- Do not touch the mechanical promotion steps themselves (`executors-stopped`,
  `runtime-promoted`, `executors-restarted`) - they worked correctly and are already
  proven live (see the audit log evidence above).
- Do not remove or weaken the underlying `CompleteAUpgrade` human-gate semantics
  (`-Force` + a human-readable `-Summary` still required) - this fix makes the
  dashboard's own approval flow correctly *supply* that confirmation as part of the
  single button click, since clicking Approve & Promote and reviewing the real running
  build *is* the human confirmation; it does not bypass or automate away human review.
- Do not change behavior for approval flows that don't originate from
  `a-upgrade-pending` (e.g. a flow triggered while the relay was merely `idle` or mid-
  `working`) - only add the `CompleteAUpgrade` branch for that specific interrupted
  phase.

## Acceptance

Explain in `handoffs/D154_done.txt` exactly how `interruptedPhase` is threaded through
to the final resume/complete decision. Add a regression (or extend an existing
dashboard test, if one already covers `runApprovalFlow`) proving that when the relay is
paused from `a-upgrade-pending`, the flow calls `CompleteAUpgrade` rather than `Resume`
at the end, and that other interrupted phases still get plain `Resume`. Live proof:
since the real relay is currently stuck exactly in this state right now (paused... no,
currently sitting at `a-upgrade-pending` with a fully-promoted, already-running build,
per the audit log above) - this is unusual: a human must not click Approve & Promote
again to test this fix, since it's already been approved and both executors are already
running it (re-running the whole stop/promote/restart cycle would be pointless churn on
an already-correct runtime). Trigger the fix's `CompleteAUpgrade` call directly against
the real stuck state instead (a scoped, human-visible action, not a full re-run of
Approve & Promote), or reproduce the exact scenario end-to-end against a safe test
double/fixture relay state rather than the live one. Either way, show the real relay
transitioning from the stuck `a-upgrade-pending` to `idle` as a direct result of this
fix, and confirm the dashboard's "Relay Phase" card correctly reflects `idle` afterward.
tsc/build checks for anything touched in this repo (if any) green; dashboard's own
`node --check`/test suite (per D152/D153 precedent) green. Commit `D154-<n>:` for any
in-repo changes (likely none); create `handoffs/D154_done.txt` regardless.
