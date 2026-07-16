# Handoff D95 (two findings: minimax leader-takeover crash + a thinking-tag leak)

Follow-up to D94 (fixed the minimax-as-leader triage crash — confirmed working, closed). This
covers the one known remaining gap D94 explicitly scoped out, plus a smaller, separate finding
noticed while investigating it.

## D95-1: leader takeover fails with all-MiniMax ("Leader takeover finished without submit_takeover")

Observed by Codex during D94's own verification (a real all-MiniMax orchestration got past the
fixed triage step, then later hit this in the takeover path — different call site, unrelated to
D94's fix). Confirmed real by tracing the code: `src/agents/live.ts`'s `takeover` implementation
(~line 795-847) runs the leader in a multi-step tool-use loop (`runAgentArtifact` with
`stopToolName: "submit_takeover"`), and if the model finishes its turn without ever calling that
tool, it falls back to `extractFromProse()` with
`originalError: new Error("Leader takeover finished without submit_takeover.")`. Per
`extractFromProse`'s own logic (~line 369: `if (!options.text.trim()) throw options.originalError;`),
this specific error text is what surfaces when the model ALSO produced no usable final text —
i.e., the model's turn ended with neither a tool call nor meaningful prose to recover from.

**I tried to reproduce this directly** (calling `createLiveAgents({...}).takeover(...)` with
leader=worker=minimax/minimax-m3 and a small synthetic one-file BuildPlan/report/feedback,
bypassing the cost of a full multi-round orchestration) and it **succeeded cleanly** — real bash
tool calls, a correctly created file, real verification, and a properly-called `submit_takeover`
with a well-formed report. This rules out "takeover is always broken for MiniMax" — the failure
Codex saw is more likely tied to task complexity, tool-call count, or step-budget pressure in a
real multi-round scenario (takeover only fires after existing review rounds have already failed,
so by definition it's used on harder, more-argued-about tasks than my simple repro), or is
genuinely intermittent.

### What to do

D95-1a: reproduce with a REALISTIC repro shape, not a toy one — either replay real
plan/reports/feedback from an actual multi-round session that reached takeover (check recent
session logs under `~/.tandem/sessions/` for one, or construct a synthetic case with several
reports/feedback rounds and a plan with multiple tasks/files, closer to what a real takeover
scenario looks like), and/or push `maxStepsPerAgentTurn` down to increase the chance of hitting a
step-budget cutoff before the model gets to calling the tool.

D95-1b: if reproduced, capture what the model's `result.text` and finish reason actually were at
the point of failure (add temporary logging if needed) before deciding on a fix — don't guess.
Likely directions depending on what's found: (a) if it's step-budget exhaustion, the takeover
call may need more steps or the FIRST call in a takeover round could reserve a heads-up nudge
telling the model when it's running low on steps to must wrap up and call submit_takeover soon;
(b) if it's model behavior (finishes turn with a short "done" prose but no meaningful recoverable
content), consider whether the fallback text-generation retry inside `extractFromProse` (its
`textGenerator` branch, ~line 379+) needs a more explicit final nudge for this case.

If D95-1a can't reproduce it after a real attempt, that's a legitimate outcome — report the
negative result plainly rather than guessing at a fix for something not confirmed reproducible,
same discipline as D90.

## D95-2 (smaller, secondary): thinking-tag leak observed during the D95-1 repro attempt

While reproducing D95-1's takeover call directly, the leader's `onLeaderText` callback received a
stray `</think>` fragment as visible text (captured verbatim: one text chunk was literally
`"</think>"` with nothing else). `src/agents/runner.ts`'s `ThinkingStreamFilter` (~line 170-256)
exists specifically to strip `<think>...</think>` blocks from the visible text stream and route
them to `onThinking` instead — this leak suggests an edge case in its buffering/boundary logic
isn't fully covered (worth checking: what happens when the closing tag arrives in a chunk that
doesn't align cleanly with how `suffixPrefixLength`'s partial-tag-matching handles it, or whether
there's a state-tracking gap between chunks). This is cosmetic (a stray `</think>` in the
transcript, not a crash) and independent of D95-1 — don't let it block or complicate that fix.
Only fix if a real reproducible case is found; if it turns out to be a one-off from this specific
repro's exact chunk timing, note that honestly rather than inventing a fix for something not
confirmed.

## Acceptance

For D95-1: if reproduced and fixed, a regression test using the real/realistic shape that
triggered it, tsc + `npm test` green, live re-verification through the real minimax leader
confirming the specific scenario that used to fail now completes with a valid TakeoverReport. For
D95-2: only if independently reproduced — a test capturing the exact chunk-split pattern that
leaks the tag. Either or both findings may turn out to be non-reproducible on a fresh attempt;
report that honestly rather than shipping a speculative fix. Commit `D95-<n>:`, create
`handoffs/D95_done.txt` describing what was actually found (reproduced-and-fixed, or
investigated-and-not-reproducible, for each of D95-1/D95-2).
