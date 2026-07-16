# Handoff D88 (URGENT: switching between sessions is slow/stuck — real cause found, not guessed)

User report: "switch from one session to another is not smooth, often stuck." Root-caused via
direct code read plus real file-size measurement on the user's own live data before writing this
— not guessed.

## Root cause (confirmed)

`app/main/tandem-service.ts`'s `resumeSession(id)` (~line 311-312):
```ts
const projectDir = this.deps.openSession ? this.projectDir : (await findSessionProjectDir(id, this.homeDir)) ?? this.projectDir;
```
`this.deps.openSession` is ONLY set in tests (dependency injection) — in the real running app it's
always `undefined`, so **every single session switch, including switching between two sessions
inside the SAME already-open project, unconditionally calls `findSessionProjectDir(id, homeDir)`**
before even trying the obviously-correct fast path (the session is almost always already in
`this.projectDir`, which the service already knows).

`src/session/store.ts`'s `findSessionProjectDir()` (~line 50-62):
```ts
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const filePath = path.join(root, entry.name, `${id}.jsonl`);
  if (!existsSync(filePath)) continue;
  const events = await readSessionEvents(filePath);   // <-- full unbounded read+parse
  const started = events.find((event) => event.type === "session:start")?.payload as ...;
  return typeof started?.projectDir === "string" ? started.projectDir : undefined;
}
```
Two compounding problems, both measured live on the user's real `~/.tandem/sessions/` directory:

1. **It linearly scans EVERY project-hash directory** the user has ever used. Counted right now:
   **46 project-hash directories** have accumulated (real projects plus throwaway test dirs from
   recent live-testing rounds). The `existsSync` checks themselves are cheap, but this is still
   unnecessary work on every switch when the target session's project is almost always already
   known.
2. **Once it finds the matching file, it calls `readSessionEvents()` — the UNBOUNDED full-file
   read+parse (`readFile(path, "utf8")` then `JSON.parse` every line) — just to extract the
   `session:start` event's `projectDir` field, which is always the very first event written to
   a session file.** Measured live: the user's real session
   `48cc7d6d326e/a5629880-4bba-43e6-bb32-8f87129dbb26.jsonl` is **29,691,568 bytes (~29.7MB)**.
   Switching to that session (or triggering this lookup at all while it's the growing active
   session) means fully reading and JSON-parsing a 29.7MB file on the main process's event loop,
   just to read one field from line 1.

This is the same class of bug D86 already fixed for the UI transcript render path
(`SessionStore.readRecent()` added specifically to avoid full-file reads for large sessions) — but
`findSessionProjectDir` is a SEPARATE call site that D86 never touched, and it's on the hot path
for every session switch, not just resume-of-a-huge-session.

Secondary, smaller finding while investigating: there is no pending/loading state on the sidebar's
session-title buttons in `app/renderer/src/main.tsx` while `replaySession(id)`'s
`tandem.resumeSession()` call is in flight (unlike the Rename/Archive/Delete buttons, which got a
pending-state treatment in D85). Combined with the above, a slow resume gives literally zero
visual feedback — the user has no way to tell "it's working" from "it's stuck," and nothing stops
a second click (on the same or a different session) from firing a concurrent, overlapping
`resumeSession()` call while the first is still in flight, which could resolve out of order and
leave the UI showing the wrong session.

## What to do

D88-1 (primary fix, addresses the actual root cause): in `resumeSession()`, try the obvious fast
path FIRST — attempt to open the session directly in `this.projectDir` (the currently-active
project the service already knows), and only fall back to the expensive
`findSessionProjectDir()` cross-project scan if that fails (i.e., the session genuinely isn't in
the current project — e.g., the user is resuming a session from a DIFFERENT project via some other
entry point). This alone should make the common case (switching within the same project) skip the
expensive scan entirely.

D88-2 (primary fix, the other half): `findSessionProjectDir()` itself should not need to read the
entire session file — it only needs the FIRST event (`session:start` is always written first).
Add a bounded head-read (mirror `SessionStore.readRecent()`'s tail-read approach in
`src/session/store.ts`, but reading forward from the start and stopping once a `session:start`
event is found, rather than the whole file) so this lookup is cheap regardless of how large the
session has grown, even when the fallback path in D88-1 does need to run.

D88-3 (small, do while in this area): add a pending/loading indicator for session-switching in
`app/renderer/src/main.tsx`, mirroring D85's `pendingSessionAction` pattern — disable session-title
buttons (or at least the one being clicked) while `replaySession()`'s `resumeSession()` call is in
flight, and guard against overlapping calls (e.g., ignore a new switch request if one is already
in progress, or cancel/ignore a stale response if a newer switch was requested before the old one
resolved) so rapid clicking can't leave the UI in an inconsistent state.

## Acceptance

tsc + `npm test` green. A regression test proving `resumeSession()` does NOT call the expensive
cross-project scan when the target session already exists in the current project (e.g., spy/mock
`findSessionProjectDir` or an equivalent seam and assert it's not invoked in that case). A test for
D88-2 proving the head-read approach returns the correct `projectDir` from a large synthetic
session file without reading the whole thing (e.g., time it, or assert on bytes-read if that's
observable, similar in spirit to the existing `readRecent` tests). Live verification: rebuild the
packaged app, use the real ~30MB session file (or a synthetic file of comparable size) and confirm
switching TO it and AWAY from it feels immediate, not just "eventually resolves" — paste an actual
timing observation, not just "it built." Commit `D88-<n>:`, create `D88_done.txt` in `handoffs/`.
