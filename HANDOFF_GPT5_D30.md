# Handoff to GPT-5 — Round D30 (session memory the Claude Code / opencode way)

SUPERSEDES HANDOFF_GPT5_D28.md and HANDOFF_GPT5_D29.md (do not implement those as written).
User decision: adopt the same method Claude Code and opencode use. That method has two parts:
(1) the main agent is ONE rolling conversation per session with compaction, and (2) durable
shared context lives in a project-root markdown file (CLAUDE.md / AGENTS.md) that the main
agent AND subagents receive. Tandem's mapping: leader = main thread; worker = subagent
(fresh per round + task brief + memory file — unchanged).

## D30-1: Leader becomes a persistent conversation thread per session
- Restructure the leader from per-phase fresh calls to a single continuing message history held
  by the session (in `TandemService` / TUI session state): user prompts, leader answers, plan
  submissions, review verdicts, and takeover summaries are all turns in ONE thread. Phase
  behavior is steered by injecting the phase persona instructions as the latest system/user
  framing, not by resetting context. Artifacts are still extracted via the existing `submit_*`
  tools and validated exactly as today; the orchestrator state machine is unchanged — only the
  leader's context assembly changes (AgentFns closures hold the thread).
- Worker tool results and streams do NOT enter the leader thread (cost isolation, as before):
  the leader sees the CompletionReport + diff as a compact user-turn, as today.
- Persistence: thread rebuilt from the session log on resume (events already suffice; add a
  compaction-summary event type).

## D30-2: Compaction
When the leader thread exceeds a budget (config `leaderContextBudgetTokens`, default ~60k
estimated chars/4), summarize all but the last 6 turns into one synthetic "conversation summary
so far" message (use the leader model, one cheap call), append a "memory:compaction" event, and
continue. A dim SYSTEM line notes "compacted N earlier turns."

## D30-3: TANDEM.md project memory file (shared leader + worker)
- On session start, read (first match wins): `TANDEM.md`, then `AGENTS.md`, then `CLAUDE.md`
  from the project root — inject the content into BOTH the leader system prompt and the worker
  build system prompt as "Project instructions." Cap at ~8000 chars with a truncation marker.
- `remember` tool for both agents: appends a one-line bullet under a "## Notes" section of
  TANDEM.md (create the file if absent; create the section if absent). This is the shared
  memory: durable, user-editable, visible to both agents next call. (Same spirit as Claude
  Code's memory-file appends.)
- The session-start SYSTEM line notes "project instructions: TANDEM.md (N chars)" when found.
- The self-protection guard must ALLOW writing TANDEM.md in the project folder (it is project
  content, not Tandem's installation) — verify no guard conflict.

## Acceptance
tsc + `npm test` green (thread-assembly unit tests with fake agents: multi-turn continuity,
compaction trigger + summary event, TANDEM.md injection into both roles, remember-tool append);
commits `D30-<n>:`. Reviewer live scenario: turn 1 "create colors.txt with three colors";
turn 2 "add one more to that file" must work without naming the file (thread continuity);
then a `remember`-written note must appear in TANDEM.md and be honored by the worker in a
following run.
