# W0014 Session Search in the Desktop App

Objective: add a read-only global session search that matches session titles and transcript content, emits incremental result batches, and shows highlighted snippets with project context in the desktop sidebar. The feature must not change session JSONL or index formats or mutate session data.

This epic is `autonomy=full`. After independent acceptance of this plan candidate, the relay may auto-approve it and begin one implementation step per turn.

## Revision history

- Revision 1: initial three-step implementation plan, corrected before candidate handoff so streaming is end-to-end and all referenced store APIs exist.

## Confirmed repository constraints

- Session files live under `<tandemStateDir>/sessions/<projectHash>/<sessionId>.jsonl`; each project-hash directory may also contain `index.json` and `project.json`.
- `SessionEvent` and `SessionMetadata` are exported by `src/session/store.ts`, but `readSessionEvents` is private and `tandemStateDir` is exported by `src/paths.ts`. The new search module therefore owns its read-only incremental JSONL reader and imports `tandemStateDir` from `src/paths.ts`.
- Existing renderer-to-main event subscriptions use typed channels, `webContents.send`, and preload unsubscribe functions. Search streaming will follow that established contract instead of pretending `ipcRenderer.invoke` can stream.
- The current global Sessions list in `app/renderer/src/main.tsx` already owns resume, rename, archive, and delete behavior. Search results reuse resume; the normal list and all management actions remain unchanged when the query is empty.

## Search contract

- Trim the query, split on whitespace, lowercase tokens, and require every token to occur in a session's searchable title/transcript text. Occurrences are counted case-insensitively.
- Searchable transcript fields are `user.payload.prompt`, leader/worker `text` or `message` payload text (`text` and/or `delta`), `done.payload.summary`, and `memory:compaction.payload.summary`. Other events do not contribute content.
- Return at most one hit per session. A hit contains `id`, `title`, `lastActiveAt`, optional `projectDir`, `matchCount`, `sourceRole`, and `{ text, start, end }` snippet offsets. Offsets are half-open and always refer to the returned snippet.
- Rank snapshots by `matchCount` descending and then `lastActiveAt` descending. Batches are replacement snapshots, not append-only deltas, so a later match can safely reorder earlier hits.
- An empty query emits one terminal batch with no hits and `scannedCount: 0`. Missing roots, unreadable files, and malformed lines are skipped and reported through `skippedCount`; they do not reject the whole search.
- Each scan has a renderer-generated `searchId`. Every batch echoes that ID, allowing the renderer to ignore stale results. Cancellation is explicit and aborts the matching scan in the main process.

## Ordered steps

- [ ] Step 1: implement and unit-test the read-only store-side incremental scanner.
- [ ] Step 2: wire typed start/cancel/batch IPC, service orchestration, and the preload bridge.
- [ ] Step 3: add the debounced sidebar search UI, progressive results, highlighting, project labels, cancellation, and rendered evidence.

Every intermediate candidate must leave focused tests, `npm run typecheck`, `npm test`, and `git diff --check` green. Exactly one checkbox is completed per implementation candidate.

## Step 1 - Store-side incremental scanner

Expected files:

- `src/session/search.ts` (new)
- `tests/session-search.test.ts` (new)
- this plan file, only to check Step 1 complete

Implementation:

- Export `SessionSearchHit`, `SessionSearchBatch`, `SessionSearchOptions`, `extractSnippet`, `matchEventText`, `scoreSearchableText`, `searchSessionsStream`, and constants for default batch size, result limit, and snippet context.
- Walk only directories below `path.join(tandemStateDir(homeDir), "sessions")`. Read `index.json` and `project.json` without rewriting or reconciling them; fall back to file timestamps, a `session:start` project directory, and the first user prompt when metadata is absent.
- Read JSONL incrementally with `createReadStream` plus `node:readline`, checking `AbortSignal` between lines and sessions. A malformed line increments `skippedCount` and scanning continues with the next line.
- Coalesce adjacent `text`/`message` deltas from the same role before scoring so streamed model output yields a readable matched line. Preserve the source as `title`, `user`, `leader`, `worker`, `summary`, or `compaction`.
- Yield a ranked replacement snapshot after each configured number of scanned sessions and one terminal batch with `done: true`. Apply the result limit only after ranking each snapshot.

Focused evidence in `tests/session-search.test.ts`:

- Empty and whitespace-only queries.
- Case-insensitive title, user prompt, leader text, worker text, done summary, and compaction summary matches.
- Multi-token all-token semantics, snippet bounds/highlight correctness, match counts, ranking, and timestamp tie-breaking.
- Cross-project discovery and `projectDir` fallback behavior.
- Incremental batches with `batchSize: 1`, terminal batch semantics, cancellation after the first yield, malformed-line recovery, missing root, and an unreadable/deleted-file race.
- Assert search does not change bytes or mtimes of JSONL, index, or project sidecar fixtures.

