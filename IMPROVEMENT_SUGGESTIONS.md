# Tandem Improvement Suggestions — v2 (2026-07-11, post-D96 refresh)

Refreshed by the Claude leader after the D91–D96 rounds landed. Focus areas per the user's
request: **token efficiency**, **user friendliness**, and **workflow efficiency/smartness**.
Grounded in real observed data from this project's own sessions, not hypotheticals.

## Progress since v1 (done — recorded so we don't re-suggest solved problems)

- Append-time session event caps + checkpoint losslessness (v1 §1.3/§4.2-partial → D91/D92)
- Verification-command matching resilience + rejection diagnostics (v1 §1.1-partial → D90)
- /compact + automatic compaction for CLI-backed leaders (earlier: D87)
- Bounded transcript memory/rendering, session-switch speed (D86/D88/D89)
- Day/night theme (D93); MiniMax-as-leader fully working (D94/D95/D96)

Still open from v1 and still worth doing: orchestrator-executed verification (§1.1),
retry-with-feedback (§1.2), subprocess inactivity timeout (§3.1), session GC (§4.1),
"load older messages" (§5), e2e test harness (§7), README/ARCHITECTURE docs (§8), dead code
cleanups (§9: `takeover.ts`, `codexSandboxFor`).

---

## A. Token efficiency (stated #1 priority)

**Anchor datum**: the real hyperframe-video session's final cost event shows the leader consumed
**12,159,004 input tokens** (vs. worker 8.5M) across one task arc. The leader — the expensive
role — is reading more than the cheap worker implements. That ratio is the target.

### A1. Put the review call on a diet (single biggest lever)
`src/agents/live.ts:723` — every review round sends the FULL BuildPlan JSON + FULL
CompletionReport JSON + FULL diff, unbounded, and these accumulate in the leader thread across
rounds. Three cheap, compounding changes:
- **Cap the diff** with per-file truncation + a "N more files, M lines" summary; the reviewer
  already has read-only tools to inspect anything it needs more of (lazy inspection is how
  Claude Code itself works).
