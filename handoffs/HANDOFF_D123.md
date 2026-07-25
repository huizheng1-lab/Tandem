# Handoff D123 (Approve-flow orchestrates executor stop -> promote -> restart automatically)

Builds on D120 (human update gate) and D122 (Part B: automation surface, hidden executor
launch - in progress; implement this round AFTER D122 lands, on top of its result). User's
point: executors must be shut down whenever Tandem is updated/rebuilt, and today that
stop/promote/restart choreography is manual clicks in the right order.

## Required behavior

When the human clicks **Approve** on a pending update (D120 flow), the dashboard should
orchestrate the full cycle safely:

1. **Wait for a safe boundary - never kill a working turn.** If relay phase is `working`/
   `validating`/`rollback-verification`, do not stop apps mid-turn. Pause the relay
   (D117's reversible Pause) so no NEW turn gets claimed, then either wait for the active
   turn to finish (poll relay state, with a visible "waiting for active turn to finish"
   status in the UI and a human-cancellable wait) or let the human explicitly choose
   "stop anyway - turn will resume from checkpoint after restart" (the protocol
   guarantees checkpoint resumability, so this is safe but should be a deliberate choice,
   not the default).
2. Stop both executors (existing stop script / D122 mechanism).
3. Run the existing promotion (`promote-reciprocal-runtime.ps1` via the D120 Approve
   path - unchanged).
4. Restart both executors hidden (D122's background launch).
5. Resume the relay if this flow paused it (D117 Resume semantics - only if paused by
   this flow, mirroring reciprocal-main-update.mjs's pausedByFlow pattern).
6. Every step audited; failure at any step leaves a coherent, reported state that tells
   the human exactly what completed and what remains (same discipline as
   reciprocal-main-update.mjs's `remaining` list).

Also apply the same boundary-safety to the standalone executor Stop buttons: if a stop is
requested while that executor is mid-turn, warn (checkpoint-resume will handle it) instead
of stopping silently - a one-line confirm is enough, don't over-build it.

## Acceptance

Live demonstration in the marker: with executors running hidden and relay idle, one
Approve click results in stop -> promote (BUILD_INFO/dir listing proof, per D118
discipline) -> hidden restart -> relay resumed, with audit entries for each step. Plus one
demonstration of the boundary guard: Approve clicked while a turn is active (a scripted/
synthetic `working` state is fine) shows the wait-or-explicit-override behavior instead of
killing the turn. tsc + `npm test` green as sanity. Dashboard changes described in the
marker; any admin-repo script changes committed `D123-<n>:`. Create
`handoffs/D123_done.txt`.
