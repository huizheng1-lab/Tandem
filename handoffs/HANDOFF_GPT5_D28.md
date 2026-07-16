# Handoff to GPT-5 — Round D28 (conversational memory within a session)

User report (correct, by design today): Tandem has no memory of what was said earlier in the
same session. Every `TandemService.run` starts a fresh orchestration whose planner input is only
the new prompt + standing goals. Follow-ups like "I see no cards" (after "build a solitaire
game") arrive contextless.

## D28-1: Thread session conversation history into the leader
- Build a compact history from the session log (the events already exist): for each prior turn,
  the user prompt (type "user") and the run's outcome summary (type "done", including error
  summaries), plus plain leader answers for question turns. Formatter in
  `src/session/history.ts`: chronological, each entry one short block, capped to the last 10
  turns AND a ~4000-char budget (drop oldest first; prepend "(earlier turns omitted)" when
  truncating). Unit tests: ordering, both caps, error-turn inclusion.
- Pass `history` through `AgentFns.plan` (and the plain-answer path) — planner message gains a
  "Conversation so far:" section ABOVE the current request, with a system-prompt line: treat the
  new request in the context of this conversation (e.g. pronouns and follow-ups refer to prior
  work).
- The reviewer persona does NOT need chat history (it has plan+report+diff). The worker gets it
  only via the plan as today.
- Both frontends: desktop service and TUI build history from their SessionStore; `/resume`d
  sessions naturally regain context from the log (this also finally makes resume conversational).

## D28-2: Make it visible
Session-start line (or /status) gains "context: N prior turns". When the history is truncated,
a dim SYSTEM note on run start: "including last 10 turns of context".

## Acceptance
tsc + `npm test` green; commits `D28-<n>:`. Reviewer will run a two-turn live scenario in a
scratch folder: turn 1 "create colors.txt listing three colors"; turn 2 "add one more to that
file" — turn 2 must reference/modify colors.txt without re-specifying it (the plan names the
file). History-builder unit tests must cover the caps.

> SUPERSEDED by HANDOFF_GPT5_D30.md (user chose the Claude Code/opencode method). Do not implement.
