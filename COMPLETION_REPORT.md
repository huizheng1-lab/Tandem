# CompletionReport

## Status

complete

## Summary

Implemented Tandem from the supplied build plan, revised it per `REVIEW_FEEDBACK.md`, completed the Round 3 handoff tasks in `HANDOFF_GPT5.md`, Round 4 in `HANDOFF_GPT5_R4.md`, Round 5 in `HANDOFF_GPT5_R5.md`, Round 6 in `HANDOFF_GPT5_R6.md`, Round 7 in `HANDOFF_GPT5_R7.md`, Round 8 in `HANDOFF_GPT5_R8.md`, the desktop app plan in `BUILD_PLAN_DESKTOP.md`, desktop Round D6 in `HANDOFF_GPT5_D6.md`, desktop Round D7 in `HANDOFF_GPT5_D7.md`, desktop Round D8 in `HANDOFF_GPT5_D8.md`, desktop Round D9 in `HANDOFF_GPT5_D9.md`, desktop Round D10 in `HANDOFF_GPT5_D10.md`, desktop Round D11 in `HANDOFF_GPT5_D11.md`, desktop Round D12 in `HANDOFF_GPT5_D12.md`, desktop Round D13 in `HANDOFF_GPT5_D13.md`, desktop Round D14 in `HANDOFF_GPT5_D14.md`, desktop Round D15 in `HANDOFF_GPT5_D15.md`, desktop Round D16 in `HANDOFF_GPT5_D16.md`, desktop Round D17 in `HANDOFF_GPT5_D17.md`, desktop Round D18 in `HANDOFF_GPT5_D18.md`, desktop Round D19 in `HANDOFF_GPT5_D19.md`, desktop Round D21 in `HANDOFF_GPT5_D21.md`, desktop Round D22 in `HANDOFF_GPT5_D22.md`, desktop Round D23 in `HANDOFF_GPT5_D23.md`, desktop Round D24 in `HANDOFF_GPT5_D24.md`, desktop Round D25 in `HANDOFF_GPT5_D25.md`, desktop Round D26 in `HANDOFF_GPT5_D26.md`, desktop Round D27 in `HANDOFF_GPT5_D27.md`, desktop Round D28 in `HANDOFF_GPT5_D28.md`, desktop Round D29 in `HANDOFF_GPT5_D29.md`, desktop Round D30 in `HANDOFF_GPT5_D30.md`, desktop Round D31 in `HANDOFF_GPT5_D31.md`, desktop Round D32 in `HANDOFF_GPT5_D32.md`, desktop Round D33 in `HANDOFF_GPT5_D33.md`, desktop Round D34 in `HANDOFF_GPT5_D34.md`, desktop Round D35 in `HANDOFF_GPT5_D35.md`, desktop Round D36 in `HANDOFF_GPT5_D36.md`, and desktop Round D37 in `HANDOFF_GPT5_D37.md`: smoke-test diff/cost tightening, missed-schedule catch-up, transcript artifact expansion, help accuracy, diagnosable prose extraction fallback, JSON-text artifact recovery, graceful review-failure completion, snapshot diff coverage for bash-created and gitignored files, reviewer empty-diff verification hardening, packaged Electron desktop chat app, sandbox-compatible preload loading, review score consistency hardening, desktop failure-path UX fixes, desktop auto-approval controls, session titles/archive/delete, default-hidden thinking streams, resilient session rename/delete behavior, numbered goal references, desktop composer slash commands, shell child-process cleanup, single-instance launch behavior, strict dev-server ports, safe default workspace behavior, Tandem self-protection guards, blank-row suppression for hidden thinking, one-shot interrupted checkpoint resume, visible rename inputs, a non-contradictory project-folder gate, last-project startup context, old-empty-session pruning, permission-aware desktop plan confirmation, isolated test state via `TANDEM_HOME`, abort/timeout hardening for shell commands, honest effective-config synchronization for desktop permission/model changes, Windows-aware verification planning with graceful takeover receipt failure handling, live worker/leader activity visibility, folder-scoped desktop session operations, gated session deletion, visible session actions, diagnosable no-output model failures, unclipped natural-height session rows, a fixed non-horizontal-scrolling desktop shell, session conversation history, shared session memory, persistent leader-thread context, compaction, TANDEM.md project memory, deduplicated leader context assembly, provider-aware custom models, current Gemini built-ins, file attachments with media-aware reads, leader-first triage for direct answers, structural pre-planning triage for question/inspection requests, Codex CLI as a selectable subprocess-backed leader/worker engine, and OpenAI-compatible Codex CLI structured-output schemas.

