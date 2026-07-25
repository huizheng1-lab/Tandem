# Handoff D122 (executor black-window root cause: BOM-poisoned state files; plus true one-click background kickstart)

Two parts. Part A is the urgent bug that blocked today's kickstart attempt (both executor
windows opened black - no sidebar, no composer). Part B is the user's redesign request
that followed: "The kick start button is useless. It should trigger all that. The tandem
processes should run in background, so the prompts, the input should not be shown in
foreground."

## Part A: BOM-poisoned JSON state files hang the packaged app at startup

Root-caused personally via live CDP bisection against the real packaged build (isolated
TANDEM_HOME copies, one variable at a time). Full evidence chain:

- Fresh scratch TANDEM_HOME -> renders fine. Executor runtime binary itself -> fine.
  Launcher env vars (TANDEM_INSTANCE_ID, TANDEM_PROTECTED_ROOTS) -> fine. `.env` -> fine.
- A TANDEM_HOME containing the executor's real `config.json` -> **renderer permanently
  blocked** (CDP `Runtime.evaluate` never returns; window stays black). Reproduces with
  leader=codex/cli AND with leader swapped to minimax - the field values are irrelevant.
- Encoding is the differentiator: `state\executor-a\config.json` begins `EF BB BF` (UTF-8
  BOM - written by PowerShell `Set-Content -Encoding utf8`, which BOMs on Windows
  PowerShell 5.1). The user's own working `~/.tandem/config.json` (written by Tandem
  itself) has NO BOM and that app works fine. Node's `JSON.parse` throws on a leading BOM.
- Secondary confirmed casualty: `desktop-state.json` is also BOM'd and is silently
  IGNORED (diag instance with only a BOM'd desktop-state.json booted into the default
  `C:\Users\huizh\TandemProjects` instead of the configured copy-b worktree). So executors
  ALSO weren't getting their preselected peer worktree - a second real bug with the same
  cause, previously masked.

### Required fixes (all of them, not just one):

1. **Tolerate BOMs everywhere JSON state is read.** One shared read-JSON helper that
   strips a leading `﻿` before parse, used by config load (`src/config/load.ts`),
   desktop state (`readDesktopAppState`), session index reads, and any other
   `JSON.parse(await readFile(...))` state path. A config file a user edited in Notepad
   (which can also introduce BOMs) must never black-screen the app.
2. **Root-cause and fix the HANG mechanism itself.** A bad config should produce a
   VISIBLE, actionable error (dialog/error screen naming the file and parse error), never
   a silently blocked renderer. Find why the failure hangs rather than surfaces: likely
   the `TandemService` constructor throwing (`this.config = loadConfig(...)` at
   app/main/tandem-service.ts:139) before IPC handlers register, leaving the renderer's
   startup request waiting forever - confirm the exact mechanism and fix it so ANY
   main-process startup throw still yields a visible error state. This is the deeper bug;
   the BOM was just today's trigger.
3. **Stop generating BOMs.** Audit the reciprocal scripts that write JSON state via
   PowerShell (`setup-reciprocal-tandem.ps1`, `dashboard/update-model-config.ps1`, any
   `Set-Content`/`Out-File` on .json) and make them write BOM-less UTF-8
   (`[IO.File]::WriteAllText` with `UTF8Encoding($false)` or equivalent). Re-write the
   existing poisoned files under `Tandem Reciprocal\state\executor-a|b` (config.json,
   desktop-state.json) BOM-less so the executors actually start clean.
4. Regression tests: config load and desktop-state read with a BOM'd fixture must parse
   correctly; a corrupt (truly invalid) config must produce the visible-error path, not a
   hang (testable at the service/load layer without full Electron).

## Part B: one-click background kickstart (no manual prompts, no foreground windows)

D117 added a kickstart button that only displays copy-paste text, because no safe
automation surface existed. The user has now explicitly rejected that: the button must do
everything, and executor Tandems should run in the background without showing
prompts/input in the foreground. That means building a real automation surface in Tandem
itself:

1. **Local automation endpoint in the desktop app**: when launched with an explicit
   opt-in flag (e.g. `--automation-port=<port>` or an env var set only by the reciprocal
   launcher), the main process exposes a loopback-only, token-authenticated control
   surface (HTTP on 127.0.0.1 or a named pipe - pick what fits the existing IPC layer
   best) with minimal verbs: start/resume a session for a given projectDir, send a user
   prompt, query run state. Token generated per-launch and written to a file only the
   relay root can read (mirror the dashboard's existing in-memory-token pattern).
   Absolutely no automation surface without the explicit opt-in flag - normal user
   launches must be completely unaffected.
2. **Background launch mode**: reciprocal executors start hidden/minimized (Electron
   `show: false` driven by the same opt-in flag, or `--hidden` argv). They should not
   steal focus or display composer input in the foreground. (A tray icon or the dashboard
   itself is the visibility surface - the dashboard already shows relay state.)
3. **Rewire the dashboard Kickstart button** to be genuinely one-click: ensure executors
   are running (start them hidden via the existing start script if not), wait for their
   automation endpoints, then inject the first-turn prompt into executor A
   programmatically (session on its peer worktree, the exact TANDEM.md kickstart prompt).
   Update `start-reciprocal-tandem.ps1` to pass the automation/hidden flags. Kickstart
   must report per-step progress/failure honestly in the UI (start -> endpoint-ready ->
   prompt-accepted).
4. Update PROTOCOL.md/README.md: executors run headless-in-background; kickstart is
   dashboard-driven; the manual copy-paste flow remains documented as fallback.
5. Scope guard: the automation surface is for the reciprocal setup's own lifecycle - do
   not expose arbitrary command execution; verbs stay limited to session-start/prompt/
   status.

## Acceptance

Part A: regression tests green; BOM'd-fixture config loads; packaged app started with a
deliberately BOM'd config shows the app (or a clear error for truly-invalid JSON), never a
black window - verify against the real packaged build via CDP or visible launch, and state
what you observed. Both real executor state files rewritten BOM-less; both executors
launch to a full UI showing their correct peer worktrees (copy-b for A, copy-a for B) -
this specific check failed silently in D118's process-level verification, so verify it at
the UI level this time (CDP body text or screenshot).

Part B: single Kickstart click from the dashboard, with executors NOT previously running,
results in: both executors running hidden (no visible windows/focus steal), relay phase
transitioning to `working` with activeRole=A, and the first candidate turn proceeding -
paste the relay state JSON and the audit entries as evidence. Document the automation
surface (flag, token handling, verbs) in the marker. tsc + `npm test` green. This is a
larger round - split commits `D122-<n>:` per logical piece; if Part B is too large to land
well in one round, land Part A completely first and say so honestly in the marker rather
than rushing both. Create `handoffs/D122_done.txt`.