Terminating focused command:

`npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/session-search.test.ts`

## Step 2 - Typed streaming IPC and service orchestration

Expected production files (five):

- `app/shared/ipc.ts`
- `app/main/tandem-service.ts`
- `app/main/index.ts`
- `app/preload/index.ts`
- `src/session/search.ts` only if a narrow adapter discovered during wiring is required

Test file: `tests/desktop-service.test.ts`. The plan file is also updated to check Step 2 complete.

Implementation:

- Add typed channels `sessionsSearchStart`, `sessionsSearchCancel`, and `sessionSearchBatch`.
- Define `SessionSearchRequest { searchId: string; query: string; limit?: number }`, `SessionSearchCancelRequest`, and a batch event carrying `searchId`, ranked hits, progress counts, and `done`.
- Add service methods that start a scan with an `AbortController`, stream each replacement batch through a supplied callback, cancel an existing scan by ID, and always remove completed/failed/aborted controllers. Starting the same ID first cancels the old controller.
- In the main process, handle start/cancel requests and send batches only to `event.sender`, preventing cross-window leakage. Renderer destruction cancels its active scans.
- Expose `startSessionSearch`, `cancelSessionSearch`, and `onSessionSearchBatch` through the context-isolated preload API. The preload listener returns an unsubscribe function, matching existing event subscriptions.

Focused evidence:

- Extend `tests/desktop-service.test.ts` to prove multiple batches arrive before completion, ranking is preserved, empty queries terminate cleanly, cancellation stops later batches, duplicate IDs replace the prior scan, and controller cleanup occurs after success, failure, and cancellation.
- Add or extend the smallest existing IPC/preload contract test to assert all three channel names and API methods are wired. If no such test exists, create `tests/desktop-session-search-ipc.test.ts` without adding a dependency.

Terminating focused command:

`npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/desktop-service.test.ts tests/desktop-session-search-ipc.test.ts`

## Step 3 - Sidebar search UI and visual evidence

Expected production files (three):

- `app/renderer/src/main.tsx`
- `app/renderer/src/search-session-results.tsx` (new presentational component)
- `app/renderer/src/styles.css`

Expected test/evidence files:

- `tests/renderer-session-search.test.tsx`
- a screenshot under `.tandem/` produced by a terminating renderer harness (ignored and excluded from candidate files)
- this plan file, checked complete

Implementation:

- Add a controlled search input above the global Sessions list. Debounce non-empty input for 120 ms, create a unique `searchId`, subscribe before starting, and cancel/unsubscribe on query change and unmount.
- Ignore batches whose `searchId` is not current. Replace visible hits on each batch so ranked results update progressively; show a scanning indicator with `scannedCount`, a no-match state only after `done`, and a skipped-file notice when `skippedCount > 0`.
- Render title, project label, timestamp, source role, and snippet. Wrap exactly `snippet.text.slice(start, end)` in `<mark>` after clamping offsets. Selecting a hit reuses `replaySession(id)`.
- While a trimmed query is non-empty, show search results instead of the normal active/archived lists. Clearing the query restores the existing lists and their rename/archive/delete controls unchanged.
- Keep keyboard focus visible, label the input accessibly, expose progress with `aria-live="polite"`, and ensure long snippets/path labels wrap without widening the sidebar.

Focused evidence:

- `tests/renderer-session-search.test.tsx` uses fake timers and a stub desktop API to prove debounce, progressive replacement batches, stale-ID suppression, cancellation/unsubscribe, loading/no-match/error states, correct `<mark>` text, project/role/timestamp display, result selection, clear-to-restore behavior, and preservation of existing session management controls.
- Run a terminating render/screenshot harness at representative desktop dimensions with results, a long snippet, and a long project path. The leader must inspect the screenshot with the vision tool before approving the visual step; exit codes alone are insufficient.

Terminating focused command:

`npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/renderer-session-search.test.tsx`

## Safety and scope

- No session storage format, agent, provider, prompt, compaction, credential, dependency, reciprocal script, or protocol changes.
- Search code performs filesystem reads only. It never calls session append, rename, archive, delete, index reconciliation, or sidecar self-healing.
- Each step stays within six production files and roughly 400 net new lines. If an implementation cannot satisfy that bound, revise this plan in its own candidate instead of combining steps.
- No real-model smoke test is required unless an implementation unexpectedly touches a protocol-designated model path; such a scope change requires plan revision first.
