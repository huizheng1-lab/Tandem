# D109 Handoff: Make Tandem Desktop Sessions Global

## Problem

Tandem desktop currently shows only sessions for the currently selected project folder. This is wrong for the desktop app UX.

Sessions are already stored outside project workspaces under:

`C:\Users\huizh\.tandem\sessions`

but the sidebar calls project-scoped `listSessions(projectDir)` and labels the list as `Sessions - current folder`. Because of this, a session created for:

`C:\Users\huizh\tmp_test_data\three kingdoms`

does not appear when Tandem is opened on:

`C:\Users\huizh\Apps\HZ code`

## Desired Behavior

When the Tandem desktop app is open, the sidebar should show all saved sessions across all projects.

Each session row should show:

- session title
- relative last active time
- current marker if active
- owning project folder, for example `...\tmp_test_data\three kingdoms`

Clicking a session should resume it and automatically switch Tandem to that session's project folder. Existing resume logic already mostly supports this via `findSessionProjectDir`.

Rename, archive, unarchive, and delete must work for global sessions, not only sessions in the current project.

## Important Existing Code

Session storage:

`C:\Users\huizh\Apps\HZ code\src\session\store.ts`

Desktop service:

`C:\Users\huizh\Apps\HZ code\app\main\tandem-service.ts`

Renderer sidebar:

`C:\Users\huizh\Apps\HZ code\app\renderer\src\main.tsx`

Tests:

`C:\Users\huizh\Apps\HZ code\tests\session-store.test.ts`

`C:\Users\huizh\Apps\HZ code\tests\desktop-service.test.ts`

## Current Partial Work

A previous interrupted attempt already modified:

- `src/session/store.ts`
- `app/main/tandem-service.ts`
- `app/renderer/src/main.tsx`

Do not assume it is complete. Inspect `git diff` first. Either continue from those edits or replace them carefully.

Do not touch unrelated moved handoff files or unrelated dirty worktree changes.

## Suggested Implementation

1. In `src/session/store.ts`, add global session listing:
   - Scan `path.join(tandemStateDir(homeDir), "sessions")`.
   - For each project-hash directory, read its `index.json`.
   - For each `.jsonl` session file, read the first `session:start` event to recover `projectDir`.
   - Return `SessionMetadata[]` sorted by `lastActiveAt` descending.
   - Add optional `projectDir?: string` to `SessionMetadata`.

2. Keep existing `listSessions(cwd, homeDir)` for CLI/TUI compatibility.
   - Do not break `/sessions` in the TUI.

3. In `app/main/tandem-service.ts`:
   - Make desktop `listSessions()` return global sessions.
   - For `renameSession`, `archiveSession`, and `deleteSession`, resolve the owning project folder by session ID before mutating.
   - Use existing `findSessionProjectDir(id, homeDir)` or a shared helper.
   - If no owning project is found, fail with a clear error.

4. In `app/renderer/src/main.tsx`:
   - Change sidebar label from `Sessions - {folder}` to `Sessions`.
   - Display each row's `projectDir` under or beside the title using the existing `displayPath()` helper.
   - Keep active/current session display behavior.

5. Tests:
   - Add a store test proving the global list includes sessions from two different cwd values.
   - Add a desktop-service test proving `service.listSessions()` shows sessions outside the current project.
   - Add a desktop-service test proving rename/archive/delete operate on a session from another project.
   - Existing tests should still pass.

## Acceptance Checks

Run from:

`C:\Users\huizh\Apps\HZ code`

Commands:

```powershell
npm run typecheck
npm test
git diff --check
```

Manual check:

1. Launch Tandem desktop.
2. Open any project folder.
3. Confirm sessions from `C:\Users\huizh\tmp_test_data\three kingdoms` appear in the sidebar.
4. Click the Three Kingdoms session.
5. Confirm Tandem switches to `C:\Users\huizh\tmp_test_data\three kingdoms` and resumes the session.

## Known Session IDs For Manual Verification

The Three Kingdoms sessions found under `C:\Users\huizh\.tandem\sessions\3f06666ea326` are:

- `6ef2c9cb-ebe1-4128-beba-4a4d910bf3d8` - `three kingdoms game`
- `e874fcf8-daba-445b-982e-83ceab9dbb8f` - `allow different cities in the kingdom to have...`

## Notes

No verification has been run for the partial edits currently in the workspace.
