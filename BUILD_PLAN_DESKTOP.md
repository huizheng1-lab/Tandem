# Tandem Desktop — Build Plan (Round 9 scope)

Author: reviewing leader (Claude). Implementer: GPT-5. Goal: give Tandem a windowed desktop app
in the style of the Claude Code desktop app — a chat GUI, not a terminal — while keeping the
existing CLI/TUI fully working. Same working rules as always: `npx tsc --noEmit` clean and
`npm test` green after every milestone, one commit per milestone (`D<n>: <summary>`), honest
completion-report update at the end, never run `tests/live-smoke.test.ts` yourself.

## 1. Approach (fixed — do not substitute)

- **Electron** (main process = Node, so it imports the existing core modules directly) +
  **React 18** renderer + **Vite** via **electron-vite**, packaged with **electron-builder**
  (Windows NSIS installer + portable exe). TypeScript everywhere, strict.
- **Reuse, do not fork, the core**: `src/orchestrator/*`, `src/agents/*`, `src/tools/*`,
  `src/providers/*`, `src/session/*`, `src/config/*` are consumed as-is by the Electron main
  process. If the desktop app needs something the core lacks, extend the core module (keeping
  the TUI working) — never duplicate logic into the app layer.
- Renderer security: `contextIsolation: true`, `nodeIntegration: false`, single typed preload
  bridge. All filesystem/LLM work happens in the main process.
- The repo stays one npm package. New code lives under `app/` (`app/main/`, `app/preload/`,
  `app/renderer/`). New scripts: `dev:app` (electron-vite dev), `dist:app` (build + package).

## 2. IPC contract (define first, in `app/shared/ipc.ts`, imported by all three layers)

Typed request/response + event channels (use `ipcRenderer.invoke` / `webContents.send`):

- `session:start { projectDir }` → creates SessionStore, loads config+env for that dir
- `pipeline:run { prompt }` → streams events until DONE; events channel emits:
  - `evt:machine` (MachineEvent — transition/artifact/checkpoint/error, verbatim from core)
  - `evt:text { role: "leader"|"worker", delta }`
  - `evt:cost` (CostLedger totals after each agent turn)
  - `evt:done { summary, takeover }`
- `pipeline:abort` → AbortController.abort()
- `permission:request` (main→renderer) / `permission:respond { approved }` — promise bridge
  implementing the core `PermissionBridge`
- `plan:confirm` (main→renderer with BuildPlan) / `plan:respond { approved }`
- `config:get` / `config:set { patch }` (persists via existing `saveProjectConfig`)
- `models:list` → registry with key-availability flags
- `sessions:list` / `session:resume { id }` → replays stored events to rebuild the transcript,
  and restores the last checkpoint for continuation (reuse R3-1 `initialState`)
- `goals:*`, `schedules:*` → thin wrappers over existing `src/session/goals.ts` /
  `src/commands/schedule.ts`; cron jobs live in the main process while the app runs
- `dialog:pickFolder` → native folder picker

## 3. UI spec (single window, dark theme default, left sidebar + main chat pane)

**Sidebar** (collapsible): project folder picker (current dir shown, click to change);
session list (click to resume); goals panel (add/complete); schedules panel (list/add/remove).

**Main pane, top status bar**: leader model and worker model as dropdowns (populated from
`models:list`, disabled entries when the API key is missing, persists via `config:set`);
phase chip (IDLE/PLANNING/BUILDING/REVIEWING/TAKEOVER/DONE); round `i/N`; running session cost
(hover: per-role breakdown).

**Transcript**: chat bubbles with role badges — user, LEADER (distinct accent), WORKER (second
accent), SYSTEM (dim, small). Streaming text renders live. Tool activity from SYSTEM events shows
as one-line dim entries. **Artifact cards** for BuildPlan / CompletionReport / ReviewVerdict:
collapsed header (title, task/feedback counts, verdict + scores) that expands on click to the
full structured content. Auto-scroll with a "jump to bottom" affordance.

**Composer** (bottom): multi-line input, Enter sends / Shift+Enter newline; while a pipeline is
running the send button becomes **Stop** (wired to `pipeline:abort`). Slash commands are NOT
re-implemented as text: their functions exist as UI (model dropdowns, goals panel, etc.). Only
plain prompts go to `pipeline:run`.

**Modal dialogs**: plan confirmation (renders the plan card, Approve / Reject with optional
feedback text that is fed back to the planner on reject); permission requests (action, target,
Allow / Deny, plus "always allow for this session" which flips an in-memory auto-approve for
that action type); settings (permissionMode, maxReviewRounds, custom models editor with
Add-OpenAI-compatible-model form: id, baseURL, env key name, model name).

## 4. Milestones

**D0 — Scaffold.** electron-vite + React + TS strict wired into the repo; empty window opens with
`dev:app`; preload bridge exposes a `ping`; existing CLI build/tests unaffected. Acceptance:
`npm run dev:app` opens the window; `npm test` still green.

**D1 — Core bridge.** Main-process TandemService wrapping createLiveAgents + runOrchestration +
SessionStore + CostLedger for a chosen projectDir; IPC contract implemented; renderer shows a
plain-text transcript of a real run (no styling yet). Acceptance: with real keys, a prompt runs
plan→build→review in the window with streaming text and permission prompts appearing as bare
confirm() dialogs.

**D2 — Full chat UI.** Transcript bubbles, artifact cards, status bar with model dropdowns,
composer with Stop, plan-confirm and permission modals replacing the bare dialogs. Acceptance:
the README demo prompt runs end-to-end entirely in the GUI, including plan approval and at least
one permission prompt, with live cost updating.

**D3 — Sidebar.** Folder picker (pipeline uses the picked dir as tool cwd), sessions
list/resume (transcript replay + checkpoint continuation), goals and schedules panels.
Acceptance: switch project folder and run; resume a previous session and see its transcript;
add a goal and see it reflected in the next plan's context.

**D4 — Packaging + shortcut.** electron-builder config (appId `dev.tandem.app`, product name
Tandem, NSIS + portable), app icon (generate a simple two-riders/tandem glyph .ico), `dist:app`
script. Update the user's desktop shortcut story in README: installer creates its own shortcut.
Acceptance: `npm run dist:app` produces a runnable installer on Windows; installed app launches
and D2's acceptance passes in the packaged build.

**D5 — Hardening + docs.** Renderer error boundaries; main-process crash guard that flushes the
session store; unit tests for the IPC contract layer (mock ipcMain/ipcRenderer) and TandemService
(mock agents — reuse the fake-agents pattern from `tests/orchestrator.test.ts`); README section
"Desktop app". Acceptance: tests green including new ones; kill the app mid-BUILDING, relaunch,
resume the session from the sidebar.

## 5. What NOT to do

- Do not modify orchestrator semantics, tool permissioning, or provider code except by adding
  clearly-named extension points.
- Do not break `npx tandem` (CLI/TUI must keep passing its tests and running).
- No auto-update, telemetry, multi-window, or tray features — out of scope.
- Keep new dependencies to: electron, electron-vite, electron-builder, react, react-dom, and
  (optionally) one small state library (zustand) — nothing else without a stated reason.

## 6. Reviewer's acceptance (what I will check)

D-milestone commits present; tsc + full test suite green; core untouched-or-cleanly-extended
(I will diff `src/`); packaged build works; live GUI run passes the same bar as the CLI smoke
test (plan card → worker rounds → verdict → non-zero per-role cost), which I will drive manually.
