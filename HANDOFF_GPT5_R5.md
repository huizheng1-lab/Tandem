# Handoff to GPT-5 — Round 5 (polish backlog)

Context: R4 reviewed — offline verdict APPROVE (tsc clean, 22 tests on vitest 4, audit down to
7 low dev-only, demo artifacts untracked, prose-fallback owned and tested, usage recording
reworked). Live confirmation of worker cost is in progress; section R5-1 will be updated with the
result. Same rules: tsc + tests green per task, one commit per task (`R5-<n>:`), honest report,
never run `tests/live-smoke.test.ts` yourself.

## R5-1: Live worker-cost verdict — CONFIRMED FIXED, no action
Live run 7: worker 28620 in / 2313 out / $0.0114; leader 24405 in / 1552 out / $0.0460. R4-4 is
verified; do not touch that code. One related finding moved to R5-6.

## R5-6: Smoke test uses the legacy diff provider — reviewer saw "empty diff" complaints
In live runs the leader repeatedly notes the diff is empty and has to re-read files manually.
`tests/live-smoke.test.ts` passes the plain `workingTreeDiff(demoDir)` function; `demo-todo/` is
gitignored, so git diff is empty. Switch the smoke test to the R3-2 snapshot diff provider object
(`{ beforeBuild, diff }`) exactly as `App.tsx` wires it, so the review phase receives a real diff.

## R5-2: Tighten the live smoke test's cost assertion
`tests/live-smoke.test.ts` asserts `leader.outputTokens + worker.outputTokens > 0`, which passes
even when worker usage is lost (the exact R4-4 bug it should catch). Change it to assert
`worker.outputTokens > 0` and `leader.outputTokens > 0` separately, and also assert
`worker.dollars > 0`. Also print the cost object via `process.stdout.write` (vitest 4 intercepts
`console.log` on passing tests, which hid the numbers from the reviewer).

## R5-3: Missed-schedule catch-up (deferred from R3, disclosed limitation)
On startup, for each schedule whose last-fire time was missed while Tandem was closed, show a
per-schedule prompt (reuse the pending-approval input flow in `App.tsx`): "Missed schedule <id>
(<cron>): run now? y/n". Requires persisting a `lastRunAt` per schedule in
`.tandem/schedules.json`. Unit-test the missed-detection logic (pure function: given cron,
lastRunAt, now → missed or not; a simple "previous scheduled time > lastRunAt" check is fine).

## R5-4: Transcript artifact cards — expand/collapse (BUILD_PLAN §7, partial)
`PlanView` renders the latest plan/verdict, but the plan called for collapsible artifact cards in
the transcript (collapsed to title + counts, expandable via a keybind). Implement a simple
version: artifacts appear in the transcript as one-line summaries; a keybind (e.g. `ctrl+e`)
toggles expansion of the most recent artifact. Keep it minimal — no scrollback virtualization.

## R5-5: `/help` accuracy sweep
Verify `/help` output lists every implemented command with correct syntax (picker `/model`,
`/loop stop`, `/schedule list|rm`, `/resume`, `/goal add|list|done`), and remove anything not
implemented. Cross-check against `src/commands/index.ts` and App.tsx handlers.

## Explicitly out of scope (do not build unless the user asks)
Background daemon for schedules, session-picker UI, web/desktop UI, multi-worker fan-out.
