# D111 Handoff: Finish D110 Legacy Global Session Safety

## Context

D109 made Tandem desktop sessions global. D110 added a `project.json` ownership sidecar for new sessions and improved global listing, but review found two remaining legacy-data issues.

Inspect `git diff` first. Continue from the current D109/D110 working-tree edits if present. Do not touch unrelated moved handoff files or unrelated dirty worktree changes.

## Review Findings To Fix

### Finding 1: Legacy Project Directories Without `project.json` Still Bypass Global Pruning

In `src/session/store.ts`, `listAllSessions(homeDir)` only runs:

- `reconcileSessionIndex(...)`
- `pruneOldEmptySessions(...)`
- `writeIndex(...)`

when the project-hash directory has the new `project.json` sidecar.

This leaves pre-D110 directories with session files that contain `session:start` events but no sidecar unpruned. Those are exactly the existing-data cases D110 needed to protect.

#### Required Fix

When scanning each project-hash directory in `listAllSessions(homeDir)`, derive the project cwd using this priority:

1. `project.json` sidecar, if present and valid.
2. Any `.jsonl` session in that hash directory with a valid first `session:start` event containing `projectDir`.
3. If neither exists, treat the directory as unresolved.

If a cwd is derived from either sidecar or `session:start`, run the same reconcile/prune/write flow used by project-scoped `listSessions(cwd, homeDir)` before collecting global rows.

Also consider writing `project.json` opportunistically when deriving cwd from `session:start`, so old directories self-heal after one global scan. Do this only if it is safe and deterministic.

### Finding 2: Unresolved Legacy Sessions Are Still Presented As Normal Clickable/Manageable Rows

In `app/renderer/src/main.tsx`, session rows are still fully actionable even when `item.projectDir` is missing. For legacy sessions with no `session:start` and no sidecar, clicking resume/rename/archive/delete later fails through the service.

D110 required unresolved sessions not be silently presented as normal working sessions.

#### Required Fix

Choose one clear behavior:

- Hide unresolved sessions from the desktop global list, OR
- Render them with an explicit unresolved label and disable resume, rename, archive/unarchive, and delete actions, OR
- Make them recoverable with a robust deterministic fallback.

Preferred for now: render them visibly as unresolved and disable actions, because it preserves visibility without pretending they are usable.

Suggested UI text:

`unresolved project - cannot resume from global list`

Do not disable actions for normal sessions with `projectDir`.

## Tests To Add Or Update

Add focused regressions in:

- `tests/session-store.test.ts`
- `tests/desktop-service.test.ts`

Required coverage:

1. A pre-D110 project-hash directory with no `project.json` but with a `session:start` event is pruned by `listAllSessions(home)`.
   - Old empty session is removed.
   - Old session with a user message survives.
   - Returned surviving session has `projectDir`.

2. A legacy unresolved session with no `project.json` and no `session:start` is not treated as a normal actionable desktop session.
   - If renderer tests are not available, add a small pure helper for row action state and test it.
   - The behavior must distinguish unresolved rows from normal rows.

3. Existing D109/D110 tests still pass:
   - global session listing across project folders
   - sidecar recovery for sessions without `session:start`
   - rename/archive/delete across projects

## Acceptance Checks

Run from:

`C:\Users\huizh\Apps\HZ code`

Commands:

```powershell
npm run typecheck
npm test
git diff --check
```

Manual desktop check:

1. Launch Tandem desktop.
2. Confirm normal sessions from other project folders still appear and can resume.
3. Confirm old empty sessions do not clutter the list.
4. Confirm any unresolved legacy sessions are visibly marked unresolved and their actions are disabled, or are hidden if that approach is chosen.

## Completion Marker

After implementation and verification, create:

`handoffs/D111_done.txt`

Include:

- round number
- commit hash or hashes
- verification summary
- short note explaining how unresolved legacy sessions are handled
