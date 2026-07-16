# Handoff D100 (URGENT investigation: UI shows minimax leader, service runs Codex CLI leader)

User-reported, actively recurring in their real "Age of Empire test build" session
(`~/.tandem/sessions/c6202ddbf499/3edefa00-6402-4d07-aaac-5ae1f8ac89b2.jsonl`, 12 user turns
across ~11 hours). I initially misdiagnosed the user's screenshot as stale scrollback — full log
analysis proved that wrong. All line numbers below are real; read them with bounded reads
(6.8MB file).

## Hard facts from the session log (verified, don't re-derive)

1. **The UI showed `leader: minimax/minimax-m3` while the SERVICE ran CLI-backed leader paths.**
   Smoking gun: "compacted N earlier turns" notices at 14:10:06 (line 43657) and 15:33:22 (line
   49841). The desktop service's `compactCurrentSession` is gated on
   `isCliBackedLeader(this.config)` (`app/main/tandem-service.ts`, wired in `run()`) — it CANNOT
   fire for a minimax leader. So at those moments `this.config.leader` in the SERVICE's memory
   resolved as codex-cli — while the user's screenshot (taken during exactly this window) shows
   the Leader dropdown = minimax/minimax-m3, and BOTH persisted configs (project
   `C:\Users\huizh\tmp_test_data\Age of Empire test build\.tandem\config.json` and global
   `~/.tandem/config.json`) say minimax/minimax-m3 today. Turn-by-turn engine timeline: turn 1
   (04:23) failed 3x "Claude Code CLI run aborted"; turn 7 (14:10) failed 3x "Codex CLI run
   aborted" (real retryArtifact error events, lines 43663-43701); turns 8-10 (14:18-15:19) ran
   fine on minimax (real streamed answers, minutes-long, correct content); turns 11-12
   (15:26/15:33) show the anomaly below. The engine FLIP-FLOPPED within one app run.

2. **Turns 11 and 12 are NOT retryArtifact failures — they're the leader PARROTING an old error
   as its "answer".** Exact event sequence (lines 49817-49849): user prompt → PLANNING →
   triage notice → `artifact BuildPlanOrAnswer` emitted → transition `DONE leader answered
   without build plan` → done event whose summary is VERBATIM
   `"Leader planning could not produce a valid result after retries: Error: Codex CLI run
   aborted."` — with ZERO "failed on attempt N" error events for these turns (the error-event
   list for the whole session ends at 14:12:47). So the plan call SUCCEEDED and returned
   `{kind:"question", answer:"<turn 7's old error text>"}`. Why would the model answer that?
   `rebuildLeaderThread` (`src/session/leader-thread.ts`) pushes every done-event summary into
   the rebuilt thread as an assistant message — turn 7's error summary is sitting in the leader's
   own conversation history as something "it said", and the user's repeated "retry"-style
   prompts led it to repeat it. Also note the timing: these "answers" took 2.6-8s vs. 4+ MINUTES
   for the genuine inspection answers in turns 8-10 — no real work happened.

3. **The persisted compaction summary at 15:33:22 (line 49840) is garbage**: it begins with turn
   8's verbatim answer text and contains raw MiniMax interleave/tool-call markup
   (`]<]minimax[>[<tool_call>{"name": "Bash"...`). The summarizer echoed raw conversation
   content (including provider-specific control tokens that should never appear in stored text)
   instead of summarizing. This garbage summary is now permanently in the session and feeds
   future context.

4. Turn 7's ORIGINAL "Codex CLI run aborted" errors were real retryArtifact failures (3
   attempts over 2.5 min). That message only throws from the `abortSignal?.aborted` check
   (`src/agents/codex-cli/exec.ts:177`) — meaning the abort signal was aborted during/before
   those codex calls. (Same for turn 1's claude-code variant at 04:27.)

## What to investigate/fix (in priority order)

D100-1 (the core bug): find how the renderer's displayed leader and the service's
`this.config.leader` diverge. Prime suspect: the renderer shows `effectiveConfig =
session?.config ?? config` (`app/renderer/src/main.tsx` ~line 292) — the SESSION-scoped config
snapshot — while the service uses live `this.config`. Trace every path that mutates either side
(`setConfig` patches, `resumeSession`'s disk reload, `startSession`, the D93
`updateDesktopTheme`-style patches that call setConfig and re-set session config, model dropdown
handlers) and find the ordering that leaves the service on codex/cli while the renderer shows
minimax (or vice versa — the divergence itself is the bug). Add a regression test reproducing
the exact divergence once found. Also confirm `resolveModel`/`withConfiguredCliModel` cannot
possibly map `minimax/minimax-m3` to a CLI provider (a 2-line sanity check to rule it out).

D100-2: stop the error-parroting channel. `rebuildLeaderThread` should not replay FAILURE
summaries as assistant messages the model believes it authored — filter out done events whose
payload has `error: true` (or whose summary matches the known terminal-failure shapes), or tag
them as system-style context instead of assistant content. This also protects every future
failure from polluting later turns.

D100-3: the compaction summarizer must never persist raw provider control tokens. Sanitize
`<tool_call>`-style and interleave markup out of summarizer output before persisting
`memory:compaction` (extend the existing sanitize layer rather than inventing a new one), and
consider a minimal sanity check (e.g., reject/redo a "summary" that is >X% verbatim overlap with
the source's first lines — use judgment, keep it cheap; even just the token sanitization is a
real improvement).

D100-4 (only if D100-1's investigation makes the cause obvious in passing): why the abort
signal was aborted during turn 7 / turn 1's CLI leader calls. Do not force this if it doesn't
fall out naturally — it may simply be the user clicking Stop, which is legitimate; the message
is then correct behavior (though "run aborted" phrasing could mention it was user-initiated).

## Acceptance

tsc + `npm test` green (isolated HOME if an app instance is running). D100-1: root cause written
up in the completion report with the exact divergence sequence + a regression test + the fix;
live-verify by reproducing the user's flow (start session with CLI leader, switch to minimax via
the dropdown mid-session, resume, run — confirm the service NEVER runs a CLI-engine leader call
while the UI shows minimax, and that `compacted N turns` never fires for a minimax leader).
D100-2: regression test that a failed turn's error summary does NOT appear as assistant content
in the rebuilt thread. D100-3: regression test that summarizer output containing `<tool_call>`
or interleave tokens is sanitized before persistence. Commit `D100-<n>:`, create
`handoffs/D100_done.txt`.
