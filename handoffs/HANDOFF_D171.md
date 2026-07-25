# Handoff D171 (Fix approval pause/CompleteAUpgrade phase mismatch and recover ead38ad)

## Review verdict

The human approved and promoted W0026 candidate
`ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`. The binary promotion itself succeeded,
but the dashboard approval workflow failed after restarting the executors and left the
relay paused over `a-upgrade-pending`.

This is a Reciprocal approval-orchestration defect, not a W0026 product failure and not
a model failure. D169 fixed the earlier wrong-worktree routing for
`CompleteAUpgrade`, but it did not cover the phase mismatch created by the approval
flow's own pause step.

Do not implement W0027 or any product feature in this round. Do not rebuild or
re-promote W0026. This handoff is only for fixing the approval state transition,
regression coverage, and safe recovery of the already-promoted live state.

## Live evidence

Approval audit id: `approval-1784679748127` in
`C:\Users\huizh\Apps\Tandem Reciprocal\control\CONTROL_PANEL_AUDIT.jsonl`.

Completed successfully before the failure:

- `relay-paused`: relay paused from `a-upgrade-pending`;
- `review-recorded`: approved candidate `ead38ad`;
- `executors-stopped`;
- `runtime-promoted`: both Executor A and B runtime `BUILD_INFO.json` files now report
  source SHA `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`;
- `executors-restarted`: both hidden automation endpoints came back ready.

The terminal action then failed with:

```text
CompleteAUpgrade is valid only while a-upgrade-pending. Current phase: paused.
```

Current state to recover:

- relay `phase=paused`;
- `pausedFromPhase=a-upgrade-pending`;
- `activeRole=null`, `nextRole=A`, turn 2;
- stable and last completed commit:
  `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`;
- both pinned runtime BUILD_INFO files already match `ead38ad`;
- W0026 is already `DONE` at `ead38ad`;
- W0027 remains `QUEUED` and must not be claimed until recovery is coherent.

## Root cause to verify

`C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs` currently does this:

1. `waitForApprovalBoundary()` captures `interruptedPhase="a-upgrade-pending"`.
2. It nevertheless calls `Pause`, changing the relay to `phase=paused` with
   `pausedFromPhase=a-upgrade-pending`.
3. After promotion and executor restart, `resumeApprovalPause()` correctly selects
   `CompleteAUpgrade` and routes it through passive workspace copy-a (the D169 fix).
4. `scripts/reciprocal-relay.ps1` correctly rejects that action because its guard
   currently requires `phase` to equal `a-upgrade-pending`, not `paused`.

The D169 focused test only proves helper selection and workspace routing. It does not
exercise the real sequence `Pause -> promote -> restart -> CompleteAUpgrade` against
relay state, so it passed while this integration defect remained.

## Required work

### 1. Make the approval transition phase-correct

Implement a narrow, explicit state-machine correction for approval flows originating
at `a-upgrade-pending`.

Preferred behavior: treat `a-upgrade-pending` with `activeRole=null` as an already-safe
approval boundary, so `waitForApprovalBoundary()` does not first turn it into a generic
paused state. The final human-confirmed action must still be
`CompleteAUpgrade -Role A -Force` from passive copy-a.

If a different design is used, it must be equally safe and testable. Do not weaken the
human gate or make `CompleteAUpgrade` generally valid from arbitrary paused states.
Any support for `paused` must be limited to
`pausedFromPhase=a-upgrade-pending`, must preserve passive-copy routing, and must not
allow a generic pause to bypass review or runtime proof.

Preserve all existing behavior for ordinary idle/working approval flows, active-turn
drain/cancel/override, executor stop/start, and audit logging.

### 2. Make the terminal step retryable after partial success

An approval that has already recorded review, promoted both matching runtimes, and
restarted them must have a deterministic recovery route that closes only the relay
gate. It must not require or silently perform another runtime copy.

Before closing the gate in this recovery path, verify at minimum:

- relay stable SHA is the approved source SHA;
- both Executor A and B `BUILD_INFO.json` source SHAs match that exact SHA;
- the interrupted/paused phase is specifically the A-upgrade gate;
- no active reciprocal turn exists.

On mismatch, stop with one precise actionable error. Do not mark the flow complete,
resume normal claims, or alter W0027.

### 3. Recover the current live relay once the fix is proven

After focused tests pass, close the already-promoted `ead38ad` A-upgrade gate using
the corrected supported workflow. Do not re-promote the binaries.

Final live state must show:

- relay `phase=idle`, `activeRole=null`, `nextRole=A`;
- stable commit remains `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`;
- both runtime BUILD_INFO source SHAs remain that exact commit;
- W0026 remains `DONE`;
- W0027 remains `QUEUED` immediately after recovery (do not implement it in D171).

Record an audit entry that distinguishes "already promoted; relay gate recovered" from
a new promotion.

## Required regression tests

Add an integration-level approval-flow test, not only a pure helper assertion, proving:

1. Starting from `phase=a-upgrade-pending`, `activeRole=null`, the approval flow reaches
   `A_UPGRADE_COMPLETED`/`idle` without calling `CompleteAUpgrade` from `paused`.
2. The terminal command uses passive copy-a / branch `codex/reciprocal-a`, Role A, and
   `-Force`.
3. Recovery from the exact partial state
   `phase=paused`, `pausedFromPhase=a-upgrade-pending`, matching stable/review/runtime
   SHAs closes the gate without re-promoting.
4. A generic paused state, wrong `pausedFromPhase`, active role, or BUILD_INFO/stable
   mismatch is rejected and remains non-mutating.
5. Ordinary working/idle approval flows retain their existing Pause/Resume behavior.
6. Failure after promotion still reports completed steps and one exact remaining
   recovery action.

Also preserve and run the D169 wrong-worktree regression.

## Safety constraints

- Do not edit W0026 implementation files or W0027 product/workflow implementation.
- Do not change the approved/stable SHA or create a product candidate.
- Do not rebuild, re-copy, or re-promote the already-matching `ead38ad` runtimes during
  live recovery.
- Do not weaken `-Force`, human-readable summary, branch, role, or SHA checks.
- Do not use a plain generic `Resume` as the final successful state; the A-upgrade gate
  must be explicitly completed and audited.
- Preserve unrelated user changes and existing executor checkpoints.
- Dashboard operational files under
  `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard` may be changed only as needed for
  this correction; application/product behavior is out of scope.

## Required checks

Run:

- focused integration tests covering the six cases above;
- `node --check C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs`;
- `node --check C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.mjs`;
- `node --test C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.nodecheck.mjs`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

After live recovery, capture read-only proof from relay status, both runtime
`BUILD_INFO.json` files, WISHLIST status, and the approval audit.

## Completion

Commit implementation changes with `D171-<n>:` subject(s). Commit
`handoffs/D171_done.txt` separately if that is the established marker convention.

In `D171_done.txt`, include:

- verified root cause;
- exact files changed and commit hashes;
- the real approval-flow integration test, including phase sequence;
- proof D169 passive-workspace routing still passes;
- proof current `ead38ad` recovery did not re-promote binaries;
- final relay/runtime/W0026/W0027 state;
- audit evidence;
- all test commands and results;
- explicit confirmation that W0027 was not implemented.