## Task Results

- M0: done - scaffold, config, model registry, provider resolution, `tandem --version`.
- M1: done - Ink TUI shell, transcript/input/status, slash commands, Esc abort, non-TTY command fallback.
- M2: done - filesystem/search/bash tools, permission modes, denylist, AI SDK tool registry.
- M3: done - zod artifacts, leader/worker/reviewer state machine wired to live AgentFns, revise loop, takeover, verification enforcement, per-role cost ledger, diff provider, plan confirmation.
- M4: done with disclosed limits - `/goal`, `/loop`, `/schedule`, `/sessions`, `/resume`, `/status`, `/cost`, `/rounds`, `/takeover`, `/clear`, and `/model` picker are implemented. Startup missed-schedule handling is a visible prompt rather than an automatic catch-up workflow.
- M5: done with disclosed limits - docs, env example, validation retry loop, session JSONL persistence, checkpoint resume, and non-git diff fallback are implemented.
- R3-1: done - checkpoint events plus `initialState` resume, with a unit test proving resume from REVIEWING does not rerun the earlier build round.
- R3-2: done - non-git before-snapshot diff fallback using touched-path tracking and unified diffs, with a temp-dir test.
- R3-3: done - post-run leader goal-note pass appends one-line notes to active goals it identifies as advanced.
- R3-4: done - Esc resolves pending permission and plan promises with `false`.
- R3-5: done - bare `/model` opens a TUI role/model picker and persists the selection.
- R3-6: done - ran `npm audit` and `npm audit fix` without `--force`; no non-breaking fixes were available.
- R3-7: done - README and `.env.example` refreshed for Gemini, picker, live smoke test, and request flow.
- R4-1: done - refactored prose artifact extraction into an injectable helper and added network-free tests for success, failure preserving the original error, and extraction-call cost recording.
- R4-2: done - added `demo-todo/` to `.gitignore` and removed committed demo artifacts from git tracking.
- R4-3: done - upgraded dev-only Vitest to 4.1.9, overrode esbuild to a patched release, and confirmed audit now only reports the documented AI SDK runtime advisories.
- R4-4: done - enabled OpenAI-compatible streaming usage reporting and hardened token extraction for NaN/raw usage payloads so worker cost can be recorded in live runs.
- R5-1: no action - live worker-cost fix was confirmed by reviewer.
- R5-6: done - live smoke test now uses the same snapshot diff provider wiring as the app.
- R5-2: done - live smoke test separately asserts leader and worker output tokens plus non-zero worker dollars, and prints cost via `process.stdout.write`.
- R5-3: done - schedules persist `lastRunAt`; startup detects missed fires and prompts to run each missed schedule.
- R5-4: done - artifact messages appear in the transcript as summaries, with `ctrl+e` toggling the newest artifact details.
- R5-5: done - `/help` output now lists implemented command syntax with descriptions.
- R6-1: done - prose extraction fallback failures now preserve the original structured-generation failure and expose fallback extraction diagnostics.
- R6-2: done - artifact extraction now falls back from `generateObject` to strict JSON text via `generateText`, parses and validates with zod, and reviewer prompting makes the submit tool mandatory.
- R6-3: done - review retry exhaustion now ends in `DONE` with the last worker report preserved instead of throwing; planning failures still throw through the existing path.
- R7-1: done - non-git snapshot diffs now scan the workspace as the source of truth, include bash/plain-fs created files without touched-path hints, skip only noisy internal directories, and cap per-file snapshot reads.
- R7-2: done - reviewer prompting now requires read-only workspace inspection when the diff is empty, unexpectedly small, or inconsistent with the completion report before choosing revise or takeover.
- R8-1: done - tracker snapshots now win after `beforeBuild()`, including inside git worktrees, so gitignored generated project files appear in review diffs; plain `workingTreeDiff` keeps the git fast path.
- D0: done - Electron, electron-vite, React renderer, typed preload ping, `dev:app`, `dist:app`, and desktop build scaffold are wired while keeping CLI tests green.
- D1: done - main-process `TandemService` bridges `createLiveAgents`, `runOrchestration`, `SessionStore`, `CostLedger`, diff tracking, plan confirmation, permission requests, aborts, and streaming events into typed IPC.
- D2: done - desktop chat UI includes transcript bubbles, artifact cards, model dropdowns, status/cost display, composer Stop button, and in-window plan/permission modals.
- D3: done - sidebar supports project folder switching, session list/resume with checkpoint continuation, goals add/complete, and schedules add/remove with main-process cron tasks.
- D4: done - electron-builder packaging targets NSIS and portable Windows executables, includes a generated Tandem icon, and documents the desktop app and shortcut story.
- D5: done - renderer error boundary, main-process crash recording, IPC contract tests, and mock-service tests were added.
- Desktop revisit after R8-1: done - confirmed the desktop `TandemService` uses `createDiffTracker` as its orchestration diff provider, so packaged GUI review runs inherit the snapshot-first diff behavior.
- D6-1: done - kept the renderer sandboxed and configured electron-vite to emit the preload bridge as CommonJS `out/preload/index.js`; the BrowserWindow now points at that preload, and the renderer shows a clear preload-failure message if `window.tandem` is missing.
- D6-2: done - reviewer and prose-extraction prompts now require scores to match verdicts, approve verdicts with any score <= 2 fail validation and retry, revise/takeover can still carry low scores, and the desktop artifact card now displays the actual score fields.
- D7-1: done - pipeline errors now emit terminal `evt:done` events with `error: true`, and the renderer resets phase/composer state on done, error, and Stop paths.
- D7-2: done - missing API key failures now carry structured key/model/env-file details and render an actionable desktop banner without adding secret entry fields.
- D7-3: done - session-start system messages now include the effective leader and worker model IDs.
- D8-1: done - top-bar Permissions selector exposes `ask`, `auto-edit`, and `yolo`, persists via `config:set`, and the session-start line shows the active permission mode. The service reads the updated config when creating agents for the next run.
- D8-2: done - permission dialogs now include session-scoped "Allow all edits" and "Allow everything" controls, active auto-approval appears near the phase chip with a revoke button, and the policy lives in the main process without changing persisted config.
- D9-1: done - per-project session indexes store title/archive/timestamps, auto-title from the first user prompt, tolerate missing/corrupt indexes by lazy rebuild, expose rename/archive/delete IPC, update desktop sidebar controls, keep `/sessions` title-aware in CLI/TUI, and block active-session deletion in the desktop service.
- D9-2: done - streamed `<think>...</think>` spans and provider reasoning deltas are routed to `onThinking`, `showThinking` defaults false, desktop has a Show thinking toggle with hidden shimmer or dim italic visible thinking, and TUI honors the config flag.
- D10-1/D10-4: done - deleting the active desktop session now clears active state, removes its log, starts a fresh session, returns the replacement session to the renderer, shows a current-session marker, adds a New session button, and surfaces session-operation failures in the transcript.
- D10-2/D10-3: done - session index reconciliation now preserves existing title/archive metadata while adding missing files and dropping gone files, and all index mutations are serialized through an in-process promise queue so appends cannot clobber concurrent renames.
- D11-1: done - active standing goals are formatted as `Goal <id>: <text>` with up to two recent notes before reaching the planner in desktop and TUI paths, and the planner prompt now resolves user references like "goal 1" against that list.
- D11-2: done - desktop composer slash commands now handle `/help`, `/models`, `/model leader|worker <id>`, `/rounds <n>`, `/status`, `/cost`, `/goal add`, `/goal list`, and `/goal done` locally through existing IPC/actions; unknown slash commands are not sent to the leader.
- D11-3: no action - rename input was not blindly changed because the handoff says reviewer found no code defect and asked to wait for fresh-instance confirmation or DevTools output.
- D12-1: done - bash tool execution hides Windows shell windows, tracks descendant processes during command execution, taskkills the root/seen descendants after settle or timeout, reports cleanup in command output, and the worker prompt now forbids long-running verification servers/watchers.
- D12-2: done - Electron main process now uses `requestSingleInstanceLock`; second launches quit and focus/restore the existing window.
- D12-3: done - renderer dev server uses `strictPort: true` so a second dev app cannot silently shift ports.
- D13-1/D13-3: done - implicit desktop sessions now default to `~/TandemProjects`, create it on first run, mark the session as a safe default workspace, block normal prompts until the user picks a project folder, and display the working folder plus empty/existing project summary in the session-start line.
- D13-2: done - write/edit/bash tools now refuse Tandem's source/install roots and `~/.tandem` regardless of permission mode, while read-only tools remain available; Electron registers packaged/dev app roots as protected paths.
- D14-1/D14-2: done - thinking stream filtering now swallows whitespace stranded directly around suppressed `<think>` blocks, and desktop/TUI stream appenders ignore whitespace-only first deltas plus trim/drop empty trailing agent bubbles at turn end.
- D15-1: done - desktop resume checkpoints are now consumed only once, DONE checkpoints never seed follow-up prompts, and completed/error runs clear stored resume state.
- D15-2: done - session rename mode now auto-focuses/selects the input and constrains it within the sidebar row with `min-width: 0`, `overflow: hidden`, `width: 100%`, and `box-sizing: border-box`.
- D15-3: done - chose option (a): the desktop app no longer auto-starts a safe-default session on launch; it loads sidebar data, shows the folder gate, and keeps the composer action visible as Pick Folder until a project is selected.
- D16-1: done - desktop startup now loads global env plus the persisted last project's env/config without creating a session, and exposes startup state over IPC.
- D16-2: done - pre-pick sidebar, goals, schedules, model selectors, permission selector, and session ops use the last-used project context; the gate includes `Continue in <last folder>`, and pre-pick config edits carry into the next started session.
- D16-3: done - chose auto-prune: `listSessions` deletes sessions older than 1 hour only when their log contains no `user` event, and keeps any session with user messages.
- D17-1: done - desktop plan confirmation now opens a modal only in `ask` permission mode when session auto-approve-all is not active; Auto/Yolo and "Allow everything this session" auto-approve plans while the BuildPlan artifact remains emitted by the orchestrator.
- D18-1: done - global config/env, desktop state, sessions, and protection roots now honor `TANDEM_HOME`; Vitest forces it to a temp state root and snapshots the real `~/.tandem` tree to fail on accidental mutation.
- D19-1/D19-2/D19-3: done - planner, reviewer, and takeover prompts now forbid long-running verification commands; bash timeouts are capped at 300000 ms; shell commands listen to the run abort signal and invoke Windows tree cleanup on timeout or Stop.
- D21-1: done - every desktop session-start path flows through `applyStartedSession`, which sets renderer `session`, `config`, `appState.config`, and `showThinking` from the effective merged config returned by `startSession`.
- D21-2: done - desktop config changes now persist to global defaults and, when a session is active, the current project config; session start reports `permissions <mode> (project override)` when the project config overrides the global permission default.
- D21-3: done - changing permission mode while a run is active appends `permission mode applies from the next run.` to the transcript.
- D22-1: done - planner, worker, reviewer, and takeover live prompts now include host platform and shell guidance, with Windows-specific warnings against POSIX-only commands.
- D22-2: done - BuildPlan verification entries are mechanically validated to reject prose and Windows-hostile POSIX commands such as `cat`, piped `grep`, `ls`, `touch`, `rm`, `sed`, `awk`, `head`, `tail`, and `chmod`; D20-1 prose validation is included.
- D22-3: done - worker and takeover prompts require `verificationResults[].command` to repeat the plan command verbatim, with platform adaptations described in `output`.
- D22-4: done - takeover report validation now retries and then finishes DONE with a warning summary and preserved report artifact instead of throwing away completed work.
- D23-1: done - generated tools emit start/end activity events with role, tool, target, success, and elapsed time; desktop forwards them over `evt:tool` and appends `tool` session-log entries.
- D23-2: done - desktop shows a live activity strip while running, prioritizing active tools over thinking/writing/fallback model waits and turning amber after 60 seconds without activity.
- D23-3: done - desktop stores compact tool one-liners behind a per-run `show activity (N)` transcript toggle.
- D23-4: done - TUI prints compact tool one-liners inline as system messages.
- D24-1: done - desktop session lists refresh on session-start/resume paths and the sidebar labels the active session scope by folder name, including pre-pick last-folder state.
- D24-2: done - rename/archive/delete now throw on unknown or foreign session ids instead of creating phantom index rows or silently deleting nothing.
- D24-3: done - desktop resume translates CLI `/sessions` wording into GUI-specific stale-folder guidance.
- D25-1: done - desktop session deletion now requires an in-app confirmation modal with Cancel and Yes, delete; chose hard delete guarded by the modal rather than soft-delete/trash for this round.
- D25-2: done - no-output AI errors are enriched with provider details when exposed plus approximate prompt size; worker build context now summarizes previous reports, drops successful full outputs, truncates failed output/feedback, and obeys a hard character budget.
- D25-3: done - session action buttons are visibly outlined/filled with higher contrast, delete is visually distinct, and archive/unarchive emits a SYSTEM confirmation line.
- D26-1: done - sidebar lists now use natural-height flex rows with a taller scroll area, and session rows hide horizontal overflow only so Rename/Archive/Delete buttons and rename inputs are not vertically clipped.
- D27-1: done - desktop root, body, and app shell now lock to viewport dimensions with no page-level overflow; the shell is a fixed-width sidebar plus flexible main pane, status controls wrap/shrink, and transcript/composer/activity content is constrained to avoid horizontal page scroll.
- D28-1: done - desktop and TUI runs build compact prior-turn history from the session log, thread it into leader planning above the current request, restore context on resume, and show the active context turn count plus truncation note.
- D29-1: done - session memory notes now replay from `memory`/`memory:remove` log events with exact-text dedup, newest-40 cap, shared context formatting, a `remember` tool for leader/reviewer/takeover/worker, auto system notes for plan constraints and open review issues, and a desktop Session notes panel with manual add/delete and live agent-authored updates.
- D30-1: done - leader agent calls now share one rolling per-session message thread rebuilt from session logs, while worker streams/tools remain excluded; leader planning, review, and takeover append structured turns to that thread.
- D30-2: done - leader context compacts when `leaderContextBudgetTokens` is exceeded, summarizes older turns with the leader model, appends `memory:compaction`, and emits a visible compacted-turns system notice.
- D30-3: done - project memory now reads `TANDEM.md`, `AGENTS.md`, then `CLAUDE.md`, injects the result into leader and worker system prompts, reports loaded project instructions at session start, and makes the shared `remember` tool append bullets to `TANDEM.md`.
- D31-1: done - leader planner turns now include the compact session-log history only when no persistent leader thread exists, and rebuilt/existing user thread messages strip old embedded `Compact session-log history` blocks.
- D32-1: done - custom model config now supports optional `provider` values for native Google/Anthropic/OpenAI or OpenAI-compatible routing, keeps provider-less entries OpenAI-compatible for back compatibility, and requires `baseURL` only for OpenAI-compatible custom models.
- D32-2: done - added built-in Gemini entries for `google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-3-pro-preview`, and `google/gemini-3.1-flash-lite` using `GEMINI_API_KEY` with no guessed cost hints.
- D33-1/D33-2/D33-3/D33-4: done - desktop composer accepts attachments by file picker, drag/drop, and pasted images; files are copied into project `attachments/`, sent as path references, and leader/read_file contexts use image/PDF content parts for capable models or metadata stubs otherwise. Model registry and UI/model lists now expose `img`/`pdf` media badges.
- D34-1/D34-2/D34-3/D34-4: done - planner prompting now requires first-step question/inspection vs implementation triage, zero-task BuildPlans are rejected as direct-answer work, unsupported worker media triggers a leader-inspection planning warning, blind media stubs forbid guessing and require blocked reports when content matters, and remember guidance is limited to durable project facts.
- D35-1/D35-2: done - live planning now runs a no-tools leader classifier before any planner submit tool exists, routes question/inspection requests through a read-only answer branch with no `submit_build_plan` or `remember`, emits `triage: question`/`triage: implementation` notices, preserves implementation planning, and adds `triage: "auto" | "always-plan"` config.
- D36-1/D36-7: done - added Codex CLI discovery via override/env/PATH/Windows install glob, registered `codex/cli` without Tandem API-key auth, added hand-written JSON Schema files for Codex artifacts, implemented Codex subprocess runner with JSONL activity/text/usage parsing and temp output validation, wired Codex-backed worker/leader/review/takeover branches with self-protection guards and mixed-role support, and updated desktop/TUI model availability plus Codex billing notes.
- D37-1/D37-4: done - Codex JSON Schemas now require every declared property and express optional fields as nullable, Codex final output is normalized by stripping `null` keys before Tandem zod validation, schema-shape tests prevent missing required keys from recurring, and Codex stdout `error`/`turn.failed` events are included in thrown errors.

