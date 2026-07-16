# Handoff to GPT-5 — Round D15 (three runtime-verified regressions; reviewer drove the UI via CDP)

The reviewer launched the packaged app with --remote-debugging-port and drove the real UI
programmatically. Every finding below is reproduced, not theorized.

## D15-1 (CRITICAL): Every follow-up prompt returns "Session already completed."
`app/main/tandem-service.ts` `run()` passes `initialState: this.lastCheckpoint` on EVERY run
(line ~140). After any completed run, the stored checkpoint has phase DONE, so the next prompt
short-circuits in `runOrchestration` ("Session already completed.") without ever calling the
leader. This is the user's "refuses to answer, only says task is completed."
Fix: `lastCheckpoint` may seed `initialState` ONLY for continuing an interrupted session —
i.e., set it on `resumeSession` when the recovered checkpoint phase is not DONE, consume it on
the next run (clear it when the run starts), and always clear it when a run completes or errors.
A fresh prompt in an active session must start a fresh orchestration.
Unit test (service-level, fake orchestrator): run → done → run again: second run receives
`initialState: undefined`; resume of an interrupted session → next run receives the checkpoint;
the run after that receives undefined.

## D15-2: Rename input renders OFF-SCREEN — functionality is fine
CDP evidence: after clicking Rename, `.renameInput` bounding rect = `{ w:207, x:-144 }` — the
input starts 144px left of the viewport. With real key events + Save, rename works and persists
(verified twice, IPC and UI path). Users cannot click or see the input, hence "cannot input new
name or save."
Fix in `app/renderer/src/styles.css` / row markup: constrain the rename input to the session row
(`width: 100%; box-sizing: border-box; min-width: 0` on the input AND `min-width: 0; overflow:
hidden` on the grid row/column so the grid cannot overflow the sidebar), and on entering rename
mode `autoFocus` + `select()` the input. Verify by checking `getBoundingClientRect().x >= 0`
inside the sidebar — add a small DOM test if the project has one, else state manual verification
with coordinates in the report.

## D15-3: Folder gate hides the composer while a session is already running
After D13-1, on launch the transcript shows "Session … started; working in …\TandemProjects
(empty folder)…" while the UI simultaneously shows the "Choose your project folder" card and NO
Send button (CDP: composer/textarea exist, no Send/Stop button rendered). Auto-starting a
session in the safe workspace AND gating the composer is contradictory and reads as "chat is
broken."
Fix (pick one, state it): (a) do not auto-start any session until the user picks a folder — the
gate card is the only content, sidebar sessions/goals still browsable; or (b) allow chatting
into the default workspace and reduce the gate to a dismissible hint. Reviewer recommends (a).
Whichever is chosen: the Send button must exist whenever a session is active, and picking a
folder must always unblock the composer.

## Cleanup note
Reviewer probes left two sessions renamed to "probe-title-123" and "abc" in the user's session
list (harmless; user may delete).

## Acceptance
tsc + `npm test` green; commits `D15-<n>:`. Reviewer will re-drive the UI via CDP: (1) two
consecutive prompts in one session both produce real leader responses; (2) rename input rect
x >= sidebar left edge and a UI-path rename persists; (3) fresh launch shows either no session
until pick (option a) or a working Send button (option b).
