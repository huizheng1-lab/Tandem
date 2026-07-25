# Handoff D117 (dashboard: button-driven kickstart and pause/resume for the reciprocal loop)

Follow-up to D116 (in progress - build on its result, inspect the dashboard state after it
lands). User wants the full reciprocal lifecycle drivable from the control panel at
`C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\` (127.0.0.1:4782) without touching a
terminal or typing into an executor window.

## Current gaps (verified by reading server.mjs)

- `/api/executor/start|stop` exist (start/stop the pinned apps, safe by design), but there
  is no way to send the one-time kickstart message into executor A - today the human either
  types it into A's window or waits up to an hour for the :07 schedule to fire.
- There is no relay-level pause/resume in the UI. `scripts/reciprocal-relay.ps1 -Action
  Pause` exists but exiting `paused` currently requires `Reset -Force`, which is
  deliberately heavy (full human recovery, cleans state) - unsuitable as the counterpart of
  a casual pause.

## D117-1: relay Resume action

Add a `Resume` action to `scripts/reciprocal-relay.ps1`: valid ONLY from `phase: paused`,
restores the phase the relay was in when paused (persist the prior phase into the state
JSON at Pause time, e.g. `pausedFromPhase`), preserves owner/turn token/refs untouched, and
requires a `-Summary`. It must NOT be a synonym for Reset - no cleaning, no token
regeneration, no ref movement. Update PROTOCOL.md's description of `Pause` accordingly
(pause is now reversible via Resume; Reset remains the heavy recovery path). Guard: `Resume`
from any phase other than `paused` fails with a clear error.

## D117-2: dashboard pause/resume buttons

Two token-gated mutation endpoints + UI buttons: `/api/relay/pause` (requires a reason
string, passed as the Pause summary) and `/api/relay/resume` (same). Wire to the relay
script. Show the current phase prominently, render the Resume button only when
`phase: paused`, and record both actions in the existing CONTROL_PANEL_AUDIT.jsonl. Pausing
from the dashboard must not stop the executor apps (that's what the existing Stop buttons
are for) - it only halts turn-claiming; scheduled wakeups then exit cheaply at WAIT, per
the protocol's existing design.

## D117-3: dashboard kickstart button

A `/api/executor/kickstart` endpoint + button that gets the loop's first turn going without
typing into the executor window. Investigate the cleanest mechanism first and pick ONE:

(a) If the Tandem desktop app exposes any local automation surface (CLI flag, IPC, or the
    session JSONL/service layer) that can inject a user prompt into a running instance,
    use it.
(b) Otherwise, prefer NOT to synthesize UI input (no SendKeys hacks - fragile and can land
    keystrokes in the wrong window). Instead: reuse the persisted-schedule mechanism - a
    kickstart button that registers/triggers a one-shot immediate run of the same scheduled
    prompt for executor A (e.g. `Start-ScheduledTask` on the existing schedule entry if the
    schedules are Windows scheduled tasks, or whatever mechanism the persisted /schedule
    entries actually use - inspect first, don't assume).

If neither is achievable without fragile hacks, say so plainly in the marker and instead
have the button display copy-paste-ready kickstart text plus which executor window to paste
it into - honest fallback beats a flaky automation. Either way the button must be
token-gated and audited like the other mutations.

## Constraints

- Keep the dashboard's existing control boundary: mutations token-gated, localhost-only,
  audited, and no new capability that can rewrite branches/refs from the browser.
- Don't regress D116-6's drift telemetry (if it has landed).
- Relay-script changes need matching updates to PROTOCOL.md and the dashboard README's
  Control Boundary section.

## Acceptance

tsc + `npm test` green in the admin repo (sanity; dashboard code is outside the test
suite). Demonstrate in the marker with real evidence: (1) Pause from the dashboard while
executors are idle -> state JSON shows `phase: paused` with the reason; scheduled/manual
claim attempts WAIT; (2) Resume -> phase restored to its pre-pause value, owner unchanged;
(3) kickstart button produces a real claimed turn in executor A (or the documented honest
fallback if D117-3's investigation concludes automation is infeasible); (4) all three
actions appear in CONTROL_PANEL_AUDIT.jsonl. Quote the relevant new PROTOCOL.md/README
sections. Commit `D117-<n>:` per logical piece, push, create `handoffs/D117_done.txt`.
