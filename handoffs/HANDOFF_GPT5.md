# Handoff to GPT-5 — Tandem remaining work (Round 3)

Context: You previously built Tandem from `BUILD_PLAN.md` and revised it per `REVIEW_FEEDBACK.md`
(read both first — they are in this repo root). Since then the reviewing leader (Claude) took over
live-testing fixes, committed as `d4a2a92`: native Google Gemini provider (`src/providers/`),
stream-error surfacing and a forced-tool-call "nudge" when a model ends its turn without calling
its `submit_*` tool (`src/agents/runner.ts`), prose-tolerant verification matching
(`src/orchestrator/artifacts.ts`), and worker-artifact-failure → takeover
(`src/orchestrator/machine.ts`). Live testing runs Gemini 2.5 Pro as leader and MiniMax M2.7 as
worker via `tests/live-smoke.test.ts` (`RUN_LIVE=1 npx vitest run tests/live-smoke.test.ts`; it
costs real tokens — do NOT run it unless asked; the offline suite must stay network-free).

## Rules (unchanged from BUILD_PLAN.md §11)

- `npx tsc --noEmit` clean and `npm test` green (currently 15/15) after EVERY task below.
- One git commit per task, message `R3-<n>: <summary>`.
- No new runtime dependencies without a stated reason in the completion report.
- When done, update `COMPLETION_REPORT.md` honestly (include real tsc/test output) — last round's
  overstatement was flagged; do not repeat it.

## Tasks, in priority order

### R3-1: Mid-phase crash resume (biggest gap; BUILD_PLAN §9, M5 acceptance)
Persist orchestration progress so a killed session can continue. On each machine event, the app
already appends to the JSONL session store. Add: a `checkpoint` event carrying `{phase, round,
plan, reports, verdicts, feedbackHistory}`; on `/resume <id>`, if the last checkpoint is not DONE,
reconstruct that state and offer to continue — restart the interrupted phase (re-run the worker
round or review from stored artifacts; never resume mid-LLM-stream). Modify `runOrchestration` to
accept an optional `initialState` for this. Unit-test: drive the machine with fake agents, capture
a checkpoint mid-run, start a new `runOrchestration` from it, assert it completes without
re-running earlier rounds.

### R3-2: Non-git diff fallback (BUILD_PLAN §5.3)
`src/orchestrator/diff.ts` returns a "diff unavailable" string outside git repos. Implement the
before-snapshot: before each BUILDING round, snapshot the contents of files (tracked via the tool
context — record every path passed to write_file/edit_file, plus files existing under cwd up to a
sane cap); after the round, produce a unified diff (`diff` npm package is already a dependency).
Keep the git path as-is. Unit-test with a temp dir.

### R3-3: Goal progress notes (BUILD_PLAN §8)
After a DONE pipeline run, have the leader append a one-line progress note to any active goal it
advanced: add a `note_goal` tool available only during review/takeover summarization, or simpler —
after DONE, one extra cheap leader call that receives active goals + the userSummary and returns
`{goalId, note}[]`; append via `src/session/goals.ts`. Notes persist in `.tandem/goals.json`.

### R3-4: Esc-during-prompt promise leak (REVIEW_FEEDBACK round 2, item 4)
In `src/tui/App.tsx`, if Esc is pressed while `pendingApproval` or `pendingPlan` is set, resolve
the pending promise with `false` and clear the state so the pipeline unwinds cleanly instead of
hanging.

### R3-5: Bare `/model` interactive picker (BUILD_PLAN §8)
`/model` with no args currently prints usage. Implement a minimal picker in the TUI: list registry
ids with key-availability markers, arrow-key selection, choose role (leader/worker) then model;
persist via the existing `setModel`.

### R3-6: Dependency audit
`npm audit` reports 12 vulnerabilities (1 critical). Run `npm audit`, identify which are in
runtime dependencies vs dev-only, apply non-breaking upgrades (`npm audit fix` without `--force`),
and list any remaining ones with justification in the completion report. Do not switch libraries.

### R3-7: Docs refresh
README: document the `google/*` built-in models and GEMINI_API_KEY, the `/model` picker, the live
smoke test (with its cost warning), and a short "how a request flows" section (plan → build →
review → revise/takeover). Update `.env.example` with GEMINI_API_KEY. Keep it accurate to the code.

## What NOT to touch
- The orchestrator state-machine semantics (round counting, takeover routing) — they are spec'd
  and tested; R3-1 may extend the entry point but must not change existing test behavior.
- `enforceVerification` matching rules.
- The nudge logic in `runner.ts`.

## Acceptance for this round
All tasks committed individually; `npx tsc --noEmit` clean; `npm test` green with the new R3-1 and
R3-2 tests included; README reproduces reality. The reviewing leader will re-review against this
file and REVIEW_FEEDBACK.md.
