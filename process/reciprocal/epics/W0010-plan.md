# W0010 Cumulative Session Cost Across Resumes

Objective: persist cumulative per-session cost (leader + worker input/output
tokens and dollars) durably so that a long multi-resume session shows its
true total, and display that cumulative figure alongside the current-run
cost in the desktop sidebar cost area. Cover the resume accumulation and
display formatting with regression tests.

This epic is `autonomy=full`, so once the plan candidate is independently
accepted, the relay auto-approves it and step turns may begin immediately.

## Background

`TandemService.startSession` (in `app/main/tandem-service.ts`) replaces
`this.ledger = new CostLedger()` and resets `this.lastPersistedCostKey`, so
the in-memory cost ledger starts empty on every session. `persistCostSnapshot`
appends a `cost` event containing the current `CostTotals` to the session
JSONL whenever `emitText` or `emitMachine` fires, deduplicated by snapshot
key. `TandemService.resumeSession` opens the JSONL and replays other state
(checkpoints, goals, memory, etc.) but never reads the most recent `cost`
event, so the ledger remains empty after resume and the next emitted
`costEvent` IPC payload only reflects the new resume's usage. A real
session's final snapshot showed only the last resume's ~45k leader tokens
instead of the cumulative multi-resume total.

## Ordered Steps

- [x] Step 1: replay the last persisted cost snapshot on resume and unit-test it.
- [x] Step 2: surface cumulative and current-run cost in the desktop sidebar cost area, with regression tests for the display formatting and the IPC payload.

## Invariants for every step

- Perform exactly one step per relay candidate and check only the implemented step box in the same commit.
- Keep `npm run typecheck`, `npm test`, and `git diff --check` green after every step.
- Cumulative totals include leader **and** worker input tokens, output tokens, and dollars. Both fields are persisted, hydrated, and displayed together; partial hydration is not acceptable.
- No change to the leader/worker token-pricing model, model registry, or any model credentials, pairing, or remote-control surface.
- The per-session cost dedup key (`lastPersistedCostKey`) keeps working so unchanged totals are not duplicated in the JSONL.
- Do not weaken any existing `D98` cost-snapshot persistence tests; this epic builds on them.

## Step 1 — Replay the last persisted cost snapshot on resume

Files expected (≤ 6 production files):

- `src/session/cost.ts`: add `CostLedger.hydrate(totals: CostTotals)` that replaces the internal tick list with a single synthetic baseline tick carrying the supplied totals, so subsequent `add`/`addDirectCost` calls accumulate on top of the baseline. Do not change existing `totals()` or `totalDollars()` semantics.
- `app/main/tandem-service.ts`:
  - Add a private helper that scans session events (in reverse) and returns the most recent `cost` event payload, if any.
  - In `resumeSession`, after `this.session = store` and before returning, call the helper; if it returns a `CostTotals`, hydrate `this.ledger` with it. Keep `this.lastPersistedCostKey = undefined` so the next emit re-snapshots when new usage shifts the totals.
  - Do **not** add a new IPC field in this step (Step 2 owns renderer-visible surface changes); the in-memory hydration is enough to fix the silent loss between resumes.
- `tests/desktop-service.test.ts`: add tests covering:
  - Resume hydrates `service.ledger.totals()` from a prior persisted `cost` event in the JSONL.
  - A subsequent run accumulates on top of the hydrated baseline so the emitted `costEvent` payload reports the sum of baseline + new usage.
  - Resuming a session with no `cost` events leaves the ledger empty (no regression for fresh sessions).
- `tests/session-cost.test.ts` (new, ≤ 60 lines): minimal unit tests for `CostLedger.hydrate` proving the totals round-trip and that subsequent `add` calls accumulate on top.

Acceptance evidence:

- A single new test in `tests/desktop-service.test.ts` that resumes a JSONL containing a prior `cost` snapshot and asserts the next `costEvent` payload sent on the renderer IPC channel equals baseline + new ticks.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Step 2 — Surface cumulative and current-run cost in the desktop sidebar

Files expected (≤ 6 production files):

- `app/shared/ipc.ts`: extend `CostTotals` with an optional `cumulative?: { leader: CostTick; worker: CostTick }` field so existing callers keep working. Do not remove or rename existing fields.
- `app/main/tandem-service.ts`:
  - Track `this.runBaselineTotals?: CostTotals` (set to the ledger totals at the start of each run, or to the hydrated baseline at resume time).
  - On every `costEvent` emit, compute current-run totals as `currentTotals - this.runBaselineTotals` (clamped at zero for each numeric field) and ship both `{ ...currentTotals, cumulative }` and a fresh `cumulative` derived from the full `ledger.totals()`.
  - When the JSONL contains no prior `cost` snapshot at resume time, `cumulative` equals `currentTotals`; when one exists, `cumulative` is strictly greater after any new usage.
- `app/renderer/src/cost-display.ts`:
  - Add a pure formatter `formatCumulativeCost(totals, config, models)` returning a short sidebar string (e.g. `"this run $0.0012 / total $1.2043"`) using the existing `shortTokens` helper and the same price-unknown fallback rules as `formatTotalCost`.
  - Export `cumulativeTooltip(totals, config)` that produces the existing `costTitle`-style multi-line breakdown for the new sidebar entry.
- `app/renderer/src/main.tsx`:
  - Hold cumulative totals in a `useState<CostTotals>()` populated from both the resume response and subsequent `costEvent` payloads (renderer recomputes the sidebar string from the same payload it already stores).
  - Add a new `<div className="sideSection">` in the sidebar (between "Session" and "Sessions") that renders the formatted `formatCumulativeCost` output with the tooltip from `cumulativeTooltip`. Existing header `totalCost` keeps showing only this-run cost.
  - Extend `costText()` (the `/cost` command output) with a `total:` line that reports the cumulative dollars and tokens using the existing rounding/formatting conventions.
- `tests/renderer-cost-display.test.ts`: add tests for `formatCumulativeCost` covering the priced-model branch, the price-unknown branch, and the zero-cumulative edge case.
- `tests/desktop-service.test.ts`: add a test that emits multiple `costEvent` payloads during a resumed run and asserts each payload carries a `cumulative` field equal to the running `ledger.totals()`.

Acceptance evidence:

- A new sidebar section is visible in the desktop renderer with both the per-run and cumulative dollar totals, and the existing `totalCost` header stays unchanged.
- The `/cost` command prints a cumulative line alongside the per-role lines.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Safety Notes

- This epic only touches cost accumulation, persistence replay, and renderer display. It does not modify agent, orchestrator, compaction, prompt, provider, or credential code; therefore the `VALIDATE` phase's cheap real-model smoke is not required by the protocol.
- The IPC change is additive (optional `cumulative` field). The desktop build, preload, and existing renderer code paths remain backward-compatible: pre-Step-2 renderer builds just ignore the new field.
- All edits stay inside `src/session/cost.ts`, `app/main/tandem-service.ts`, `app/shared/ipc.ts`, `app/renderer/src/cost-display.ts`, `app/renderer/src/main.tsx`, and tests under `tests/`. No protocol, reciprocal script, branch topology, dependency, or credential changes are in scope.
