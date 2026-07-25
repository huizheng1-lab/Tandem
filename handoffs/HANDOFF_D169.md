# Handoff D169 (Fix dashboard approval completion workspace routing)

## Review verdict

W0022 candidate `0bf22a4bbb537c28e03ecd5d25508a7d453db345` was approved and mostly
promoted successfully, but the dashboard approval workflow hit a structural
completion bug.

This is not a W0022 product failure. It is a Reciprocal workflow issue in the
dashboard approval path.

Do not implement W0023, W0024, or any Telegram product feature in this round. This
handoff is only for fixing the approval workflow so future accepted candidates do not
leave the relay paused with a yellow error banner.

## Observed failure

After the human approved the W0022 preview, the dashboard showed:

```text
CompleteAUpgrade must run from passive branch codex/reciprocal-a, but this worktree
is on codex/reciprocal-b.
```

Audit evidence in
`C:\Users\huizh\Apps\Tandem Reciprocal\control\CONTROL_PANEL_AUDIT.jsonl` for
`approval-1784574982764`:

- `review-recorded` succeeded for candidate `0bf22a4`.
- `executors-stopped` succeeded.
- `runtime-promoted` succeeded:
  - executor-a runtime promoted to `0bf22a4`
  - executor-b runtime promoted to `0bf22a4`
- `executors-restarted` succeeded.
- final `update.approvePromote` failed at `current="executors-restarted"` with:
  `CompleteAUpgrade must run from passive branch codex/reciprocal-a, but this
  worktree is on codex/reciprocal-b.`

Manual recovery for this instance was already performed safely:

1. Resumed the paused relay from `paused` over `a-upgrade-pending`.
2. Ran `CompleteAUpgrade` from passive worktree copy-a.
3. Marked W0022 `DONE` with stable `0bf22a4`.

Current live state after manual recovery:

- relay phase: `idle`
- stable commit: `0bf22a4bbb537c28e03ecd5d25508a7d453db345`
- W0022: `DONE`
- next queued item: `W0024`
- W0023 remains queued

Do not redo the recovery. Fix the structural cause and add regression coverage.

## Root cause to verify

The dashboard helper already knows `a-upgrade-pending` completion requires
`CompleteAUpgrade`:

- `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.mjs`
- `approvalCompletionRelayAction(interruptedPhase)` returns:
  - `action: "CompleteAUpgrade"`
  - `role: "A"`
  - `force: true`
  - `step: "a-upgrade-completed"`

However the dashboard server approval completion path appears to drop the required
workspace/branch routing:

- `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs`
- `resumeApprovalPause(flow, summary)` calls:
  `relayControl(completion.action, summary, { role: completion.role, force: completion.force })`
- That does not pass a passive workspace selection for `CompleteAUpgrade`, so the
  server used the default producer worktree, copy-b.

The relay script correctly rejected the command because `CompleteAUpgrade` is only
valid from passive branch `codex/reciprocal-a`.

## Required work

### 1. Route approval completion through the correct passive workspace

Fix the dashboard approval flow so when `approvalCompletionRelayAction()` returns a
`CompleteAUpgrade` action, the eventual `relayControl()` call runs it from passive
copy-a / branch `codex/reciprocal-a`.

Use a repo-consistent design. Acceptable approaches include:

- have `approvalCompletionRelayAction("a-upgrade-pending")` return
  `workspace: "a"` and ensure `resumeApprovalPause()` forwards that option to
  `relayControl()`; or
- have `relayControl()` infer the passive workspace for `CompleteAUpgrade`; or
- another explicit, testable mechanism that cannot silently fall back to copy-b.

The fix must preserve ordinary approval behavior for non-`a-upgrade-pending` states:

- approval after an idle/non-upgrade pause should still resume normally;
- active-turn wait/cancel/override behavior must not regress;
- runtime promotion, executor stop/start, and audit records must remain intact.

### 2. Make the dashboard failure recoverable and understandable

If an approval flow fails after runtime promotion but before relay resume/completion,
the dashboard should report the remaining step precisely enough that a human or worker
can recover without guessing:

- include that `CompleteAUpgrade` must be run from passive copy-a when applicable;
- do not imply the candidate itself failed if review, runtime promotion, and executor
  restart already succeeded;
- do not mark the flow complete unless the relay is actually resumed/idle or the
  upgrade completion command succeeds.

### 3. Preserve current accepted W0022 state

Do not change, rebuild, relaunch, reject, or reimplement W0022.

Keep:

- W0022 `DONE` at stable `0bf22a4bbb537c28e03ecd5d25508a7d453db345`
- relay stable commit `0bf22a4bbb537c28e03ecd5d25508a7d453db345`
- W0024 and W0023 queued
- `SHARED_DIRECTION.md` free of wishlist-specific items

## Required checks

Run focused tests proving:

- For `interruptedPhase === "a-upgrade-pending"`, approval completion invokes
  `CompleteAUpgrade` from passive copy-a / `codex/reciprocal-a`, not copy-b.
- For ordinary paused/idle approval completion, the dashboard still calls `Resume`
  with the previous behavior.
- A simulated post-promotion failure reports a precise remaining action, including
  the passive-worktree requirement for `CompleteAUpgrade`.
- The current live `/api/status` succeeds and reports:
  - phase `idle`
  - stable commit `0bf22a4bbb537c28e03ecd5d25508a7d453db345`
  - next queued item `W0024`
- `control/WISHLIST.md` has W0022 `DONE`, W0024 `QUEUED`, and W0023 `QUEUED`.
- `control/SHARED_DIRECTION.md` contains no `W0022`, `W0023`, `W0024`,
  `wishlist-items`, `## Wishlist`, or `## Removed`.

Also run:

- relevant dashboard focused tests;
- `node --check C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs`;
- `node --test C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.nodecheck.mjs`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## Completion

Commit implementation changes with `D169-<n>:` subject(s). Commit the done marker
separately as `handoffs/D169_done.txt`.

In `D169_done.txt`, include:

- root cause summary;
- exact files changed;
- proof that `CompleteAUpgrade` is routed through passive copy-a;
- proof that normal resume approval behavior still works;
- live `/api/status` summary;
- W0022/W0023/W0024 wishlist status proof;
- test commands and results;
- explicit confirmation that W0023, W0024, and any Telegram product feature were not
  implemented in this infrastructure round.
