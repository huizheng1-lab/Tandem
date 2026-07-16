# Handoff D87 (feature: /compact command + automatic compaction for CLI-backed leaders)

User request, verbatim: "need a /compact function and need automatics compacting like claude code
does." This is a real, large feature request, not a bug — but it's not starting from scratch:
investigation below found that automatic compaction ALREADY EXISTS and is genuinely well-built,
just scoped to only one of Tandem's three leader engine types. The user's actual leader today is
`codex/cli` (confirmed live from a recent session dump), which is exactly the engine type this
already-working mechanism does NOT cover — that gap is almost certainly what the user is feeling.

## What already exists (confirmed by reading the real code, don't re-derive or rebuild this)

**Automatic compaction for direct-API leaders (Anthropic/Google/OpenAI via the AI SDK) is real,
already wired end-to-end, and matches Claude Code's actual behavior:**
- `src/agents/live.ts`'s `createLiveAgents()` builds a `compactLeaderThread(system)` closure
  (~line 373-391) that: checks if the current `leaderThread`'s estimated size exceeds
  `config.leaderContextBudgetTokens * 4` chars (default 60000 tokens) AND has more than 12
  messages; if so, keeps the last 12 messages verbatim, sends everything older to the leader model
  itself with a dedicated summarization system prompt ("Summarize the prior Tandem leader
  conversation... Preserve user requests, files or artifacts named, decisions, unresolved issues,
  and accepted plans/reviews"), and replaces the older messages with a single
  `"Conversation summary so far:\n<summary>"` assistant message.
- This closure is called automatically before every plan/review/takeover leader call (4 call
  sites, ~lines 459/498/658/746) — genuinely automatic, not something the user has to trigger.
- The result is persisted: `options.onLeaderCompaction?.({summary, compactedTurns})` fires, and
  BOTH the CLI TUI (`src/tui/App.tsx:256-257`, `storeRef.current?.append("memory:compaction",
  event)`) and the desktop app (`app/main/tandem-service.ts:213/476`,
  `this.session?.append("memory:compaction", event)`) already wire this to append a
  `memory:compaction` session event to disk.
- On resume, `src/session/leader-thread.ts`'s `rebuildLeaderThread(events)` already knows how to
  replay a `memory:compaction` event correctly (~line 31-37): it collapses everything before that
  event into the persisted summary, so the compaction survives a session resume too. This is a
  complete, correct round-trip already.

**The gap: none of this applies to the CLI-backed leader engines (`codex/cli`, `claude-code/cli`)
— which is what the user is actually running.** These engines don't maintain a persistent
`leaderThread` at all; each call is a stateless subprocess invocation (`--no-session-persistence`
for Claude Code CLI; `--ephemeral` for Codex CLI). Continuity across separate user turns instead
comes from `src/session/history.ts`'s `buildConversationHistory()`, which caps to the last 10
turns / 4000 chars and, critically, does NOT summarize — it just drops older turns outright with
an `"(earlier turns omitted)"` marker (~line 79-89). This is real, silent, lossy truncation, not
compaction, and it's a plain string passed once into the leader prompt
(`src/agents/codex-cli/leader.ts` ~line 96, `src/agents/claude-code-cli/leader.ts` similarly) —
there's no equivalent "budget check + LLM-summarize + persist" step anywhere in the CLI-backed
path.

**Also confirmed: there is no `/compact` slash command anywhere.** `src/commands/misc.ts`'s help
text lists only `/goal`, `/loop`, `/schedule`, `/sessions`, `/resume`, `/clear` — no compact
command in either the CLI TUI or the desktop composer's command dispatch (grepped both).

## What to do

D87-1 (primary — closes the actual gap): give the CLI-backed leader engines (`codex/cli`,
`claude-code/cli`) an equivalent automatic-compaction mechanism to what direct-API leaders already
have. Concretely: `buildConversationHistory()`'s truncation-only behavior needs a summarizing path
— when the accumulated history would exceed its budget (reuse `leaderContextBudgetTokens`, don't
invent a new config knob), run a lightweight summarization call (this can use the SAME CLI-backed
leader engine the user has configured, via its existing exec wrapper — `runCodexExec`/
`runClaudeExec` — with a minimal prompt asking for a synopsis, mirroring the direct-API path's
system prompt) over the turns that would otherwise be silently dropped, and persist the result via
the SAME `memory:compaction` event type already wired end-to-end (`onLeaderCompaction`,
`rebuildLeaderThread`) so resume behavior is consistent across ALL leader engine types without
touching that plumbing. `buildConversationHistory()` (or a CLI-specific caller of it) should then
prefer a persisted compaction summary over raw omitted turns, the same way `rebuildLeaderThread`
already does for the direct-API path. Reuse the existing summarization prompt style from
`compactLeaderThread` (~`src/agents/live.ts:383`) rather than inventing new wording.

D87-2 (the actual "/compact" command, both interfaces): add a `/compact` slash command that lets
the user manually trigger compaction on demand (matching Claude Code's own `/compact`), regardless
of whether the automatic budget threshold has been hit yet. Wire it into:
- The desktop composer's command dispatch (`app/renderer/src/main.tsx`'s `handleComposerCommand`,
  same pattern as the existing `/goal`/`/loop`/`/schedule` handling ~lines 850-940).
- The CLI TUI's command handling (`src/tui/App.tsx` and/or wherever its command dispatch lives —
  find the equivalent of `/sessions`/`/resume`/`/clear` handling and follow that pattern).
Should work uniformly regardless of leader engine — for direct-API leaders this can directly
invoke the existing `compactLeaderThread` logic (may need exposing that closure or an equivalent
entry point rather than only firing implicitly before leader calls); for CLI-backed leaders it
should trigger D87-1's new summarization path. Update `src/commands/misc.ts`'s help text to
document it.

D87-3 (small, do only if trivial while in this area): the existing `compactLeaderThread`'s
threshold check (`leaderThread.length <= 12`) means very short-but-token-heavy threads (e.g. one
giant pasted attachment) never compact even past the char budget, since the message-count gate is
an AND with the size check. Worth double-checking this doesn't also need loosening for the
CLI-backed history path being added in D87-1 — don't block D87-1 on solving this if it needs more
design, just note it as a followup.

## Acceptance

tsc + `npm test` green. A regression test proving CLI-backed leader history compaction actually
triggers and persists a `memory:compaction` event once a synthetic conversation exceeds the token
budget (mirror the existing tests around `compactLeaderThread`/`rebuildLeaderThread` if any exist
— check `tests/` for coverage of the direct-API path first and follow that pattern). Live
verification: manually run `/compact` in both the desktop UI and CLI TUI on a real (or realistic
synthetic) session with a codex/cli or claude-code/cli leader, confirm a `memory:compaction` event
lands in the session log and that resuming the session afterward reflects the compacted summary
rather than replaying/dropping the original turns. Also confirm automatic compaction fires on its
own once the CLI-backed history genuinely exceeds budget, not just on manual `/compact`. Commit
`D87-<n>:`, create `D87_done.txt` in `handoffs/`.