## Files Changed

- package.json
- package-lock.json
- tsconfig.json
- .env.example
- README.md
- .gitignore
- app/
- electron.vite.config.ts
- src/
- tests/
- COMPLETION_REPORT.md

## Verification Results

- `npx tsc --noEmit`: passed.
- `npm test`: passed. 23 test files, 149 tests; 1 live-smoke test skipped unless `RUN_LIVE=1`.
- `npm run build`: passed. `dist/index.js` and `dist/index.d.ts` emitted.
- `npx electron-vite build`: passed. Desktop main, CommonJS preload `out/preload/index.js`, and renderer emitted to `out/`.
- `npm run dist:app`: passed after stopping repo-local Electron processes that had locked the prior `release/win-unpacked/resources/app.asar`. Produced `release/Tandem Setup 0.1.0.exe` and `release/Tandem 0.1.0.exe`.
- `npm run dev:app`: launched successfully; logs showed main/preload builds, renderer dev server, env loading, and a visible Electron window titled `Tandem`.
- `npx tandem --version`: passed, printed `0.1.0`.
- `npx tandem /help`: passed.
- `npm audit`: reports only 7 low-severity AI SDK runtime advisories under pinned v5 packages.

## Deviations From Plan

- The TUI is a compact functional shell rather than a fully polished Claude Code-style interface.
- Desktop live provider execution was not run manually in this pass; the packaged app and bridge build locally, and provider-backed GUI smoke remains for reviewer/manual validation.
- I did not run the live provider-backed smoke test because the handoff says it costs real tokens and the reviewer runs it. The live path exists and is documented.

