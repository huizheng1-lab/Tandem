# Handoff to GPT-5 — Round D23 (live activity visibility: who is working, on what, right now)

User request: a way to tell whether the task is being done, and by whom (worker or leader).
Today the phase chip shows BUILDING/REVIEWING, but during thinking-suppressed streams and long
tool calls the UI looks idle — indistinguishable from a hang (a real incident: D19's dev-server
hang was invisible for minutes).

## D23-1: Tool lifecycle events through the stack
The tool layer currently executes silently. Emit tool activity:
- In `makeToolSet` (src/tools/index.ts), wrap every tool's execute with an optional
  `onToolEvent?({ role, tool, target, phase: "start" | "end", ok?, ms? })` callback from the
  tool context (target = path for fs tools, command for bash, pattern for grep/glob).
- `createLiveAgents` threads role-appropriate callbacks; `TandemService` forwards them to the
  renderer over a new `evt:tool` IPC channel and appends them to the session log (type "tool").

## D23-2: Activity strip in the desktop UI
A persistent one-line strip between transcript and composer (visible only while running):
- `● WORKER — running: npm test (14s)` / `● LEADER — reading src/game.ts` /
  `● WORKER — thinking… (8s)` / `● LEADER — writing review…`
- Content priority: active tool call (from D23-1, with live elapsed seconds) > thinking
  indicator (existing onThinking deltas) > streaming text ("writing…") > phase fallback
  ("waiting for model…" with elapsed — this is the hang tell).
- Role-colored dot matching the transcript badge colors; elapsed timer ticks every second.
- If no event of any kind (no tokens, no tool, no thinking) arrives for > 60s, the strip turns
  amber: "no activity for 60s — the model call may be stalled (Stop to abort)".

## D23-3: Tool one-liners in the transcript
Per the original BUILD_PLAN §7: each tool call also appends a dim, compact transcript line
(`⚒ worker · bash: npm test · ok 3.2s`, `⚒ leader · read_file src/solitaire.ts`), collapsed
by default under a "show activity (N)" toggle per run so the transcript stays readable. Session
log already captures them via D23-1 for post-hoc debugging.

## D23-4: TUI parity (minimal)
The terminal UI prints the same one-liners inline (it already has SYSTEM dim styling); no strip
needed this round.

## Acceptance
tsc + `npm test` green (unit-test the tool wrapper emits start/end with timing and that errors
still propagate); commits `D23-<n>:`. Reviewer will CDP-drive a real run and assert: during
BUILDING the strip names the worker and the current command with a live timer; during REVIEWING
it names the leader; the transcript's activity toggle reveals tool lines; a deliberately slow
command flips the strip to the running-command display within 1s of tool start.
