# Handoff D155 (multi-step epics currently require a human A-upgrade confirmation after EVERY step, not just the final one - make intermediate steps fully automatic)

## The gap (confirmed by reading the code, don't re-derive)

In `PassiveTest`'s success path (`scripts/reciprocal-relay.ps1`, around line 1094-1133),
`$state.phase = "a-upgrade-pending"` is set **unconditionally** at line 1112 - before
the code even checks whether `$continuation` (the result of
`Complete-AcceptedDirectionCandidate`, non-null when a multi-step epic has more steps
remaining) is populated. So today, every single accepted candidate - whether it's the
genuinely final commit of an epic or just step 1 of 3 - forces the relay into
`a-upgrade-pending` and blocks any further `Claim` until a human runs
`CompleteAUpgrade` (directly, or via the dashboard's Approve & Promote button, D154).
For a 3-step epic this means a human has to manually clear the upgrade gate three
separate times before the epic can even finish, with Executor A sitting idle each time
waiting on that confirmation.

This directly contradicts the intended design: only the **final** review/promote
should be human-gated; everything before that - claiming and implementing each
subsequent step - should proceed automatically. The human specified this explicitly:
"Automatic approve w0016 plan for me. Make it automatic except the final review and
promote step, which is supposed to happen."

## Fix

Change the `phase` assignment at `reciprocal-relay.ps1` line 1112 to be conditional on
`$continuation`:

- If `$continuation` is non-null (more auto-continuable work remains - i.e. this
  accepted candidate was an intermediate step of a multi-step epic with steps still
  left), do **not** enter `a-upgrade-pending`. Return the relay directly to `idle`
  (`nextRole = "A"`, `activeRole = $null`, no candidate) so the very next scheduled
  `Claim` can pick up the next step immediately, with zero human action required.
- If `$continuation` is null (no more auto-continuable work - either a non-epic
  single-commit item, or the genuinely final step of an epic), keep the existing
  behavior exactly as it is today: `phase = "a-upgrade-pending"`, human must confirm via
  `CompleteAUpgrade`/Approve & Promote before Executor A's runtime is rebuilt.

This is a small, localized change - do not restructure the surrounding accept logic
(refs update, `Complete-AcceptedDirectionCandidate` call, `candidateCommit`/`stableCommit`
clearing) beyond making the final `phase` value and whatever cleanup only makes sense
for the `a-upgrade-pending` case (e.g. `startedAt`) conditional on the same branch.

Separately, decide whether the existing `requiresHumanGate: true` /
`maxExtraLifecycleActions: 0` fields on the `autonomousContinuation` payload
(line 1124-1131) still make sense once intermediate steps no longer block on a human
gate - they were set that way specifically because the old unconditional
`a-upgrade-pending` would have refused a same-invocation continuation anyway. Whether to
also raise `maxExtraLifecycleActions` to allow same-invocation step-chaining (the older
pre-D151 pattern) is a secondary, your-judgment optimization, not the primary ask here -
the primary ask is simply "don't force a human gate between intermediate steps." If you
leave `maxExtraLifecycleActions: 0`, each step still proceeds automatically, just one
step per scheduled tick rather than chained within one invocation - that fully satisfies
what was asked.

## Constraints

- Do not weaken the mechanical `PassiveTest` gate itself (typecheck/test/build/diff-
  check, and the D153 packaging step) - it must still run and pass for **every**
  commit, intermediate or final, exactly as it does today. Only the placement of the
  *human* gate changes, never whether a commit gets independently, mechanically
  verified before trust advances.
- Do not weaken or make automatic the final `CompleteAUpgrade` confirmation itself -
  it must still require `-Force` and a human-readable summary, and must still be the
  point where a human reviews real functional behavior (D152's principle) before
  Executor A's own runtime is rebuilt from self-authored code.
- Do not change behavior for non-epic, single-commit wishlist items - they have no
  `autonomousContinuation` today and will correctly continue going straight to
  `a-upgrade-pending` after acceptance, same as now.
- Do not change anything about how `Complete-AcceptedDirectionCandidate` decides
  whether more steps remain - only react to what it already returns.

## Acceptance

Explain in `handoffs/D155_done.txt` exactly how the conditional was implemented and
what happens to the `autonomousContinuation` payload fields. Add a regression proving:
(a) accepting a non-final step of a multi-step epic returns the relay to `idle`, not
`a-upgrade-pending`, and a subsequent `Claim` for that same epic's next step succeeds
immediately with no `CompleteAUpgrade` in between; (b) accepting the genuinely final
step of a multi-step epic (or a non-epic item) still goes to `a-upgrade-pending` exactly
as today. Live proof: W0016 (Telegram remote control Round D, 3 steps, plan already
approved as of this handoff) is the real epic to exercise this against - show step 1/3
accepted by `PassiveTest` with the relay landing in `idle` (not `a-upgrade-pending`),
and Executor A claiming step 2/3 on its own next tick with no human action taken in
between. Do not force all 3 steps through in one sitting if that isn't how the real
schedule naturally unfolds - partial live proof (step 1 accepted -> idle -> step 2
claimed automatically) is sufficient to prove the fix; the final step 3 acceptance
correctly reaching `a-upgrade-pending` for real human review can be shown whenever it
naturally occurs. tsc + `npm test` green. Commit `D155-<n>:`. Create
`handoffs/D155_done.txt`.
