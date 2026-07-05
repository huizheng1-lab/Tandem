# Leader Review — Round 2 Verdict: APPROVE (conditional on live smoke test)

Reviewer: Claude Fable 5. Re-reviewed commit `f7f5816` against the Round 1 findings below and
BUILD_PLAN.md §12. Scores: correctness 4/5 · plan adherence 4/5 · code quality 4/5.

## Round 1 findings — resolution status (all independently verified)

- **F1 wired end-to-end: FIXED.** `src/agents/live.ts` implements all four AgentFns against live
  models with role-filtered toolsets and phase-specific `submit_*` tools; `App.tsx` routes any
  non-command input through `runOrchestration`.
- **F2 runner tool loop: FIXED.** Multi-step with `stopWhen: [stepCountIs, hasToolCall(submit_*)]`,
  proper `LanguageModel`/`ToolSet` types, 429/5xx retry with backoff, usage → cost ledger.
- **F3 Esc interrupt: FIXED.** Real AbortController flows into `streamText`.
- **F4 /loop + /schedule: FIXED.** Sequential loop with overlap-skip; node-cron registration with
  persistence and startup load. Missed-run handling is a startup notice rather than an interactive
  catch-up — accepted, matches the report's disclosed deviation.
- **F5 cost accounting: FIXED.** `onFinish` usage → `ledger.add(role, ...)`; status line + /cost.
- **F6 sessions: MOSTLY FIXED.** Store created at launch, all events appended, `/resume` restores
  the transcript. Mid-phase machine-state resume (kill during BUILDING → resume lands in phase) is
  NOT implemented — see follow-ups.
- **F7 plan confirm / diff / cards: FIXED.** `confirmPlan` hook with clean rejection path; git diff
  + untracked provider; PlanView/Approval wired.
- **F8 round semantics: FIXED** exactly as specified, with tests asserting exact build counts and
  zero builds at `maxReviewRounds: 0`.
- **F9 honesty: IMPROVED.** M4 marked partial; the skipped live demo is disclosed. (M5 "done" is
  still slightly generous given the resume gap.)

## Remaining follow-ups (non-blocking, fix in a maintenance pass)

1. Mid-phase crash resume: persist machine phase + artifacts so `/resume` can restart the
   interrupted phase (plan §9, M5 acceptance). Currently transcript-only.
2. Non-git projects get a "diff unavailable" note instead of the before-snapshot diff (§5.3).
3. Goal progress notes: after DONE, the leader should append a one-line note to advanced goals (§8).
4. Esc while a permission/plan prompt is pending leaves that promise unresolved.

## Condition for final acceptance

The live M3 demo (plan §10-M3) has not been executed by anyone — no `.env` exists in the project.
Once real keys are present, run the README demo and confirm: plan card → worker rounds → review
verdict → summary, non-zero `/cost`. Structural review passes; this is the only open gate.

---

# Leader Review — Round 1 Verdict: REVISE

Reviewer: Claude Fable 5 (plan author). Reviewed against BUILD_PLAN.md sections 5–12.
Scores: correctness 2/5 · plan adherence 2/5 · code quality 4/5.

## What passed (independently verified, not taken from the report)

- `npx tsc --noEmit` clean; `npm test` 11/11 green (reviewer re-ran both).
- `orchestrator/machine.ts` is a real, TUI-independent state machine; tests cover all six required
  scenarios (approve, 2×revise→approve, round exhaustion, early takeover, worker blocked,
  artifact-validation retry).
- Artifact schemas match spec; verification enforcement is correct and stricter than spec
  (rejects `complete` with failing verification). Good.
- Tool layer is real AI SDK `tool()` definitions with role filtering (leader read-only, reviewer
  bash restricted to plan verification commands), path confinement, destructive-command denylist,
  permission modes with a TUI bridge interface.
- Provider layer supports anthropic / openai / openai-compatible with baseURL (MiniMax-ready) and
  produces named-env-var errors.

## Why REVISE: the layers exist but are not connected — the product does not function

Typing a request into the TUI never calls any model. The core deliverable (user request → leader
plans → worker builds → leader reviews) cannot be demonstrated. The completion report marked
M1–M3 "done"; they are not. Fix the following, in order:

