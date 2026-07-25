# Handoff D146 (bad candidate must be rejected: leader used a wrong scratch ControlPath, re-planned an already-DONE epic)

Relay is PAUSED with candidate `5f97d0b` pending - a genuine mistake, not a protocol
bug in the D143/D144 machinery itself. Do not let this candidate get accepted.

## What happened (confirmed directly)

Executor A's turn (session `3ce04983...`, started via kickstart ~19:17 UTC) claimed
work and its own completion summary states it used:
`reciprocal-direction.ps1 -Action Start -Id W0013 -Role A -ControlPath
.tandem/direction.txt`

That `.tandem/direction.txt` is NOT the real shared control board - it's a stray file
sitting alongside other scratch/debug output (`search-test-output.txt`,
`typecheck-output.txt`, etc.) in `worktrees/copy-b/.tandem/`, almost certainly created
earlier in this same long-running session as an ad-hoc redirect target during W0014
Step 2's debugging, then mistakenly reused as if it were the canonical control path.
The REAL board (`.tandem/shared-control/SHARED_DIRECTION.md`, the correct junction)
correctly shows W0013 as `[x] DONE steps=2/2` and W0014 as `IN_PROGRESS step=1/3`.

The turn's own `-Action Start` call WROTE `IN_PROGRESS phase=PLAN` for W0013 into that
wrong file (confirmed: the file's W0013 line shows `started=2026-07-18T19:23:14Z`,
matching this exact turn) - so this was an active mistake in this invocation, not a
read of some pre-existing stale cache. The leader then proceeded to draft and commit
`process/reciprocal/epics/W0013-plan.md` describing a "fresh" 3-step plan for the
run-health tracker - features that were ALREADY IMPLEMENTED, reviewed, and merged as
the real W0013 epic weeks... same day earlier. Accepting this candidate would
overwrite the real, completed epic's plan file with duplicate/incorrect content and
could confuse future readers about W0013's actual history.

## D146-1: reject the bad candidate

Reject/roll back candidate `5f97d0b` through the normal relay mechanism (Rollback +
CompleteRollback, or whatever the correct rejection path is post-D143's redesign -
verify against the current protocol). Confirm the real `W0013-plan.md` content
(matching the actually-completed epic) is restored/untouched after rollback. Do NOT
manually hand-edit the file - use the relay's own rollback path so the audit trail is
correct.

## D146-2: investigate why the leader used the wrong ControlPath

Read the full session log for this turn (session `3ce04983-1ee2-4f09-b8b7-
f706cb6aa630` under `state/executor-a/sessions/`) around the `-Action Start` tool call
and the turns immediately before it. Determine: did the leader genuinely reuse a
filename it had itself created earlier in the same session for scratch output (a
context-confusion/hallucination class of error), or is there a prompt-level reason
`.tandem/direction.txt` looked like a plausible control path (e.g. an example or
placeholder in TANDEM_EXECUTOR_A.md/PROTOCOL.md that resembles this path)? State the
actual finding, don't guess.

## D146-3: consider a structural guard, scoped to what's actually needed

Two independent angles worth considering, but don't over-build either:
- Should `reciprocal-direction.ps1 -Action Start` (and Show) validate that a supplied
  `-ControlPath` actually resolves to the real shared-control location (or refuse/warn
  on an unrecognized explicit path) rather than silently operating on whatever path is
  given? This would have caught the mistake immediately rather than letting a whole
  turn proceed on a false premise.
- Should D143's leader-only review call have enough context to catch "this plan
  duplicates an already-DONE item" - e.g. by including the current board state (or at
  least the target item's real status) in what gets passed to `AgentFns.review()`,
  not just plan/report/diff? Evaluate whether this is a reasonable, bounded addition
  or whether it's better handled entirely by D146-3's first guard (preventing the bad
  candidate from ever being created) rather than trying to catch it later in review.
Pick whichever guard(s) meaningfully closes this gap without adding unnecessary
complexity - explain the choice.

## Constraints

- Do not delete or otherwise "fix" the stray `.tandem/direction.txt`/debug files by
  hand as part of this round unless it's directly relevant to the guard you build -
  `.tandem/` is untracked scratch space and cleanup there isn't the priority; the real
  priority is preventing this class of mistake and correctly rejecting the bad
  candidate.
- Leave the relay paused when done - do not resume it yourself.

## Acceptance

Confirm candidate `5f97d0b` was rejected (not accepted) with real evidence (rollback
commit/ref state). Confirm the real W0013-plan.md content is intact and unmodified
after rejection. State the D146-2 finding plainly. Implement and test whichever
D146-3 guard(s) you chose, with regression coverage. tsc + `npm test` green. Commit
`D146-<n>:`. Create `handoffs/D146_done.txt`.