- **Round 2+ sends deltas**: plan by reference (title + task IDs only — it hasn't changed),
  report delta vs. last round, diff-since-last-review. Round 1 keeps the full context.
- **Drop verbatim JSON for prose-irrelevant fields**: `verificationResults[].output` can be
  huge; cap per-entry output in the review prompt (full text stays in the session log).

### A2. Risk-based review policy (skip the call entirely when it buys nothing)
Today every round pays a full leader review even when verification all passed and the diff is
tiny — my three live test runs today each spent a leader review call on trivially-correct work.
Add a config knob `reviewPolicy: "always" | "smart" | "final-only"` (default `always`, zero
behavior change). `"smart"`: auto-approve without a leader call when ALL of (a) round 1, (b)
every verification command passed, (c) diff under a size threshold, (d) no deviationsFromPlan;
anything else gets a real review. For a minimax-both-roles user this saves ~1/3 of leader calls
on small tasks; with an expensive leader it's the difference between $0.15 and $0.45 per small
task. The orchestrator-run-verification change (B1) makes this dramatically safer since "passed"
would then be ground truth, not model claim — do B1 first or together.

### A3. CLI-engine fixed-cost reductions (research spike, then implement)
- **Codex session reuse**: every leader call runs `codex exec --ephemeral` — full cold start,
  zero context reuse. Codex CLI has a `resume` subcommand (seen in its own --help during D84).
  Spike: can a takeover/review continue a session where the system+plan context is already
  established? Verify with real token counts, D66-68 style.
- **claude-code/cli**: `--json-schema` and `--system-prompt` still travel via argv;
  `--system-prompt-file` was live-verified to exist during D84. Beyond the ENAMETOOLONG
  robustness angle (GPT-5.6's D93-candidate), a file-based system prompt is also a prerequisite
  for any future prompt-caching experiments with stable byte-identical prefixes.

### A4. Leader-thread hygiene between turns
`compactLeaderThread` fires when the thread exceeds `leaderContextBudgetTokens` (60k default) —
but until that cliff, every artifact (full ReviewVerdicts, full submitted plans) sits verbatim
in the thread. Cheaper steady state: store artifacts in the thread as one-line summaries with
IDs ("Submitted ReviewVerdict r1: revise, 3 issues") the moment the NEXT turn begins — the full
JSON is already in the session log and the model rarely needs last turn's full artifact
verbatim. This lowers the average context size rather than waiting for the 60k emergency.

## B. Workflow efficiency & smartness

### B1. Orchestrator-executed verification (v1 §1.1 — now with two more scars)
Still the highest-value architectural change, and the evidence keeps accumulating: D90 (echo
string-matching too strict → 4 wasted attempts) and D96 (tampering check false positive → 6
wasted attempts) are BOTH symptoms of validating model *claims about* verification instead of
verification itself. If the orchestrator runs `plan.verification` directly after each
build/takeover and records real exit codes: echo-matching disappears, the tampering check
becomes redundant (a tampered script still has to actually pass when Tandem runs it), reviews
get ground truth, and A2's smart-skip becomes safe. One round, touches
`machine.ts`/`artifacts.ts`, removes two whole bug classes.

### B2. Retry-with-feedback (v1 §1.2 — D96 demonstrated the cost again)
`retryArtifact` still retries blind: in the D96 incident the worker was rejected 3x and the
takeover leader 3x with the SAME validation error, and none of the 6 attempts were told what to
fix. Thread the rejection reason into the retry (and same for `runTakeover`'s inline loop).
Small plumbing; converts guaranteed-identical failures into targeted correction. Pairs
naturally with B1.

### B3. Complexity-adaptive pipeline (make triage smarter than binary)
Today triage answers "question vs implementation" only; every implementation — even "reformat
this JSON" (105s, 3 model calls in today's live test) — gets the full plan→build→review
ceremony. Extend the triage schema with a size estimate (`trivial | standard | large`):
- **trivial**: single-task plan template, `maxParallelWorkers` forced 1, terse plan prompt
  (skip stream partitioning guidance etc.), A2 smart-review eligible.
- **standard**: today's behavior.
- **large**: today's behavior + nudge toward multi-stream partitioning.
The classification already happens in a call we pay for anyway (D94's now-robust triage) —
adding one enum field costs ~nothing; the downstream savings are a call or two per small task
plus much lower latency on exactly the tasks where overhead dominates.

### B4. Worker nudge-before-restart (v1 §3.2)
"Worker finished without submit_completion_report" still costs a full worker re-run. For the
AI-SDK worker the conversation exists — send one follow-up turn ("call
submit_completion_report now with your report") before restarting from scratch. D95 fixed the
takeover flavor of this with a step floor; the worker flavor remains.

### B5. Subprocess inactivity timeout (v1 §3.1, unchanged)
A wedged CLI subprocess still hangs a run forever; the 180s stall banner is UI-only. Exec-level
inactivity timeout (no stdout/JSONL for N min → kill + retryable failure), generous default.

## C. User friendliness

### C1. Actionable errors ("what should I do?" in the message itself)
D94's pre-fix error was a dead end: "could not parse the response" — nothing telling the user
that `triage: "always-plan"` would work around it, or that the model/provider combination was
the issue. Adopt a convention: terminal error events carry a `hint` field (shown in the UI as
"Try: …") for the known failure families — missing API key (already good), rate limit (already
shows reset time), structured-output incompatibility ("this model may not support strict JSON
mode; try a different leader or triage=always-plan"), CLI not found, budget cap hit.

### C2. Run progress that reads like a story, not a log
The transcript shows everything but summarizes nothing. A compact phase timeline strip
(Plan ✓ 40s → Build ● running 2m10s → Review ○ → Done ○, round 2/3) above the transcript,
with the stall warning gaining Stop/keep-waiting buttons (v1 §5). Users shouldn't have to
scroll to know where a run is and whether it's stuck.

### C3. Cost visibility per phase + budget guardrail
Header shows one total today. Per-phase breakdown (plan $x / build $y / review $z, per round)
on the cost tooltip, plus an optional `maxRunBudgetUsd` that warns (not kills) at threshold —
GPT-5.6's D96-candidate and my v1 §5 agree here. With A1/A2 this also gives the user visible
proof the token diet is working.

### C4. First-run and model-pairing guidance
The model dropdowns list everything installed but say nothing about what works well. Two cheap
additions: (a) mark recommended pairings in the picker ("minimax-m3 — tested as leader+worker;
cheapest"), sourced from a static table the project maintains; (b) on first launch (no config),
a 3-question setup: which keys do you have → suggest a pairing → write config. Most of the
D94-96 arc happened because trying a new leader was a leap into the unknown; the app can encode
what's known to work.

### C5. Session housekeeping (v1 §4.1/§5, unchanged but rising in priority)
46+ project-hash dirs and growing; sessions never expire; no cross-session search; no size
display. A "Projects" management view (per-project session count/size, bulk delete/archive) +
a retention default would keep long-term users from drowning. The "load older messages" button
(D86 left the banner without the affordance) belongs in this batch too.

### C6. Docs debt (v1 §8, unchanged)
README predates the desktop app, /compact, themes, parallel workers, session management.
One ARCHITECTURE.md page + a config-reference table would make every future round (human or
AI) cheaper. Low glamour, high leverage.

---

## Suggested sequencing

1. **B1 + B2 together** (orchestrator-run verification + retry-with-feedback) — one
   orchestrator-focused round; removes the two bug classes that have cost the most real
   attempts, and unlocks A2 safely.
2. **A1 + A2** (review diet + smart review policy) — the direct token-efficiency round;
   measure before/after on a real task with the cost ledger.
3. **B3** (complexity-adaptive triage) — small schema change, big latency win for small tasks.
4. **C1 + C2 + C3 UI batch** (hints, phase timeline, cost breakdown) — one desktop round.
5. **A3 spike** (codex resume + claude system-prompt-file) — investigation handoff, D66-68
   style, before committing to implementation.
6. **C4/C5/C6** as a quality-of-life batch when the above settle.
