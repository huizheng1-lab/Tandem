# Handoff to GPT-5 — Round D9 (session management + thinking suppression)

Context: D8 APPROVED (40 tests; permission selector + session-scoped auto-approve verified).
Two user-requested features. Same rules: tsc + `npm test` green per task, commits `D9-<n>:`,
honest report, don't run the live smoke test.

## D9-1: Session management — titles, rename, archive, delete
Sessions are UUID-named JSONL files in `~/.tandem/sessions/<project-hash>/` with no metadata.

Storage: add a per-project index file `~/.tandem/sessions/<project-hash>/index.json`:
`{ [sessionId]: { title, archived: boolean, createdAt, lastActiveAt } }`, maintained by
`src/session/store.ts` (create/update entries on session create/append; tolerate a missing or
corrupt index by rebuilding entries lazily). Auto-title: on the first user message of a session,
set `title` to that prompt truncated to 48 chars (word boundary, ellipsis).

IPC + service: `session:rename { id, title }`, `session:archive { id, archived }`,
`session:delete { id }` (deletes the .jsonl and the index entry). `sessions:list` returns
metadata objects (id, title, archived, timestamps), sorted by lastActiveAt desc.

Sidebar UI: each session row shows the title (fallback: id prefix) + relative time; hover/⋯ menu
with Rename (inline edit), Archive/Unarchive, Delete (confirmation dialog — deletion is
permanent; do NOT delete the active session without ending it first). Archived sessions collapse
under an "Archived" section toggle. Deleting or archiving never touches the project's files —
only the session log.

CLI parity (small): `/sessions` shows titles; `/session rename <id> <title>` optional — implement
only if trivial with the existing command dispatch, otherwise note as skipped.

Tests: store-level unit tests for index maintenance, rename/archive/delete, corrupt-index
recovery, auto-title truncation.

## D9-2: Suppress agent "thinking" in the transcript
Problem: MiniMax M2.x emits inline `<think>...</think>` blocks in its text stream; leaders also
stream reasoning prose before acting. The transcript should stay clean by default.

Core: in `src/agents/runner.ts`, add a streaming filter that strips `<think>...</think>` spans
(handle tags split across stream chunks — keep a small carry buffer; also handle an unclosed
tag at stream end by suppressing the remainder). Emit the suppressed spans through a separate
optional callback `onThinking?(delta)` so UIs can still opt in. Additionally, where providers
expose reasoning as distinct parts (AI SDK reasoning deltas), route those to `onThinking`, not
`onText`.

Config: `showThinking: boolean` (default `false`) in `src/config/schema.ts`.

Desktop UI: a "Show thinking" toggle (settings or top bar). Hidden mode: render a subtle
"thinking…" shimmer on the active agent bubble while onThinking deltas arrive but no visible
text. Shown mode: thinking renders inside the bubble in dimmed/italic style, clearly separated
from the real output. TUI: honor the config flag (hide = drop thinking deltas; no toggle UI
needed this round).

Tests: unit-test the stream filter — tags within one chunk, tags split across chunks
(`"<thi"`+`"nk>secret</think>visible"`), unclosed tag, multiple blocks, and that onThinking
receives what onText suppressed.

## Acceptance
Reviewer will: rename/archive/delete sessions in the GUI and confirm the JSONL/index state on
disk; run a live prompt and confirm the transcript shows no <think> content with the toggle off
and shows it dimmed with the toggle on.