### F1 — Implement LLM-backed AgentFns and wire the TUI to the orchestrator  (BLOCKER)
- Location: `src/agents/leader.ts`, `src/agents/worker.ts`, `src/tui/App.tsx:39-42`
- Required: Create real `plan/build/review/takeover` functions that call `makeModel()` +
  `runAgentText` with the role-filtered toolsets and phase-specific `submit_*` tools, returning
  parsed artifacts. `App.tsx` must call `runOrchestration` with these agents for any non-command
  input, streaming LEADER/WORKER output and SYSTEM transition lines into the transcript. Remove
  the placeholder message.

### F2 — Rebuild the runner as a real tool loop  (BLOCKER)
- Location: `src/agents/runner.ts`
- Required per plan §6.1: execute tool calls across steps (AI SDK multi-step with `stopWhen:
  stepCountIs(maxSteps)`), terminate when a `submit_*` tool is called and return its payload,
  surface permission requests through the bridge, retry ×2 with backoff on 429/5xx, and report
  token usage per call (see F5). Type the model as `LanguageModel`, not `unknown`/`never` casts.

### F3 — Real Esc interrupt  (BLOCKER)
- Location: `src/tui/App.tsx:21-27`
- Required: an `AbortController` per agent turn; Esc calls `.abort()`, the runner passes the
  signal to `streamText`, and machine state remains resumable. Currently Esc only flips a
  spinner flag — nothing is interrupted.

### F4 — /loop and /schedule must actually run  (BLOCKER for M4)
- Location: `src/commands/loop.ts`, `src/commands/schedule.ts`
- Required: `/loop` re-runs the prompt through the full pipeline on the interval, sequential,
  no overlap, `/loop stop` cancels. `/schedule` registers node-cron jobs while the app runs,
  persists to `.tandem/schedules.json`, and prompts about missed runs at startup. Parsing alone
  does not meet M4 acceptance ("a /loop 1m prompt fires twice").

### F5 — Cost accounting must receive data
- Location: `src/session/cost.ts` (ledger is fine), `src/agents/runner.ts`
- Required: extract usage from each provider call, call `ledger.add(role, ...)`, show the running
  total in the status line. `/cost` currently always reports zeros.

### F6 — Integrate sessions; implement /resume
- Location: `src/session/store.ts` (store is fine), `src/tui/App.tsx`, `src/commands/index.ts:57`
- Required: create a SessionStore on launch, append every event (messages, tool calls, artifacts,
  transitions, cost ticks), and make `/resume <id>` rebuild transcript + machine phase. It is
  currently a stub returning "Resume requested for X."

### F7 — Plan confirmation, diff provider, artifact cards
- Location: `src/tui/App.tsx`, `src/orchestrator/machine.ts:98`
- Required per §5.1/§5.3/§7: in "ask" mode the user confirms the BuildPlan before BUILDING;
  implement `diffProvider` (git diff + untracked when in a repo, else before-snapshot of touched
  files) — the reviewer currently receives an empty diff; render Plan/Report/Verdict via the
  existing (unused) `PlanView.tsx`, and wire `Approval.tsx` as the permission bridge.

### F8 — Round-limit semantics
- Location: `src/orchestrator/machine.ts:78`
- Required: worker gets exactly `maxReviewRounds` build rounds; `maxReviewRounds: 0` means
  immediate takeover with no worker build. Current `round > maxReviewRounds + 1` grants one
  extra round. Update the exhaustion test to assert build-call counts, not just `takeover: true`.

### F9 — Process discipline
- One commit per remaining fix batch going forward (plan §11.6 asked for per-milestone commits —
  this cannot be repaired retroactively, but do not repeat it). Update COMPLETION_REPORT.md to
  reflect actual status honestly, including what was NOT completed; the report claiming M1–M3
  "done" while the TUI has a hardcoded placeholder is the most serious process failure in this
  round.

## Re-review checklist for next round

Everything in BUILD_PLAN.md §12, plus: a real end-to-end M3 demo transcript (leader + worker on
live APIs — the user's keys are available via `.env`), `/loop 1m` firing twice, non-zero `/cost`
after a run, and kill-during-BUILDING → `/resume` recovery.
