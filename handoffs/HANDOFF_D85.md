# Handoff D85 (desktop: "cannot delete a session" — real, live-confirmed, root cause found)

User report tonight, desktop app specifically (confirmed, not the CLI TUI — which has no delete
feature at all, separately noted below but out of scope for this fix). Live-diagnosed via the
real packaged app (rebuilt with D84's fix) plus a direct source-level reproduction — this is a
real bug, not user error.

## What's known (confirmed live, don't re-derive)

**The Delete button/modal flow itself is NOT broken.** Live-verified via real CDP clicks (full
mousedown/mouseup/click sequences) through the actual packaged UI on a synthetic idle session:
click Delete → confirmation modal renders correctly with the right session title → click "Yes,
delete" → session removed, sidebar updates, replacement session auto-starts if it was active. No
errors, no console exceptions, clean end-to-end.

**Root cause (confirmed via a direct source-level reproduction, not guessed):**
`src/session/store.ts` has a single MODULE-LEVEL `indexQueue` (line 22:
`let indexQueue: Promise<void> = Promise.resolve();`) shared across **every** session-index
operation in the running process — `deleteSession`, `renameSession`, `archiveSession`,
`listSessions`, AND, critically, `SessionStore.append()`'s own `updateSessionIndex` call (every
single event a running orchestration writes to its `.jsonl` file also enqueues an index-file
read+write on this SAME global queue, line ~202).

This queue is NOT scoped per-project or per-session-id. If ANY session in the currently-running
app instance is actively appending events rapidly (a live leader/worker orchestration round,
which streams many tool-call/text events per turn), a `deleteSession()` call for a completely
DIFFERENT, non-active session gets enqueued behind every one of those in-flight appends and only
runs once they all drain — in FIFO order, one at a time.

Reproduced directly (`src/session/store.ts`'s real `SessionStore`/`deleteSession` functions,
no mocks): fired 400 concurrent `append()` calls on an "active" session, then immediately called
`deleteSession()` on a different "target" session. Delete did not resolve until literally all 400
appends had finished (`appendsCompleted: 400/400` by the time delete returned), taking 352ms for
this small synthetic burst. This scales directly with append volume — the user's real
"tandem_hyperframe_video" project has 8 sessions, one of which was mid multi-hour orchestration
tonight with a 100k+-line session log (visible proof of very high append volume). A real burst of
that scale could plausibly queue a delete request behind many seconds of backlog.

**Compounding UX problem**: there is NO busy/pending indicator on the Delete (or Rename/Archive)
buttons in `app/renderer/src/main.tsx` (`confirmDeleteSession`, lines ~707-716) — no `disabled`
state, no spinner, no "Deleting…" text — while the IPC call is in flight. So instead of the user
seeing "this is taking a while," a queued-and-delayed delete looks exactly like "nothing
happened, delete doesn't work," matching the report verbatim.

**Separately noted, NOT in scope for this handoff (flagging for the user's own prioritization,
not asking implementer to fix now)**: the CLI TUI (`src/commands/misc.ts`'s help text) has no
delete/rename/archive commands at all — only `/sessions` (list), `/resume`, `/clear`. Desktop-only
feature gap, unrelated to this bug.

## What to do

D85-1 (primary fix, addresses the actual root cause): reduce how much index-queue work a live
orchestration's rapid appends generate, so a concurrent delete/rename/archive isn't stuck behind
an unbounded backlog. `SessionStore.append()`'s `updateSessionIndex` call only needs to keep
`lastActiveAt` (and occasionally `title`) eventually accurate — it does not need to hit the
shared index file on every single event. Coalesce/debounce these index writes (e.g., track the
pending `lastActiveAt`/title update in memory and flush to the shared index file at most once per
short interval — a few hundred ms is enough) instead of enqueueing a full index
read-reconcile-write on every `append()` call. The `.jsonl` event write itself must stay
synchronous/per-call (that's the actual durability-critical part); only the derived index-file
bookkeeping should be debounced. This directly bounds the worst-case queue depth a concurrent
delete/rename/archive has to wait behind, regardless of how bursty the active orchestration is.
Don't over-build this — a simple trailing-debounce (last-write-wins, flush-on-timer) is enough,
not a new subsystem.

D85-2 (UX safety net, cheap, do regardless of how much D85-1 helps): in
`app/renderer/src/main.tsx`, add a pending/disabled state to the Delete, Rename, and Archive
buttons while their respective async call is in flight (e.g. track a
`pendingSessionAction: string | undefined` keyed by session id, disable that row's action buttons
and show "Deleting…"/"Archiving…"/"Renaming…" while pending). This ensures that even in a genuine
edge-case delay (heavy concurrent activity, slow disk, etc.), the user sees it's working rather
than concluding the feature is broken.

## Acceptance

tsc + `npm test` green. A regression test reproducing the exact scenario I used to diagnose this
(a live "active" session firing many rapid `append()` calls while `deleteSession()`/
`renameSession()`/`archiveSession()` is called for a different session) that demonstrates the
queue-behind-appends wait is now bounded to roughly the debounce interval rather than scaling
with append count — assert on real elapsed time or on the number of index-file writes triggered,
not just "eventually resolves." Live verification: rebuild the packaged app
(`npm run dist:app`), launch it, start a session and keep it actively producing many rapid
tool-call events (a real or scripted burst), and confirm deleting/renaming/archiving a DIFFERENT
sibling session in the same project completes promptly and shows the new pending-state UI rather
than appearing to hang. Commit `D85-<n>:`, create `D85_done.txt`.
