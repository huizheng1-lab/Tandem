# Handoff to GPT-5 — Round D12 (process hygiene + launch robustness)

Context: D11 APPROVED. The packaged app is verified correct (reviewer inspected the loaded page
via the DevTools protocol). Findings below come from investigating a stale-window incident and
from artifacts a worker left behind in a user project folder.

## D12-1: Bash tool must not leak child processes
Observed: during a "build a webpage" run, the worker `npm install`ed `http-server` into the
user's project and (in other runs) spawned servers during verification that outlive the round.
Fix in `src/tools/shell.ts`:
- Run commands with execa options that kill the whole child tree on completion/timeout on
  Windows (`cleanup: true` alone does not kill grandchildren; use `windowsHide: true` and on
  timeout/settle kill the process tree — `taskkill /T /F /PID` via execa is acceptable).
- After the command settles, ensure no orphaned children of that command remain (best-effort
  tree kill; log a SYSTEM-visible note when something had to be killed).
- Add to the worker system prompt (`src/agents/worker.ts`): do not start long-running servers or
  watchers during verification; verify with finite commands (tests, node scripts that exit).
Unit test: a command that spawns a child which would outlive it (e.g. `node -e "setInterval..."`
detached) — after bashTool resolves, the child is gone (Windows-compatible test; skip on
non-Windows if needed).

## D12-2: Desktop app single-instance lock
Double-launching Tandem currently opens a second instance, which caused user confusion with
stale windows. In `app/main/index.ts`: `app.requestSingleInstanceLock()`; if not obtained, quit;
on `second-instance`, focus/restore the existing window.

## D12-3: Dev-server port strictness
The dev collision that started the confusion: a second `npm run dev:app` silently shifted vite
ports. In `electron.vite.config.ts`, set the renderer dev server to `strictPort: true` so a
second dev instance fails fast with a clear error instead of half-launching.

## Acceptance
tsc + `npm test` green; commits `D12-<n>:`. Reviewer will: run a live prompt whose verification
spawns a child process and confirm nothing is left running afterward; launch the packaged app
twice and confirm the second click focuses the first window.
