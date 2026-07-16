# Handoff D68 (reduce claude-code/cli's per-call token overhead)

Context: user asked why the leader burns tokens fast. Root cause diagnosed and confirmed via
code read: `src/agents/claude-code-cli/exec.ts` passes `--no-session-persistence` on EVERY
call (`buildClaudeExecArgv`), so every leader call in an orchestration run (plan, each review
round, takeover) is a cold fresh subprocess that resends the full system prompt (~1600 tokens
just from the accumulated leader-rule constants in `src/agents/leader.ts`, before platform
info/project instructions/schema/history) from scratch. This is a real, structural, engine-
specific cost driver (the AI-SDK leader path already has a persistent thread + compaction via
`leaderContextBudgetTokens`; claude-code/cli has no equivalent).

Ran `claude --help` directly against the real installed CLI (not guessed) and found three
flags relevant to this that Tandem currently does not use:
```
--session-id <uuid>       Use a specific session ID for the conversation (must be a valid UUID)
-r, --resume [value]      Resume a conversation by session ID
--max-budget-usd <amount> Maximum dollar amount to spend on API calls (only works with --print)
--exclude-dynamic-system-prompt-sections
                           Move per-machine sections (cwd, env info, memory paths, git status)
                           from the system prompt into the first user message. Improves
                           cross-user prompt-cache reuse. Only applies with the default system
                           prompt (ignored with --system-prompt).
```

## D68-1 (primary lever, needs live investigation before committing to it structurally)

Investigate reusing ONE Claude Code session across the leader's own successive calls WITHIN a
single orchestration run (plan -> review round 1 -> review round 2 -> ... -> takeover), instead
of a cold `--no-session-persistence` call every time:
- Generate a `--session-id <uuid>` once per orchestration run (machine.ts's `runOrchestration`
  scope, or wherever the run-level state already lives), pass it on the FIRST claude-code-cli
  call for that run, then use `--resume <that-uuid>` (dropping `--no-session-persistence`) on
  subsequent calls in the SAME run only.
- Hard constraint: session reuse must be scoped to ONE orchestration run and never bleed across
  separate user requests/turns (a resumed session carrying stale context into an unrelated
  future request would be a correctness bug, not just a cost issue — this is more important
  than the cost savings). If this can't be cleanly scoped (e.g. no natural per-run boundary to
  hook cleanup into, or sessions aren't reliably prunable), say so and stop rather than force it.
- Before wiring this into production code, do a REAL live A/B test (this project's standing
  discipline — no live-verified claim has held up on the first try in this codebase's history,
  don't skip it): make two real `claude -p` calls with an IDENTICAL long system prompt (reuse
  the actual `leaderPlannerPrompt`/`leaderReviewerPrompt` text, not a toy string) — first cold,
  second either cold again or via `--resume` — and compare the real reported `total_cost_usd`/
  `usage` fields. Confirm resume actually reduces cost/input tokens on the second call. Also
  confirm the resumed call's `structured_output` still validates cleanly against the NEW call's
  schema (not stale/contaminated by the first call's schema or answer) — this is the real risk,
  given the D41-D47 saga's history of claude-code-cli behaving unexpectedly with prompt
  structure. If the live test doesn't show a clear win or shows contamination risk, report that
  honestly and do not implement D68-1 — this one is genuinely allowed to come back "not worth
  it," unlike a normal bug-fix handoff.

## D68-2 (concrete, low-risk, mechanical — do this regardless of D68-1's outcome)

Add `--max-budget-usd` as a per-call safety cap on all claude-code-cli invocations
(`buildClaudeExecArgv` in exec.ts). Real incident motivating this: D66's live evidence showed a
single planning call cost $1.17 over 36 internal turns before hitting an unrelated failure —
there's currently no ceiling stopping a single call's internal agentic exploration from costing
much more than that if it goes sideways. Add a new config field (e.g.
`claudeMaxBudgetUsdPerCall`, sensible default like `2.00` — pick something a normal single call
should never legitimately need to exceed, flag your reasoning) threaded through the same config
path as `maxStepsPerAgentTurn`. Confirm via a real or carefully-isolated test that the flag is
actually passed and that a low budget (e.g. `0.01`) on a real call causes it to stop early with
a diagnosable error rather than hanging or crashing uncleanly.

## D68-3 (investigate only, do not build unless it's a clean fit)

`--exclude-dynamic-system-prompt-sections` explicitly claims to improve prompt-cache reuse, but
per its own help text it's "ignored with --system-prompt" — and Tandem always passes
`--system-prompt` (full replace, not `--append-system-prompt`) by deliberate past design (the
D43/D44 saga found bundling everything into one combined prompt caused Claude Code CLI to
misbehave, and system/user-channel separation was the fix — a *different* concern than this
flag addresses, but worth being aware the two areas are related). Investigate whether switching
to `--append-system-prompt` (appending Tandem's rules to Claude Code's own default system
prompt, rather than fully replacing it) would let this caching flag apply, and whether that
trade-off is acceptable (Tandem's leader would then also inherit Claude Code's own default
persona/behavior mixed with Tandem's rules — re-verify the D41-D47 findings still hold if this
changes). This is explicitly lower-confidence and lower-priority than D68-1/D68-2 — a feasibility
note in the completion report is an acceptable outcome if it doesn't look clean.

## Acceptance
tsc + `npm test` green for whatever ships. D68-2 must ship (mechanical, low risk, real
incident-backed). D68-1 ships ONLY if the live A/B test shows a genuine, safe win — paste the
real before/after `total_cost_usd`/usage numbers in the completion report either way, including
if you decide not to implement it. D68-3 is a report-only investigation unless it turns out to
be a clean, low-risk change. Commit `D68-<n>:`, create `D68_done.txt`.
