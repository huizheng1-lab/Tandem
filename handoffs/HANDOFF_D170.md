# Handoff D170 (Unblock W0024 and produce a reviewable candidate)

## Review verdict

W0024 has a plausible implementation in Executor A's producing worktree, but it is
not complete or reviewable. The relay auto-paused after three consecutive RESUME
claims, the work remains uncommitted, and no candidate commit exists.

Do not discard or redo the W0024 implementation. Correct the verification and
completion gaps, prove the full suite is green, and use the supported Reciprocal
workflow to produce a candidate for human preview/review.

Do not implement W0023 in this round.

## Current state and evidence

- Relay phase: `paused`, paused from `working`, turn 14, active role A.
- `resumeCount=3`, `resumeThreshold=3`.
- Stable/base commit:
  `0bf22a4bbb537c28e03ecd5d25508a7d453db345`.
- Candidate commit: none.
- W0024: `IN_PROGRESS role=A`.
- W0023: `QUEUED`.
- Preserved W0024 implementation files in
  `C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-b`:
  - `src/remote-control/bridge.ts`
  - `tests/remote-control.test.ts`

The implementation changes `/sessions` from a typed reply keyboard containing
short `/use ...` commands to numbered Telegram inline buttons. Callback data uses a
bounded opaque token; callbacks re-resolve against the current session list and
retain allowlist, rate-limit, audit, stale-selection, and `useSession` handling.
The existing typed `/use` path remains present.

Current independently reproduced checks:

- `npm run build`: PASS. The earlier access-denied/esbuild report is stale and is
  not the current blocker.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS (line-ending warnings only).
- Focused W0024 test: PASS (16/16).
- Combined focused run of `tests/remote-control.test.ts`,
  `tests/remote-control-bridge-prompt.test.ts`, and
  `tests/reciprocal-direction.test.ts`: 41 PASS, 1 FAIL.
- The current failure is
  `tests/remote-control-bridge-prompt.test.ts:61`, which still expects
  `options.keyboard == [["/use session-"]]`. W0024 intentionally emits
  `options.inlineKeyboard`, so that assertion was not reconciled with the new UI.
- The previously reported timeout at `tests/reciprocal-direction.test.ts:200`
  passed in the combined focused rerun. Treat it as a possible full-suite load or
  timing issue until a clean full run proves otherwise.
- The most recent Executor A run also failed to produce a valid leader
  `ReviewVerdict` after three CLI attempts, then preserved a blocked build report.

## Required work

### 1. Recover the paused W0024 turn safely

Use the supported relay recovery/resume commands from the correct Executor A
worktree and role. Preserve the existing dirty W0024 files and checkpoint. Do not
reset, stash away, overwrite, or abandon the implementation.

Do not repeatedly invoke RESUME without progressing the work. Record the exact
recovery action and resulting relay state.

### 2. Reconcile all affected tests with the intended W0024 behavior

Update the prompt-routing integration coverage so it validates the new numbered
inline session selector rather than requiring the removed typed reply keyboard.
The test must continue to prove its original behavior: when there is only one
current session, a human can send a plain prompt successfully after `/sessions`.

Add or retain assertions proving:

- `/sessions` exposes a numbered inline button with bounded callback data and a
  human-readable session title;
- activating the button selects the exact live session through the existing
  `useSession` binding point;
- a stale or invalid callback cannot bind a session and gives a refresh message;
- unauthorized and rate-limited callbacks do not switch sessions and remain
  auditable;
- the existing typed `/use` command remains backward compatible;
- plain-message prompt submission still routes to the selected/only session.

Do not merely delete the failing assertion. Replace it with coverage of the new
interaction and preserve the substantive prompt-routing expectation.

### 3. Resolve or prove the reciprocal-direction timeout

Run `tests/reciprocal-direction.test.ts` in isolation and as part of the full suite.
If the timeout recurs, diagnose its current cause and make the test deterministic
without increasing timeouts blindly, skipping it, weakening assertions, or changing
unrelated wishlist semantics. If it does not recur, record both the isolated and
full-suite passing evidence.

### 4. Prevent stale verification status from blocking completion

Run the build again from the copy-b worktree. When it passes, the completion report
must report the current successful build, not the earlier access-denied failure.

If leader `ReviewVerdict` generation fails again after all checks pass, capture the
current CLI error and recover through the supported Reciprocal/app-layer path. Do
not fabricate a verdict, bypass independent review, or mark W0024 done manually.

### 5. Produce the normal W0024 candidate

Once every required check passes, complete the current Executor A turn through the
normal Reciprocal candidate workflow so the dashboard exposes a W0024 candidate
preview for human review.

Final state for this handoff must be one of:

- preferred: W0024 is a concrete `CANDIDATE` with a commit and reviewable preview;
  or
- genuinely blocked: exact current external blocker is recorded with all passing
  checks and preserved work, without another blind RESUME loop.

Do not mark W0024 `DONE`; only human acceptance may do that. Leave W0023 queued.

## Required checks

From
`C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-b`, run and record:

- `npm run build`
- `npm run typecheck`
- `npx vitest run --configLoader runner tests/remote-control.test.ts tests/remote-control-bridge-prompt.test.ts`
- `npx vitest run --configLoader runner tests/reciprocal-direction.test.ts`
- `npm test`
- `git diff --check`

Also verify:

- relay status has advanced safely from the current auto-pause;
- W0024 remains the only active product item in this round;
- W0023 remains queued and unchanged;
- `control/SHARED_DIRECTION.md` contains no wishlist-specific issue text or W-item
  identifiers;
- no unrelated user changes were overwritten;
- candidate metadata, candidate commit, and preview source commit agree if a
  candidate is produced.

## Safety constraints

- Do not implement W0023 or Telegram approval-integration Step 3.
- Do not remove or weaken pairing, allowlist, rate-limit, audit, callback-answer,
  stale-session, or session-binding safeguards.
- Do not remove backward-compatible typed `/use` support.
- Do not alter `SHARED_DIRECTION.md` to contain W0024 or any specific wishlist item.
- Do not promote or integrate W0024 into stable/master before human approval.
- Preserve all unrelated worktree and user changes.

## Completion

Commit implementation changes with `D170-<n>:` subject(s). Commit the done marker
separately as `handoffs/D170_done.txt`.

In `D170_done.txt`, include:

- exact root cause of the stalled W0024 round;
- exact files changed;
- relay recovery command and resulting state;
- old failing assertion and replacement integration coverage;
- isolated reciprocal-direction test result and full-suite result;
- build, typecheck, focused tests, full tests, and diff-check results;
- candidate commit and preview evidence, or the precise remaining external blocker;
- proof W0023 remained queued and unmodified;
- confirmation that W0024 was not marked DONE or promoted without human approval.
