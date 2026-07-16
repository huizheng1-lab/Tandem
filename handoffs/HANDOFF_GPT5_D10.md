# Handoff to GPT-5 — Round D10 (session rename/delete defects, reviewer-diagnosed)

Context: D9 features landed but the user reports rename and delete "do not work properly."
Reviewer traced three defects in `src/session/store.ts` and `app/main/tandem-service.ts` /
renderer. Fix all four tasks; the existing D9 tests must keep passing.

## D10-1: The active session can never be deleted (and the error is invisible)
`TandemService.deleteSession` throws "Cannot delete the active session" — but the app auto-starts
a session on every folder pick, so the newest session is ALWAYS active and the user's delete
click silently fails (the renderer does not surface the IPC rejection). Fix both ends:
- Service: when deleting the active session, close it out gracefully — clear `this.session` and
  `lastCheckpoint`, delete the files, and immediately start a fresh session (emit the usual
  session-start SYSTEM line). No error.
- Renderer: wrap ALL session-op IPC calls (rename/archive/delete/resume) in try/catch and show
  failures as a SYSTEM transcript line or toast — never swallow a rejection.

## D10-2: Index rebuild wipes custom titles and archived flags
`rebuildSessionIndex` (store.ts) regenerates the ENTIRE index from the .jsonl files and
overwrites the index file whenever `listSessions` finds any file missing from the index (this
happens in a create/list race and after any index corruption). All renames and archived flags
are lost. Fix: merge — keep every existing index entry as-is; only synthesize entries for ids
that are missing; drop entries whose files are gone. Add a unit test: index with a custom title
+ one unindexed file on disk → listSessions → custom title survives, new id appears.

## D10-3: Concurrent index writes race (rename lost during an active run)
Every `append` does an unserialized read-modify-write of index.json, so a rename during a run
can be clobbered by a concurrent append. Serialize all index mutations through a single
in-process promise queue (a `let queue = Promise.resolve()` chain in store.ts is sufficient).
Unit test: fire N concurrent updateSessionIndex-backed ops (appends + a rename) and assert the
rename survives.

## D10-4: Sidebar affordances
- The session auto-started on folder pick shows up as an untitled row the user then tries to
  delete. Give the active session a visible "(current)" marker.
- After delete/rename/archive, refresh the list from the service response (verify this is
  actually re-rendering — the user saw stale state).
- Add a "New session" button in the sidebar (starts a fresh session in the current folder) so
  users can rotate off a session they want to delete — complements D10-1.

## Acceptance
tsc + `npm test` green with the new tests; commits `D10-<n>:`. Reviewer will retest in the GUI:
rename survives a subsequent run and an app restart; archive survives restart; delete removes
rows permanently including the current session; errors (if any) appear in the transcript.
