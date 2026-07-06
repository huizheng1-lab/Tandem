# Handoff to GPT-5 — Round D21 (permission mode appears ignored — config/UI sync)

User report: "seems to ignore the auto permission." Reviewer findings on the machine: the
user's project folders had `permissionMode: "yolo"` but the GLOBAL `~\.tandem\config.json` said
"ask" — so any new/unconfigured folder silently started in Ask mode, while the top-bar dropdown
could still display a stale "Auto" from before the session started. (Reviewer set the global to
"yolo" manually as an interim fix.)

## D21-1: Permissions dropdown must never lie
After `startSession` (folder pick, Continue, New session), the renderer must set the dropdown
(and the Show-thinking toggle etc.) from the EFFECTIVE merged config returned by the session —
verify this happens on every session-start path, not just app boot. Add/extend a renderer or
service test if feasible; otherwise demonstrate with a state-trace in the report.

## D21-2: Mode changes should persist as the user's default, not per-folder trivia
Changing the Permissions dropdown (or leader/worker models) currently persists via
`saveProjectConfig` to the ACTIVE project folder only; pre-pick changes go to the default
workspace and are then lost when a real folder is picked. Change: dropdown/model changes write
to BOTH the current project config (if a session is active) AND the global
`~\.tandem\config.json` (as the new default for future folders). Read path stays
global-then-project. Note in the session-start SYSTEM line when a project overrides the global
mode (e.g. "permissions ask (project override)").

## D21-3: Mid-run mode changes
`createLiveAgents` captures permissionMode at run start; changing the dropdown during a run has
no effect until the next run. That's acceptable — but make it visible: when the dropdown changes
while `running`, show a SYSTEM line "permission mode applies from the next run."

## Acceptance
tsc + `npm test` green; commits `D21-<n>:`. Reviewer will CDP-drive: fresh folder with no
project config + global yolo → run executes with zero prompts and dropdown shows Auto; set
dropdown to Ask pre-pick → pick a folder → dropdown still shows Ask and a run prompts.
