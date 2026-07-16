# Handoff to GPT-5 — Round D29 (shared session memory for leader AND worker)

User request, extending D28: within a session, a shared memory visible to both agents. Today
the worker sees only plan + feedback + previous report; anything learned in earlier turns
(user preferences, project quirks, environment facts) is invisible to it. Implement D28 and D29
in one pass if convenient — they touch the same context-assembly code.

## D29-1: Session memory store + `remember` tool
- New module `src/session/memory.ts`: session-scoped note list persisted as session-log events
  (type "memory", payload { text, by: "leader"|"worker"|"system"|"user" }) and rebuilt from the
  log on resume. API: addNote, listNotes, with dedup (exact-text) and a cap (keep newest 40).
- New tool `remember` (description: "Save a short fact, constraint, or decision that future
  turns and the other agent should know") available to BOTH leader personas and the worker in
  `makeToolSet`. Notes are one-liners; reject > 300 chars with a helpful error.

## D29-2: Inject shared memory into every agent context
Planner, reviewer, takeover, AND worker build messages gain a "Session notes (shared memory):"
section — newest-last, budget ~2500 chars (oldest dropped, "(older notes omitted)" marker).
System prompts get one line: honor these notes; use `remember` when you learn something durable
(user preference, project convention, environment constraint, unresolved issue).

## D29-3: Minimal auto-notes (system-authored)
Automatically add notes at two moments (keep it minimal to avoid noise):
- On plan approval: "Plan '<title>' constraints: <semicolon-joined constraints>" (only if any).
- On a revise verdict: "Review round <n> open issues: <joined issue fields>" — removed/not
  re-added once a later verdict approves.

## D29-4: Visibility + control
Sidebar panel "Session notes" (collapsible, like Goals): lists notes with author badge and a
delete X per note (deleting appends a "memory:remove" event; the store replays log to current
state). User can also add a note manually (input + Add) — author "user".

## Acceptance
tsc + `npm test` green (memory store: cap/dedup/remove/replay tests; toolset registration for
both roles; context-injection presence tests); commits `D29-<n>:`. Reviewer live scenario in a
scratch folder: turn 1 — user note "always use single quotes in JS here" added via the panel;
turn 2 — "create util.js with a hello function": the worker's produced file uses single quotes
AND the session log shows the note present in the worker's context. Notes panel shows leader/
worker-authored notes appearing during runs.

> SUPERSEDED by HANDOFF_GPT5_D30.md (user chose the Claude Code/opencode method). Do not implement.
