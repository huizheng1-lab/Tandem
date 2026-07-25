# Handoff D128 (dashboard backend crashed on a browser refresh; no crash log existed - harden it)

Real incident: with the dashboard open on 127.0.0.1:4782 showing the wishlist (W0010 epic
awaiting peer validation), the page displayed a yellow "Failed to fetch" banner; when the
user refreshed the browser, the backend node process DIED (verified: nothing listening on
4782, process gone). I restarted it via the launcher. Diagnosis is blocked by a
self-inflicted gap: `start-dashboard.ps1` starts node `-WindowStyle Hidden` with NO
stdout/stderr redirection, so whatever the fatal error was is simply lost.

## D128-1: capture crashes

`start-dashboard.ps1`: redirect the server's stdout+stderr to a rotating/appending log
(e.g. `C:\Users\huizh\Apps\Tandem Reciprocal\control\dashboard-server.log`, timestamped
lines; simple append is fine, add a size-based truncate/rotate so it can't grow
unbounded). Also log server start/stop with pid and port from within server.mjs itself.

## D128-2: make the server crash-proof at the process level

server.mjs: add `process.on("uncaughtException")` and `process.on("unhandledRejection")`
handlers that log the full error (to the same log) and KEEP THE PROCESS ALIVE unless the
error is provably unrecoverable. Likely root-cause area: an async rejection outside a
request's try/catch (Node's default kills the process on unhandled rejection) - e.g. one
of the fire-and-forget `git`/`powershell` subprocess calls or an fs read racing a state
file write. Audit the request handlers and any timers for unawaited promises. Reproduce if
possible: hammer /api/status + /api/revision concurrently (a browser refresh fires several
requests at once, and the user's refresh is what killed it) while relay state files are
being written; find the actual failing path and fix IT specifically, not just the global
net. The prior "Failed to fetch" banner before the crash suggests one route was already
failing - the log from D128-1 plus the reproduction should identify it.

## D128-3: restart resilience

Since the dashboard is now part of the operational loop (kickstart/pause/approve all live
there), give it a supervised restart: simplest acceptable = the launcher registers a
lightweight watchdog (scheduled task or a loop in the hidden launcher process) that
re-starts the server if 4782 stops listening, with a backoff and a log line. Do not build
a service-manager; keep it proportional.

## D128-4: cleanup discipline for test instances

A leftover acceptance-test dashboard instance from D127 is still running on port 4798
(node server.mjs --port=4798). Stop it as part of this round, and add a line to the
protocol/round discipline: acceptance-test server instances must be stopped before a
round's marker is written (same spirit as the scratch-file cleanup rule).

## Acceptance

Evidence in marker: the crash log file existing and receiving lines (show a snippet);
uncaught-exception/rejection handlers demonstrated (e.g. a deliberately injected test
rejection gets logged without killing the server); the concurrent-refresh reproduction
attempt and what it found (root cause fixed if reproducible - say plainly if it was not
reproducible and what you changed anyway); watchdog restart demonstrated (kill the server
process, show it comes back listening within the backoff window, audit/log line present);
port 4798 instance gone. tsc + `npm test` in the admin repo as sanity. Dashboard/launcher
changes described in the marker; any repo-side changes committed `D128-<n>:`. Create
`handoffs/D128_done.txt`.
