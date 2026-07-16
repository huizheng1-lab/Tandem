# Handoff D58 (D54 REVISE — partial-revise rounds drop carried-forward streams from the merged report)

## Bug (confirmed via a real `runOrchestration` run with mock agents, reproduced deterministically)

In `src/orchestrator/machine.ts`, in the multi-round build loop, after a revise round that only
targets SOME streams (the common case — a 2-stream plan where the leader's feedback only
mentions stream B):

```js
const roundStreams: { streamId: string; report: CompletionReport }[] = [
  ...newReports.map((report, i) => ({ streamId: targetStreams[i]?.id ?? "?", report })),
  ...carryForward
];
streamReportHistory.push(roundStreams);   // <-- correctly includes carryForward
report = mergeCompletionReports(
  newReports.map((r, i) => ({ streamId: targetStreams[i]?.id ?? "?", report: r }))
  // <-- BUG: only newReports, carryForward is dropped here
);
```

`streamReportHistory` (used for the NEXT round's `previousReportsByStream`) is built correctly
from `roundStreams` (new + carried-forward). But the `report` variable — the one that gets
`reports.push(report)`'d and handed to `agents.review()` THIS round — is built from `newReports`
ALONE. Any stream that was carried forward (not re-run this round) is completely absent from what
the leader reviews.

## Reproduction (exact — hand this test to whoever fixes it, or an equivalent)
2-stream plan (stream A: task A1/a.txt, stream B: task B1/b.txt). Round 1: both streams build,
both complete — confirmed correct, round-1 review sees `taskResults: [A1, B1]`. Leader returns
`revise` with feedback that only names B1. Round 2: only stream B is re-run (correct — the
targeting logic itself works). But the round-2 `review()` call received:
```
report.taskResults = [{"id":"B1","status":"done"}]      // A1 is gone
report.filesChanged = ["b.txt"]                          // a.txt is gone
```
Live-verified this is what actually happens by running `runOrchestration` end to end with mock
`AgentFns` (plan → build → review), not by reading the code alone.

## Impact
- The leader reviewing a revise round for a multi-stream plan has **no visibility into any
  carried-forward stream's work** — it cannot catch a regression, cannot see the file, cannot
  confirm the earlier task is still intact. It's reviewing an incomplete picture and doesn't know
  it.
- The final `TakeoverReport`/approved report handed back to the user after a multi-round,
  multi-stream run will be **missing task results and file lists for any stream that wasn't
  rebuilt in the LAST round** — a real, user-visible correctness bug, not just an internal
  bookkeeping issue.
- This only manifests when there are 2+ streams AND at least one revise round with selective
  targeting — exactly the scenario the original D54 acceptance bar didn't get to (live
  verification of concurrency wasn't performed, and even a from-scratch live check would likely
  have used a single round). This is why a static/single-round smoke test wasn't enough here.

## D58-1: Fix
Use `roundStreams` (already correctly assembled) to build the merged report, not `newReports`
alone:
```js
report = mergeCompletionReports(roundStreams);
```
That's the fix — `roundStreams` already has the right shape (`{streamId, report}[]` combining
new + carry-forward) that `mergeCompletionReports` expects. Confirm this doesn't break anything
that currently reads `newReports` elsewhere in the same block (check the `streamReportHistory`
line above it still works unchanged — it already uses `roundStreams`, this fix just makes the
`report` variable use the same source).

## D58-2: Add a regression test
Add the reproduction above (or equivalent) as a real test in `tests/orchestrator.test.ts`: a
2-stream plan, mock `AgentFns` where `review()` forces a revise targeting only one stream's task
on round 1, then assert the round-2 report passed to `review()` (or the final `result.reports`
entry) contains task results and filesChanged for BOTH streams, not just the re-run one.

## Acceptance
tsc + `npm test` green, including the new regression test. Since this is a correctness fix in the
core orchestration loop, also re-run the existing D54 unit test suite (partition/merge/disjoint-
files) to confirm nothing else regressed — those were correct on inspection and are not expected
to change. Live check: not required to be a full concurrent-CDP run this time — a real
`runOrchestration` execution (like the reproduction here) with real or mock multi-stream agents
demonstrating the round-2 merged report is now complete is sufficient and matches how this bug
was actually found. Commit `D58-<n>:`, create `D58_done.txt` with the before/after report
contents pasted in, not just a claim it's fixed.
