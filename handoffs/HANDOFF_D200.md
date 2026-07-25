# Handoff D200 (URGENT, false completion: the orchestrator's "A implements the item" step is a read-only stub — every wishlist cycle marks the item DONE without ever writing code for it)

## Live defect (proven — don't re-derive)

D199's live proof showed a real, unattended scheduled-task fire claiming W0023,
completing a full cycle in 4 minutes, and marking it `DONE`. That was reported as
a milestone. It is a false completion. Verified directly:

- `git rev-list --count master..refs/tandem-relay/stable` = 0, and
  `refs/tandem-relay/stable` points at `9073b9f` — the exact commit that was
  already stable before the cycle started (D198-2). **No new commit was created**
  for W0023 anywhere in git history.
- `scripts/reciprocal-orchestrator.mjs`'s `loadCommands()` hardcodes the
  `implement` step to:
  ```
  powershell ... reciprocal-direction.ps1 -Action Show -ControlPath ...
  ```
  This is a **read-only** command that prints the wishlist board. It always
  exits 0 (the file is always readable) regardless of the claimed item's content,
  so `a-implements.passed` is unconditional. There is no invocation of any coding
  agent (Claude Code, Codex, or otherwise) anywhere in the orchestrator to
  actually implement the wishlist item.
- `a-tests` then runs the existing test suite against whatever is already on
  disk (trivially green, since nothing changed), and the cycle proceeds through
  real packaging/promotion/rebuild machinery and marks the item `DONE`.

Net effect: **the orchestrator will mark any queued wishlist item DONE without
ever writing a line of code for it.** The swap/promotion machinery (verified
sound in D196-D199) is wrapped around a stub with no implementation step. This is
the single most important omission in the whole redesign — everything else
(claim, test-gate, packaging, promotion, rebuild-A, idle detection, scheduling)
is real and independently verified; this one step is not.

W0023 has been requeued (`reciprocal-direction.ps1 -Action Requeue -Id W0023`)
with a note explaining why. Do not re-mark it done without genuine implementation
work and a real commit.

## Fix

1. **Wire a real implementation step.** The orchestrator must actually invoke a
   coding agent against the claimed wishlist item's text and produce real
   changes (a real commit on top of the current stable, addressing that specific
   item), analogous to what the old Executor A prompt/session flow did before
   D196. Decide the mechanism (a synchronous agent invocation the orchestrator
   waits on; a session it drives via the automation API; etc.) and implement it
   for real — not another read-only placeholder standing in for it.
2. **Make it impossible for a no-op cycle to silently succeed.** At minimum:
   assert the implement step actually produced a new commit reachable from HEAD
   (`git rev-parse HEAD` before/after must differ, or an explicit "no changes
   were made" result must abort the cycle rather than proceeding to test/complete).
   A cycle that reaches `a-tests`/`cycle.completed` without a new commit must be
   treated as a failure, not a success.
3. **Retroactively audit**: confirm no other wishlist item completed by the
   orchestrator (check `orchestrator-operations.ndjson` for every
   `cycle.completed` since D196's cutover) suffers the same false-completion
   defect. Report every affected item.
4. **Regression**: a fixture wishlist item with a concrete, checkable acceptance
   requirement; assert the orchestrator's cycle fails/aborts if no commit is
   produced, and succeeds only when a genuine implementing commit exists and
   satisfies the item.

## Constraints

- Do not touch the swap/promotion/rebuild machinery — it is verified correct and
  out of scope for this fix.
- Do not mark W0023 (or any item) done as part of landing this fix unless the
  orchestrator's real implementation step genuinely produces and verifies a
  working Telegram approval-flow commit.
- Preserve the requeued W0023 note; do not silently clear it.

## Acceptance

`handoffs/D200_done.txt`: the real implementation mechanism, the no-commit
abort/failure guard, the retroactive audit results (which past `cycle.completed`
entries if any were also false completions, and what was done about them), and
regression coverage. Live proof: let the scheduler claim a real queued item
(W0023 is now available again) and show a genuine commit being produced,
tested, and promoted — not just the swap machinery running clean. tsc + `npm test`
green. Commit `D200-<n>:`. Create `handoffs/D200_done.txt`.
