# Handoff D141 (dashboard watchdog keeps dying silently - register it as a Windows scheduled task)

Third occurrence of the same failure: the D128 dashboard watchdog and its server both
die together with NO exit line logged in `control\dashboard-server.log` for either
process (confirmed each time by reading the log directly - it just stops mid-stream,
no "process.exit", no "watchdog stopped"). Manually relaunching via
`start-dashboard.ps1` fixes it each time but it keeps recurring across sessions.

## Likely cause (confirm, don't just assume)

The watchdog and server are plain background PowerShell/node processes with no
protection from a broader process-tree kill. Most likely trigger: something (Windows
session/desktop-session teardown between work sessions, an over-broad process cleanup
sweep, or similar) kills a whole process group/job object that the watchdog+server
happen to be part of, since BOTH die together every time with no independent exit
paths logged - a coordinated kill, not two separate crashes. Confirm by checking how
`start-dashboard.ps1` launches the watchdog (`Start-Process` job-object/console
inheritance behavior) before assuming this exact mechanism, but treat "something
outside the process's own control can kill it without notice" as the real constraint
to design around regardless of the exact trigger.

## Fix: register as a Windows scheduled task

Replace (or supplement) the current `Start-Process`-based watchdog launch with a
Windows Scheduled Task (same pattern already used for `TandemHandoffTriggerWatch` in
this project - reference it for the registration style) that:
1. Runs the watchdog script (or a thin wrapper that does what `start-dashboard.ps1`
   currently does) on a trigger that fires at logon AND on a recurring short interval
   (e.g. every 5 minutes) with "if the task is already running, do nothing" semantics -
   so even if the scheduled task's own process gets killed, the next interval tick
   revives it, independent of whatever killed the last one.
2. Scheduled tasks run somewhat outside normal interactive-session process-tree
   sweeps (separate service-managed process), which should make it resilient to
   whatever is currently killing the plain background process pair.
3. Keep the existing in-process watchdog logic (listener-down detection, 2s backoff,
   intentional-quit signal handling) - this is about the OUTER supervision layer
   surviving, not replacing the inner one.
4. `start-dashboard.ps1` should register the scheduled task if it doesn't exist yet
   (idempotent), so a human running it manually still "just works" and gets durable
   supervision as a side effect, not a separate manual setup step.

## Acceptance

Live evidence: register the task, kill the watchdog+server process pair manually
(simulating the observed failure), confirm the scheduled task's next trigger (or the
logon trigger, whichever is practical to demonstrate) brings the dashboard back
without a human running `start-dashboard.ps1` again. Confirm intentional `/api/quit`
still results in a clean stop that does NOT get immediately resurrected by the
scheduled task (the intentional-stop signal file from D128 should still work - verify
the scheduled-task wrapper respects it). tsc + `npm test` green as sanity (this is
mostly PowerShell/dashboard, minimal src impact expected). Commit `D141-<n>:` for any
admin-repo script changes; dashboard-side changes described in the marker. Create
`handoffs/D141_done.txt`.
