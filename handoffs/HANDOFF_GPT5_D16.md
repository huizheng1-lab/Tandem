# Handoff to GPT-5 — Round D16 (fresh-launch state is unusable after D15 gate)

Reviewer evidence (CDP against the packaged build at fresh launch, before any folder pick):
- `listModels`: all 9 models report `available: false`; both model selects render 9/9 options
  disabled → user cannot pick models and believes keys are lost.
- Session sidebar lists orphaned raw-id sessions from the ~\TandemProjects hash dir (leftover
  pre-D15 auto-sessions), not the user's real project sessions.
- Service-level session ops WORK at fresh launch (rename/archive/delete verified via IPC), so
  any UI failure is renderer gating, not the service.
Root cause: `loadEnv`/`loadConfig` run only inside `startSession`; D15-3 correctly stopped
auto-starting sessions, but nothing initializes env/config at launch anymore.

## D16-1: Initialize env + config at app startup, decoupled from sessions
On service construction (or app ready): load global env (`~\.tandem\.env`) merged with the
last-used project's `.env`, and config (global + last-used project) — WITHOUT creating a
session. `listModels` and the model dropdowns must reflect real key availability immediately at
launch. Persist `lastProjectDir` (e.g. in `~\.tandem\config.json` or a small app-state file);
when set and still existing, use it for env/config/session listing at launch.

## D16-2: Pre-pick sidebar must be useful and honest
- Sessions panel at launch shows the LAST-USED project's sessions (from lastProjectDir), not the
  TandemProjects orphans. All session ops (rename/archive/delete) must work pre-pick — remove
  any renderer gating on an active session for these handlers (service is already fine).
- The folder gate card gains a one-click "Continue in <last folder>" button next to Pick Folder
  (starts a session there), so returning users are one click from working.
- Model/permission dropdowns editable pre-pick; changes persist to the config that the next
  session will use.

## D16-3: Prune orphaned empty sessions
Pre-D15 builds auto-created sessions in ~\TandemProjects on every launch; they now clutter
fresh-launch lists as raw-id rows. In `listSessions`, auto-prune sessions whose log contains no
"user" event and whose lastActiveAt is older than 1 hour (delete file + index entry), or hide
them behind the Archived toggle — state the choice. Never prune sessions with user messages.

## Acceptance (reviewer will re-drive via CDP)
Fresh launch with global keys present: listModels shows gemini/minimax available and dropdowns
enabled; sessions panel shows the last-used project's sessions; a UI-path rename persists BEFORE
any folder pick; "Continue in <last folder>" starts a session and the composer accepts a prompt.
tsc + `npm test` green; commits `D16-<n>:`.
