# Handoff D147 (automation server's "running" flag gets stuck true after a completed run, silently blocking future schedule ticks and kickstart)

Live incident: executor A's automation `/status` endpoint reported `running: true` with
a `completedAt` timestamp already set (`2026-07-18T19:17:37Z` accepted,
`19:29:48Z` completed) - a genuinely contradictory state; if a run completed, `running`
must be false. This silently blocked BOTH the next scheduled tick (confirmed: no
session file was touched anywhere near the 20:07 UTC scheduled fire, meaning Tandem's
own "skip a scheduled prompt while another run in that same app is active" guard
incorrectly treated the stale flag as a live run) and the dashboard's Kickstart button
(which surfaced "Kickstart stopped: A Tandem run is already active" - the guard
working as designed, just on wrong input). Restarting the executor process cleared the
flag as a workaround; the underlying bug needs a real fix so this can't silently eat
up to an hour of dead time again without any visible error until a human happens to
try Kickstart.

## Investigation

Find the automation server code (`app/main/automation-server.ts`, per D122) that
tracks the "is a run currently active" state backing the `/status` endpoint's
`running` field and the scheduler's own active-run check. Determine why `running`
didn't flip back to false when the run genuinely completed at 19:29:48 - likely
candidates: an exception/early-return path after the run finishes that skips the
"mark not running" cleanup step, a promise that never resolves/rejects on one code
path, or a race between the run's own completion handler and something else touching
the same state. Reproduce if feasible (a run that ends via a specific path - e.g. the
D146 incident's Start-with-wrong-ControlPath detour, or any run producing a
takeover/error outcome - are reasonable first guesses given that's exactly what
happened live) rather than guessing.

## Fix

Ensure `running` is reset to false in a path that ALWAYS executes when a run ends,
regardless of how it ends (success, error, takeover, early exit) - a `finally`-style
guarantee, not conditional cleanup that can be skipped by an exceptional path. Add a
regression that deliberately exercises an unusual completion path (matching whatever
D147's investigation finds triggered this) and confirms `running` correctly becomes
false afterward, and confirms a subsequent kickstart/schedule-check would then
succeed.

## Constraints

- Do not touch the "skip a scheduled prompt while another run is active" guard itself
  - it's correct in principle; the bug is that its INPUT (the running flag) was wrong.
- Do not weaken the Kickstart button's active-run check - it should keep refusing when
  a run is GENUINELY active; it just needs correct information to check against.

## Acceptance

Root cause explained with evidence (not a guess). Regression proving the flag resets
correctly after the specific completion path that caused this. Live evidence: trigger
a run that completes via that same path in the real environment (or the closest safe
reproduction) and confirm `/status` correctly shows `running: false` afterward with no
manual restart needed. tsc + `npm test` green. Commit `D147-<n>:`. Create
`handoffs/D147_done.txt`.
