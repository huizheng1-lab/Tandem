# Handoff D90 (URGENT: video task appears stuck — verification-command mismatch loop)

User report: "check why this task seems never ends," paired with a pasted error:
`TakeoverReport failed on attempt 2: Error: Completion report omitted verification commands: ...`
(a huge PowerShell one-liner). Investigated live against the actual running session
(`d2df843a-2c19-47e6-8443-6e5229117a3b`, project `tandem_hyperframe_video`) while it was still
active.

## What's confirmed (don't re-derive)

**This is NOT a literal infinite loop.** `runTakeover()` in `src/orchestrator/machine.ts` (~line
356-382) bounds retries to exactly 3 attempts per takeover call; if all 3 fail validation, it
falls back to a schema-only-validated report and terminates the run with a degraded-but-preserved
summary. At the time I investigated, the session had already hit worker attempt 3 and takeover
attempts 1-2, all failing on the SAME verification command, and was actively working on takeover
attempt 3 (confirmed via real, live tool-call activity in the session log — headless Edge browser
screenshots extracting frames from the rendered MP4s for visual verification, genuinely
substantive work, not stalled). **It will terminate within a few more minutes regardless of
whether this bug is fixed**, most likely with a degraded/preserved-build summary rather than a
clean pass. Tell the user this directly if they ask again before D90 lands — the run isn't
technically hung, it's just unable to reach a clean "verification confirmed" state.

**The full failure sequence, extracted from the real session log:**
1. Worker attempt 1-2: `"Worker finished without submit_completion_report."` (didn't even call the
   report tool — separate, likely-unrelated symptom, possibly the task's sheer complexity/step
   count).
2. Worker attempt 3, then takeover attempts 1-2: all four hit the identical
   `"Completion report omitted verification commands: <cmd>"` error, where `<cmd>` is always the
   SAME plan verification entry — a **1658-character** single-line PowerShell command (a `$files =
   @(...)` array of 14 absolute file paths + a `foreach` existence/size check, all inlined into one
   `-Command` argument with heavy quote/backslash escaping).

**Important limitation in the evidence, be honest about this**: `enforceVerification()` in
`src/orchestrator/artifacts.ts` (~line 379-388) builds its error message from
`missing.join(", ")`, where `missing` is filtered from `expectedCommands` — **the PLAN's own
command text, not whatever the model actually reported**. This means the error message alone
cannot distinguish between two different real possibilities:
(a) the model DID attempt this verification and reported a `command` string that's even slightly
    different from the plan's exact text (whitespace beyond what `normalizeCommand()` collapses,
    quote-style differences, reordering) — `matchResult()` (~line 326-332) requires an EXACT
    string match after only whitespace-collapsing, no other normalization; or
(b) the model never attempted/reported this specific command at all (plausible given how long and
    fragile it is to reproduce, and given the worker's own earlier failures suggest this task is
    already pushing complexity/step limits).
Neither is confirmed from the log alone, because a REJECTED report's actual `verificationResults`
are never persisted anywhere (`enforceVerification` throws before the artifact event is emitted).

## What to do

D90-1 (diagnose first, don't guess-fix blind): add temporary or permanent logging/telemetry that
captures the REJECTED report's actual `verificationResults` (or at least the specific command
strings it DID report) before `enforceVerification` throws, so the real mechanism — (a) vs (b)
above — can be confirmed with real data rather than assumed. This doesn't need to be fancy; even a
debug-level log line or an additional field on the thrown error's context is enough. Reproduce
live using this exact plan/report shape (the real BuildPlan is in the session log,
`d2df843a-2c19-47e6-8443-6e5229117a3b.jsonl`, machine artifact named "BuildPlan") if practical,
rather than only reasoning from a synthetic case.

D90-2 (the actual robustness fix, informed by D90-1's finding): make verification-command
correlation resilient to formatting differences a model might introduce when reproducing a long,
complex command string, OR eliminate the need for exact reproduction entirely. Two reasonable
directions, pick based on what D90-1 reveals:
- If it's (a) (string mismatch on a genuinely-attempted command): normalize more than just
  whitespace before comparing (e.g., normalize quote characters, or match by a content hash that's
  insensitive to superficial formatting) — OR better, stop relying on string identity at all:
  correlate `verificationResults[i]` to `plan.verification[i]` by INDEX/POSITION instead, since the
  model is always expected to run them in the same order. This sidesteps the entire reproduction-
  fidelity problem.
- If it's (b) (never attempted): the model needs either an easier way to reference this
  verification step (see D90-3) or explicit reinforcement in the prompt that every plan.verification
  entry must get a corresponding result, no exceptions, even long/ugly ones.

D90-3 (plan-generation guardrail, likely worth doing regardless of D90-1's finding): the current
leader planning prompt (`src/agents/live.ts` ~line 497, and the equivalent lines in
`src/agents/codex-cli/leader.ts` / `src/agents/claude-code-cli/leader.ts`) says verification
entries "must contain exact runnable shell commands only... one command per entry" but gives NO
guidance discouraging a single command from being this unwieldy. A 1658-character inline
PowerShell one-liner with 14 embedded file paths and nested escaping is inherently fragile for a
model to reproduce byte-for-byte in a structured JSON report field, regardless of any matching-
logic fix. Add guidance steering the planner toward writing a small verification SCRIPT FILE (e.g.
`verify-frames.ps1` or `.mjs`) for anything this complex, with the plan's verification entry being
a short `powershell -File verify-frames.ps1` (or `node verify-frames.mjs`) instead — much easier
for any engine to reproduce exactly, and easier to read/review as a human too. Don't over-scope
this into a hard length limit or a big rewrite of the planning prompt; a short added sentence of
guidance is likely enough.

## Acceptance

tsc + `npm test` green. A regression test reproducing the ACTUAL confirmed mechanism from D90-1
(not a guessed one) — e.g., if it's index-based correlation, a test with a reported command that's
formatted differently but semantically the same, asserting it's no longer flagged as omitted. Live
verification: don't just unit-test the matching logic in isolation — if practical, replay the real
BuildPlan from this incident's session log against the fixed validation logic with a realistic
report shape and confirm it now validates cleanly. Since this session will likely have already
completed (degraded) by the time this is picked up, use the real historical plan/report data from
the log rather than needing a fresh live run. Commit `D90-<n>:`, create `D90_done.txt` in
`handoffs/`.
