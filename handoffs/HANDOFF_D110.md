# D110 Handoff: Fix D109 Global Session Edge Cases

## Context

D109 made Tandem desktop sessions global instead of project-scoped. Review found two follow-up issues that should be fixed before treating the global session list as complete.

D109 touched:

- `src/session/store.ts`
- `app/main/tandem-service.ts`
- `app/renderer/src/main.tsx`
- `tests/session-store.test.ts`
- `tests/desktop-service.test.ts`

Inspect `git diff` first. Continue from the current D109 implementation if present. Do not touch unrelated moved handoff files or unrelated dirty worktree changes.

## Problem 1: Global List Bypasses Empty-Session Pruning

`listAllSessions()` scans `.jsonl` files directly under `.tandem/sessions`, but it does not reuse the existing stale-empty-session pruning behavior.

Existing project-scoped `listSessions(cwd, homeDir)` calls:

- `reconcileSessionIndex(...)`
- `pruneOldEmptySessions(...)`
- `writeIndex(...)`

The new global list should not resurrect old empty sessions in the desktop sidebar.

### Desired Fix

Make `listAllSessions(homeDir)` prune stale empty sessions consistently with project-scoped listing.

Suggested approach:

1. For each project-hash directory under `tandemStateDir(homeDir)/sessions`, reconcile and prune that project directory before collecting returned metadata.
2. Avoid duplicating pruning rules if possible.
3. Preserve `listSessions(cwd, homeDir)` behavior for CLI/TUI compatibility.
4. Add a regression test proving `listAllSessions(home)` does not return an old empty session and removes its stale `.jsonl`, while still returning sessions with user messages.

## Problem 2: Global List Shows Sessions Without Recoverable Project Ownership

`listAllSessions()` attaches `projectDir` by reading the first `session:start` event. Some session creation paths may create a `SessionStore` without writing `session:start`, especially older or TUI-created sessions.

Those sessions can appear globally with no `projectDir`. In desktop, they look clickable/manageable, but `resumeSession`, `renameSession`, `archiveSession`, and `deleteSession` can only resolve them from another project if `findSessionProjectDir(id, homeDir)` finds a project folder.

### Desired Fix

Make global desktop sessions safe and understandable when project ownership cannot be recovered.

Acceptable solutions:

- Preferred: make `SessionStore.create(cwd, homeDir)` itself record recoverable ownership in a durable way that does not require every caller to remember to append `session:start`.
- Or: add a sidecar/index field for project ownership that `findSessionProjectDir` and `listAllSessions` can use.
- Or: mark unresolved sessions in metadata and disable resume/manage actions in the desktop UI with a clear label.

Do not silently show unresolved sessions as normal clickable sessions if actions will fail from another project.

### Compatibility Requirements

- Existing sessions with a `session:start` event must continue to work.
- Existing sessions without `session:start` should either become recoverable through a robust fallback or be clearly marked as unresolved in the UI.
- TUI `/sessions` should remain project-scoped.
- Desktop global sessions should remain sorted by `lastActiveAt` descending.

## Tests To Add Or Update

Add focused tests in:

- `tests/session-store.test.ts`
- `tests/desktop-service.test.ts`

Required coverage:

1. `listAllSessions(home)` prunes old empty sessions consistently with `listSessions(cwd, home)`.
2. A session created without manually appending `session:start` has a safe global behavior:
   - If using durable ownership, `listAllSessions(home)` includes `projectDir`, and desktop can resume/rename/archive/delete it from another current project.
   - If using unresolved metadata, renderer/service behavior prevents misleading normal actions and exposes a clear state.
3. Existing D109 cross-project listing and rename/archive/delete tests still pass.

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
2. Open any project folder.
3. Confirm global sessions still appear.
4. Confirm old empty sessions do not clutter the list.
5. Confirm sessions with known project ownership can be resumed and managed across projects.
6. Confirm any unresolved legacy sessions are either recoverable or visibly not presented as normal working sessions.

## Completion Marker

After implementation and verification, create:

`handoffs/D110_done.txt`

Include:

- round number
- commit hash or hashes
- verification summary
- note about how unresolved legacy sessions are handled
