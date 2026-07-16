# Handoff D54 (parallel workers: let the leader partition a plan into concurrent workstreams)

## Goal
Today `runOrchestration` (src/orchestrator/machine.ts) is strictly sequential: one leader, ONE
worker `build()` call per round covering the entire BuildPlan. For large jobs with independent
parts (the user's 7-task bilingual-video job is the motivating case — the single MiniMax worker
returned `blocked` after finishing zero of seven tasks), the leader should be able to partition
the plan into independent workstreams and the orchestrator should run one worker agent per
stream CONCURRENTLY, then review the merged result.

The LEADER decides the partitioning (it knows task dependencies); the ORCHESTRATOR spawns the
workers (workers never spawn workers). Partitioning stays optional — a plan without streams
behaves exactly as today.

## Design decisions (already made — do not relitigate; flag concerns in the marker if you see a
hard blocker)

1. **Schema: add optional `stream` to tasks.** Each BuildPlan task gains an optional string field
   `stream` (e.g. "A", "B"). Tasks sharing a stream label run in the same worker; tasks with NO
   stream label all belong to an implicit default stream. A plan where no task has a `stream`
   label (or all share one) is a single-stream plan → exactly today's behavior, same code path.
   This keeps the schema change minimal and backward-compatible (old checkpoints/sessions parse
   unchanged). Update BOTH the zod schema (src/orchestrator/artifacts.ts BuildPlanSchema) and the
   hand-rolled JSON schemas in src/agents/codex-cli/schema-json.ts (remember the D37 lesson:
   OpenAI structured outputs requires every property in `required` — optional fields must be
   nullable-and-required there, mirroring how `files` is already handled).

2. **Safety invariant: streams must own DISJOINT file sets.** Two agentic workers writing the
   same file concurrently in the same cwd is the failure mode to prevent. Enforce mechanically in
   `validateBuildPlan`: if a plan declares 2+ streams, every task in a stream-labeled plan MUST
   list `files`, and no file path may appear in tasks of two different streams. Violation =
   validation error → leader gets it back as validation feedback (same loop that already handles
   bad verification commands). Overlapping reads are fine and unenforceable; we only gate on the
   declared write-ownership lists.

3. **Verification: per-stream subsets + whole-plan check at review.** Plan-level `verification`
   commands can't be run meaningfully by a worker that only built half the plan. Add optional
   `verification` to each stream's LAST task? No — simpler: add an optional plan-level map
   `streamVerification: { [stream]: string[] }` alongside `verification`. Each worker gets and
   must run only its stream's commands (verbatim-echo contract unchanged, scoped to its subset).
   The full plan-level `verification` list is run by the LEADER at review time (the reviewer
   toolset already permits rerunning plan verification commands — see the reviewer system prompt
   in live.ts). For single-stream plans, behavior is unchanged: the worker runs `verification` as
   today. `enforceVerification` (artifacts.ts:174) must therefore validate a stream worker's
   report against its STREAM subset, not the whole plan list — pass the expected command list in
   explicitly rather than always deriving it from `plan.verification`.

4. **Merging reports.** Orchestrator runs N `build()` calls via `Promise.all` (each receives the
   full plan for context PLUS its own `stream` id and only-its-tasks view), collects N
   CompletionReports, and merges into ONE synthetic CompletionReport for the round:
   `taskResults` concatenated (every plan task must appear exactly once across streams —
   validate), `filesChanged` union, `verificationResults` union, `status` = "complete" only if
   every stream is complete ("blocked" if ANY stream is blocked), `summary` = joined per-stream
   summaries prefixed with stream ids, `deviationsFromPlan` concatenated. The merged report is
   what gets pushed to `reports`, checkpointed, and reviewed — the review/feedback/takeover
   machinery downstream is untouched and stays single-track.

5. **Failure/retry semantics.** `retryArtifact`'s 3-attempt retry applies PER STREAM (retry only
   the failed stream, not the ones that succeeded). If any stream still fails after retries →
   same takeover path as today (`worker artifact failure; leader takeover`). If any stream
   reports `blocked` → existing blocked→takeover rule fires on the merged report. Abort: all
   stream workers share the run's abortSignal (already threaded through worker options).

6. **Revise rounds re-run only affected streams.** On a `revise` verdict, map each feedback
   item's `location`/task references to the owning stream; re-run only streams that received
   feedback (pass that stream's previous report as `previousReport`). If a feedback item can't be
   attributed to a stream, re-run all streams (safe fallback). Unaffected streams' previous
   reports carry forward into the next merge.

7. **Concurrency cap + opt-in config.** New config field `maxParallelWorkers` (int, default 1,
   min 1). At 1 (default), even a multi-stream plan runs its streams SEQUENTIALLY in stream order
   — same net behavior/cost as today, zero risk to existing users. >1 enables real concurrency,
   capped at that many simultaneous workers (schedule streams beyond the cap as earlier ones
   finish). Add to ConfigSchema/defaultConfig (src/config/schema.ts), surface in `/status`, and
   make it settable like `maxReviewRounds` is (config file; a slash command is optional, note if
   skipped).

8. **Leader prompt guidance.** Update the leader planner prompts (AI-SDK path in live.ts AND the
   codex-cli/claude-code-cli leader prompt builders — all three engines) to describe the stream
   field: partition into streams ONLY when the request has genuinely independent parts with
   disjoint file ownership; when in doubt, don't partition. Include the disjoint-files rule and
   the streamVerification contract in that guidance so plans validate on the first try.

9. **Events/UI.** Emit per-stream transition notices (e.g. `round 1/3 worker build [stream A:
   3 tasks]`) so the desktop activity strip and transcript show what each worker is doing.
   Worker text/tool events should be tagged with the stream id in the message text (no new event
   schema — prefix is enough for v1).

## Out of scope for D54 (do not build)
- Workers spawning sub-workers (never).
- Cross-stream dependency ordering (DAG scheduling) — streams are fully independent by
  definition; anything with dependencies belongs in one stream.
- Merging git conflicts — disjoint file ownership makes real conflicts a validation bug, not a
  runtime feature.
- Parallel review (review stays single, on the merged report).

## Acceptance
tsc + `npm test` green, including new unit tests for: stream file-overlap validation (rejects),
merged-report construction (status/blocked propagation, taskResults coverage check), per-stream
enforceVerification scoping, revise-round stream targeting, and the maxParallelWorkers=1
sequential fallback. Schema-required tests: required-covers-properties still passes for the
updated JSON schemas (the D37 recurring-bug test must be extended to the new fields).

Live verification (reviewer will re-run): with `maxParallelWorkers: 2+` and a real 2-stream plan
(e.g. "create docs/a.md per spec X and tools/b.js per spec Y" — trivially independent), confirm
two real worker invocations run CONCURRENTLY (overlapping timestamps in the activity log), the
merged CompletionReport covers all tasks, review passes, and both files exist with correct
content. Also confirm a single-stream plan (any old-style request) still runs exactly as before,
and that a deliberately overlapping-files 2-stream plan is REJECTED at validation with a clear
message. Commit `D54-<n>:`, create `D54_done.txt` with raw evidence per the usual bar.