## Dependency Audit

- Upgraded dev-only `vitest` to 4.1.9 and added an `esbuild` override to resolve dev-tool advisories.
- `npm audit` now reports 7 low-severity vulnerabilities, all under pinned AI SDK v5 runtime packages via `@ai-sdk/provider-utils`.
- The remaining audit fix requires incompatible AI SDK major upgrades, so it was not applied.

## Acceptance Notes

Automated unit tests drive approve, revise-to-approve, round-exhaustion takeover, exact build-round counts, leader-requested takeover, worker blocked takeover, worker artifact failure takeover, artifact validation retry, checkpoint resume, tolerant verification matching, and non-git diff fallback with fake agents/files and no network.
Additional R4 unit tests cover prose artifact extraction fallback and OpenAI-compatible usage payload parsing.
Additional R5 unit tests cover missed-schedule detection.
Additional R6 unit tests cover fallback diagnostic errors, JSON-text artifact recovery, JSON-text fallback failure reporting, and graceful review retry exhaustion.
Additional R7 unit tests cover non-git snapshot diffs for files created outside tracker hints, simulating bash-created files.
Additional R8 unit tests cover gitignored files created inside a git worktree after snapshot capture, matching the live smoke failure mode.
Additional desktop tests cover IPC channel contract uniqueness and TandemService run/crash behavior with fake agents and fake session storage.
Additional D6 tests cover review verdict score consistency: approve with severe scores is rejected, while revise with severe scores is allowed.
Additional D7 tests cover terminal error events for failed desktop runs and structured missing-key guidance payloads.
Additional D8 tests cover session-scoped desktop auto-approval: edit mode suppresses write/edit prompts but still sends bash prompts, and all mode suppresses bash prompts too.
Additional D9 tests cover session index maintenance, rename/archive/delete, corrupt-index rebuild, auto-title truncation, and streaming thinking-filter edge cases across split tags, unclosed tags, multiple blocks, and suppressed callback delivery.
Additional D10 tests cover merge-safe session index reconciliation, serialized concurrent index updates preserving a rename, and active desktop session deletion rotating to a fresh session.
Additional D11 tests cover standing-goal formatting with user-visible ids and recent progress notes.
Additional D12 tests cover Windows shell child-process cleanup for a child that would otherwise outlive its parent.
Additional D13 tests cover safe default desktop project selection and tool-layer refusal for Tandem source roots, nested Tandem paths, and bash commands aimed at `~/.tandem`.
Additional D14 tests cover whitespace stranded between hidden thinking blocks, split-chunk variants, preserving real visible blank lines, and all-thinking turns producing no visible text.
Additional D15 tests cover DONE checkpoints not being reused for follow-up desktop prompts and interrupted resume checkpoints being consumed exactly once.
D15 manual CDP verification on the built Electron renderer: fresh launch showed the folder gate with composer button `Pick Folder`, disabled textarea, and no active session id; clicking Rename produced `.renameInput` x=27.67/right=234.33 inside sidebar x=0/right=278, with the input focused.
Additional D16 tests cover last-project launch context without creating a session, startup model availability from global env, pre-pick rename against the last project, pre-session config edits carrying into a picked project, and old-empty-session pruning that preserves user sessions.
D16 manual CDP verification on the built Electron renderer: fresh launch showed the gate, `sessionLabel: not started`, `Continue in <last folder>`, last-project sidebar sessions, and available models `minimax/minimax-m2.7`, `google/gemini-2.5-pro`, and `google/gemini-2.5-flash`.
Additional D17 tests cover desktop plan confirmation auto-approval in non-ask permission modes, ask-mode modal emission with response handling, and session auto-approve-all suppressing the plan modal.
Additional D18 tests cover `TANDEM_HOME` relocation for global config, env, and session paths; the full Vitest suite ran with the setup guard that compares the real `~/.tandem` tree before and after each test file.
Additional D19 tests cover timeout clamping, Windows shell grandchild cleanup on timeout, and aborting an in-flight shell command with descendant cleanup.
Additional D21 tests cover project permission override detection, global config patch persistence, pre-pick desktop config changes becoming future-folder defaults, active-session config changes writing both global and project config, and project override metadata returned by desktop session start. D21 renderer state trace: folder pick, Continue, New session, and active-session delete all call `applyStartedSession`, which sets dropdown-backed config and Show-thinking state from `started.config`; mid-run permission changes append the next-run-only system line.
Additional D22 tests cover prose verification rejection, Windows rejection of `cat launch.bat` and `cat index.html | grep -E 'src=|title='` with corrective alternatives, acceptance of `npm test`, `node test.mjs`, and `type launch.bat`, exact verification command echo enforcement, and graceful DONE completion after takeover report validation fails three times.
Additional D23 tests cover tool wrapper start/end event emission with timing and failed tool events preserving the original thrown error.
Additional D24 tests cover rename/archive/delete of nonexistent session ids, the phantom-entry regression after renaming an unknown id, and desktop GUI wording for cross-folder resume failures.
Additional D25 tests cover no-output error enrichment with provider detail and prompt-size accounting, prompt-size estimation, previous-report summary compaction, and hard worker-context character budgeting.
D26 is a CSS geometry fix; automated TypeScript and unit tests pass, and the acceptance geometry probe remains a reviewer CDP/screenshot check.
D27 is a CSS shell-layout fix; automated TypeScript and unit tests pass, and the acceptance no-horizontal-scroll checks remain a reviewer CDP/screenshot probe at multiple viewport widths.
Additional D28 tests cover chronological session-history formatting, latest-turn and character-budget caps, error-turn inclusion, and plain leader-answer fallback.
Additional D29 tests cover memory replay dedup/remove/cap, note formatting budget behavior, store add/delete APIs, remember-tool registration for leader and worker roles, oversized remember-note rejection, and shared-memory injection into worker context.
Additional D30 tests cover project instruction file precedence and truncation, TANDEM.md note insertion/deduplication, leader-thread replay and compaction-summary restore from session logs, desktop injection of project instructions into agent options, remember-note appends to TANDEM.md, and compaction event persistence/visibility.
Additional D31 tests cover digest omission when a leader thread exists, digest retention for threadless fallback callers, and stripping old embedded history digest blocks while rebuilding a leader thread from session logs.
Additional D32 tests cover native-provider custom models without `baseURL`, provider-less custom-model back compatibility, OpenAI-compatible `baseURL` validation, native Google `makeModel` routing, Gemini 3.x built-in registration without cost hints, and rejecting nonexistent `google/gemini-3.5-pro`.
Additional D33 tests cover collision-safe attachment naming, pasted-image writes, size refusal over 20 MB, image/PDF content parts for media-capable models, image/PDF metadata stubs for unsupported models, cheap PNG dimensions, unchanged text `read_file` behavior, and custom media-capability overrides.
Additional D34 tests cover zero-task BuildPlan rejection, worker-media routing warnings when attachments exceed worker capability, and blind image/PDF stubs that explicitly forbid guessing and direct blocked reports when the task depends on visual content.
Additional D35 tests cover fake-generator triage classification for questions, implementation requests, and explicit answer-directly wording; config override for `always-plan`; and question-branch tool availability excluding both `submit_build_plan` and `remember`.
Additional D36 tests cover Codex CLI path override/PATH/Windows newest-install discovery, exact `codex exec` argv construction, JSONL command/text/usage parsing, output-file parsing through the existing schemas, hand-written schema availability, and mixed API/Codex leader-worker combinations using a fake Codex executable instead of the real CLI.
Additional D37 tests cover recursive OpenAI Structured Outputs schema shape, null-to-absent Codex output normalization, and surfacing structured Codex JSON error events from failed subprocess runs.
