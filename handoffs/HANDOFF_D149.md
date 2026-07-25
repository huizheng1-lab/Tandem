# Handoff D149 (relay Claim returns RESUME with nothing to resume, spuriously tripping the resume circuit breaker right after a candidate is accepted)

Live incident: immediately after D148's fix landed and the pending rollback candidate
`3992fdf` was accepted (stable advanced, `phase` set to `working`, `activeRole` left as
`"A"`), executor A's next scheduled tick called `Claim` and got back `RESUME` - even
though there was no checkpoint file, no `candidateCommit`, and no `rollbackCommit` to
actually resume. Executor A correctly noticed the contradiction ("RESUME claim but
nothing recorded to resume, HEAD is just the plain accepted revert commit") and
reported the turn as blocked, asking for human inspection instead of guessing at a
recovery path. That non-completing outcome counted toward the D133 resume circuit
breaker; it recurred, and after 3 consecutive non-completing RESUME claims for turn 4
the relay auto-paused (`pausedFromPhase: "working"`) at 2026-07-18T21:12:27Z - the
breaker fired correctly, but on a bad signal, not a genuinely stuck turn.

## The bug (confirmed, don't re-derive)

`scripts/reciprocal-relay.ps1`'s `Claim` action, in the branch that runs when
`$state.activeRole` is already set and matches the calling `$Role`
(around line 926-937), unconditionally does this:

```powershell
if ($state.activeRole -eq $Role) {
    $count = Increment-ResumeCounter
    if ($count -ge $ResumePauseThreshold) {
        Pause-ResumeLoop $Role
    }
    Save-State
    Write-Result "RESUME"
}
```

It never checks whether there is actually anything to resume. Compare this to the
*fresh*-claim branch a few lines further down (line 947-974, reached only when
`activeRole` is NOT already set): that branch does a real merge, sets
`baseCommit`/`startedAt`, calls `Reset-ResumeCounter`, and returns `"CLAIMED"` (or
`"VALIDATE"` if `candidateCommit` is set). That is the correct outcome for "start a
normal fresh working turn" - but a role can never reach it once `activeRole` is
already set to that role, no matter how stale or empty that ownership actually is.

The reason `activeRole` was already `"A"` with nothing to resume: `Approve-Candidate`
(line 533-568) accepts a validated candidate, sets `phase = "working"`,
`baseCommit = $head`, and calls `Reset-ResumeCounter` - handing the accepting role a
brand-new working turn - but it does not clear `$state.activeRole`, and no checkpoint
file (`.tandem/reciprocal-checkpoint.md`) or `candidateCommit`/`rollbackCommit` exists
at that point. So the very next `Claim` from that same role sees
`activeRole -eq $Role` and unconditionally reports `RESUME`, with no recovery data
behind it.

Confirmed directly against the live incident: `git log` on `codex/reciprocal-b` at the
time showed HEAD `3992fdf` was a plain, legitimate `Revert` of the earlier bad
candidate `5f97d0b` (the D146 incident, now correctly accepted post-D148); no
`.tandem/reciprocal-checkpoint.md` existed in the worktree; `state.json` immediately
before the stuck Claim showed `candidateCommit: null`, `candidateKind: null`,
`rollbackCommit: null`. There was nothing in-flight to resume - the RESUME outcome was
simply wrong.

Executor A's own reasoning here was correct, not a mistake to train away - don't
change its behavior. Fix the signal it was given.

## Investigation

Audit every code path that can leave `$state.activeRole` set to a role while no
concrete resumable state exists (checkpoint file, `candidateCommit`, `rollbackCommit`)
- `Approve-Candidate` is the one confirmed live, but check `Reject-Candidate`'s
rollback-verification handoff and the `autonomousContinuation` flow (D144) for the
same class of gap. Also check whether `.tandem/reciprocal-checkpoint.md` is reliably
the right signal for "genuine in-progress turn to resume" (grep where it gets written
- it's only ever *removed* by `reciprocal-relay.ps1` itself, at Reset/Resume-into-idle
paths, so confirm which agent-side code is responsible for creating it during a real
mid-turn checkpoint).

## Fix

Make `Claim` distinguish a genuine resume (checkpoint file exists, or
`candidateCommit`/`rollbackCommit` is set) from a stale/empty `activeRole` left over
from a same-role handoff with nothing in flight. When `activeRole` matches the caller
but there is no genuine resumable state, treat it as a fresh claim instead of RESUME -
either by having the RESUME branch fall through to the existing fresh-claim logic
(line 947-974, reusing its `CLAIMED`/`VALIDATE` outcome logic rather than
reimplementing it), or by having `Approve-Candidate` (and any other same-role handoff
path the investigation finds) clear `$state.activeRole` when it hands off a fresh
working turn with nothing in flight, so the next `Claim` naturally takes the
already-correct unset-`activeRole` path. Pick whichever keeps the code simplest and
reuses the existing, already-tested fresh-claim path rather than adding a parallel one
- don't invent a third outcome type.

While fixing this, also clean up the unrelated stray artifact this incident left
behind: `.tandem-shared-direction.txt`, an untracked file in the `copy-b` worktree
containing a PowerShell parameter-validation error (a same-turn typo - the agent
passed `-Priority type` to `scripts/reciprocal-direction.ps1`, which only accepts
`P0`/`P1`/`P2`/`P3` - unrelated to this bug, just a leftover mess). Remove it as part
of restoring a clean worktree; no relay-script change is needed for that typo itself.

## Constraints

- Do not weaken or remove the D133 resume circuit breaker itself - it should still
  auto-pause after genuinely repeated non-completing resumes. This fix is about not
  feeding it a false signal, not about raising its threshold or disabling it.
- Do not change what counts as a genuine checkpoint/candidate/rollback - only change
  how `Claim` decides RESUME vs fresh-claim using those existing signals.
- Do not touch the D148 `TANDEM_HOME`/leader-review fix or the D143 validate/review
  flow - both are working correctly and are unrelated to this bug.

## Acceptance

Root cause explained with evidence already in this handoff (don't re-derive - reuse
the file/line references above). Add a regression exercising exactly this shape:
`Approve-Candidate` (or whichever handoff path is chosen) leaves `activeRole` set to a
role with no checkpoint file and no `candidateCommit`/`rollbackCommit`; assert the next
`Claim` from that same role returns `CLAIMED` (or `VALIDATE` if applicable), not
`RESUME`, and that `resumeCount` is not incremented by it. Live proof: the current
relay is paused at turn 4 (`pausedFromPhase: "working"`, `activeRole: "A"`,
`stableCommit: 3992fdf`, `candidateCommit: null`) - after the fix, safely recover it
(a human `Resume` action, or whatever the fix makes correct) and show a real
subsequent `Claim` for role A returning `CLAIMED` rather than `RESUME`, with executor A
proceeding to a normal working turn (e.g. picking up W0014 step 2/3) instead of
reporting blocked again. tsc + `npm test` green. Commit `D149-<n>:`. Create
`handoffs/D149_done.txt`.
