# Handoff D150 (leader takeover completions never get committed as a reciprocal candidate - `postBuildReport` is skipped on the takeover path)

Live incident: executor A's session hit a leader takeover (a prior attempt in the same
session was interrupted before it ran the relay's mandated `Claim` command), and the
takeover correctly recovered the in-progress `RESUME` checkpoint, implemented real work
(W0014 step 2/3: typed streaming session-search IPC, orchestration, and preload
wiring), and reported `status: "complete"` with a full, accurate `filesChanged` list -
42 focused tests passing, typecheck clean, diff-check clean. The `TakeoverReport`
artifact and the session's `done` event both show this succeeded. But nearly an hour
later the `copy-b` worktree still shows those same 7 files as uncommitted modifications
(`git status --short`), `HEAD` is unchanged, and the relay's `state.json` never
advanced (`candidateCommit` still `null`, `updatedAt` frozen from before the
completion). No data was lost - the dirty worktree self-protects, since the relay's
`Claim` action refuses to start a new turn against dirty state (`Assert-Clean`) - but
the relay is effectively stuck again until this is understood and fixed.

## The bug (confirmed, don't re-derive)

`src/orchestrator/machine.ts`'s normal worker-build path calls
`options.postBuildReport` unconditionally on every round's merged report, before
authoritative verification (line 536-539):

```ts
report = mergeCompletionReports(roundStreams);
if (options.postBuildReport) {
  report = await options.postBuildReport(report, { plan, round: currentRound });
  emit({ type: "artifact", name: "PostBuildReport", value: report });
}
const authoritative = await attachAuthoritativeVerification(report);
```

`options.postBuildReport` is wired (in `app/main/tandem-service.ts:277`) to
`this.postBuildReport`, which calls `commitReciprocalCandidate` (`src/reciprocal/
candidate-commit.ts:117`) - the function that actually does `git add`/`git commit` and
hands the commit to `reciprocal-relay.ps1 -Action Candidate`/`-Action Complete`. That
function is already fully safe to call unconditionally: its first line
(`candidate-commit.ts:118`) is a no-op guard - `if (!isRole(options.role) ||
options.report.status !== "complete" || options.report.filesChanged.length === 0)
return options.report;` - so calling it on a "blocked" or empty-filesChanged report is
harmless.

But `runTakeover` (`src/orchestrator/machine.ts:427-466`), the function that handles a
leader takeover recovering and completing a turn, never calls `options.postBuildReport`
at all. It validates the takeover's `CompletionReport`, runs authoritative
verification, emits the `TakeoverReport` artifact, transitions to `DONE`, and returns -
skipping straight past the one call that would have turned a `status: "complete"`
takeover report into an actual committed candidate. This is a pure omission, not a
deliberate design choice - there's no comment or reasoning anywhere suggesting takeover
completions are intentionally excluded from candidate creation, and excluding them
makes no sense given takeover is a normal, expected recovery path in this protocol.

## Fix

Add the same `postBuildReport` call to `runTakeover`, in the equivalent position
relative to authoritative verification as the normal path uses (before
`attachAuthoritativeVerification`, i.e. right after `schemaReport` is validated at line
436-439, before line 440's `attachAuthoritativeVerification` call) - match the normal
path's ordering exactly rather than tacking the call on at the end, since the normal
path's ordering (commit before authoritative verification) likely exists to avoid the
authoritative test run leaving stray dirty paths that would trip
`commitReciprocalCandidate`'s "unreported dirty paths" check. Also emit the
`PostBuildReport` artifact the same way the normal path does, so the UI/session log
shows the same event shape regardless of which path produced the final report.

## Investigation

Before writing the fix, check whether `runTakeover`'s final fallback branch (line
459-465, reached when all 3 takeover attempts throw schema-validation errors but a
`schemaOnly` parse still succeeds) should also get this treatment - if a takeover
report can reach `status: "complete"` there too, apply the same fix; if that branch can
only produce non-"complete"/blocked-shaped reports, explain why and leave it as-is
rather than guessing.

## Constraints

- Do not touch `commitReciprocalCandidate` or `candidate-commit.ts` - they are already
  correct and safe to call unconditionally; the bug is purely the missing call site.
- Do not touch the normal (non-takeover) build path - it already works correctly.
- Do not touch the D149 `Claim`/`Test-GenuineResumeState` logic - unrelated and
  correctly fixed already.

## Acceptance

Root cause explained with evidence already in this handoff (don't re-derive - reuse the
file/line references above). Add a regression: a takeover run that produces a
`status: "complete"` report with a real `filesChanged` list must result in
`postBuildReport` being called (assert on a mock/spy, matching however existing
machine.ts tests already assert on `postBuildReport` for the normal path - follow that
existing pattern). Live proof: the real `copy-b` worktree currently has the exact
uncommitted W0014-step-2 changes from this incident sitting dirty right now - after the
fix lands, safely turn that already-completed work into a real reciprocal candidate
(do not re-run or duplicate the implementation - the work is already done and verified;
only the commit/candidate step was missing) and show the resulting relay state
(`candidateCommit` set, `phase: validating`) or, if it already got validated and
accepted by the time this lands, show the resulting `stableCommit` advancing with
W0014 step 2/3 marked complete. tsc + `npm test` green. Commit `D150-<n>:`. Create
`handoffs/D150_done.txt`.
