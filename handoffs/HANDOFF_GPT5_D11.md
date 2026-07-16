# Handoff to GPT-5 — Round D11 (goal referencing + composer slash commands)

Context: D10 APPROVED (all four tasks confirmed, including the sidebar affordances). New findings
from user testing.

## D11-1: Goals must be injected with their ids (user-visible numbering ≠ leader context)
Repro (screenshot-verified): user's sidebar shows "1. build a airplane dogfight game."; user
prompts "implement goal 1"; leader replies "Goal 1 is not defined." Cause: `TandemService.run`
passes `goals.map(goal => goal.text)` and `live.ts` joins bare texts, so the numbering the UI
displays never reaches the leader. Fix:
- Pass full goal objects (or preformatted strings) through to the planner: render each standing
  goal as `Goal <id>: <text>` (include recent progress notes if present, e.g. up to the last 2,
  indented) in the planning message — in BOTH the desktop service and the TUI/live-smoke paths
  (change the `AgentFns.plan` input shape or format before the call — keep one shared formatter
  in `src/agents/live.ts` or `src/session/goals.ts`).
- Add one line to the planner system prompt: users may reference standing goals by number
  ("goal 1"); resolve those references against the Standing goals list before asking for
  clarification.
- Unit test the formatter (goal with notes, goal without).

## D11-2: Composer slash commands in the desktop app
Users habitually type slash commands in the composer (e.g. `/goal add <text>`). Implement a thin
composer-side dispatcher: if the input starts with `/`, route to the equivalent existing IPC
action instead of `pipeline:run`:
- `/goal add <text>` | `/goal list` | `/goal done <n>` → goals IPC; results appear as a SYSTEM line
- `/model leader <id>` | `/model worker <id>` | `/models` → config/models IPC
- `/rounds <n>`, `/cost`, `/status` → config/cost/status equivalents (SYSTEM line output)
- Unknown `/command` → SYSTEM line "Unknown command — try /help" and `/help` lists what the
  composer supports. Do NOT send unknown slash input to the leader as a prompt.
Reuse parsing from `src/commands/` where practical rather than duplicating.

## D11-3: Session rename input (pending user retest)
User reported the rename input would not accept typing or save. Reviewer audited the renderer
(controlled input, handlers, IPC, CSS) and found no defect; suspicion is a stale pre-D10 window.
If the user confirms it still fails in a fresh instance, the reviewer will attach DevTools
console output — do not attempt a blind fix in this round unless that arrives.

## Acceptance
tsc + `npm test` green; commits `D11-<n>:`. Reviewer retest: "implement goal 1" produces a plan
for the dogfight game (or a clarifying question about scope, but not "goal not defined");
`/goal add x` in the composer adds a sidebar goal.
