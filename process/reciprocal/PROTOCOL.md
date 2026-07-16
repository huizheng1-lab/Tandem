# Reciprocal Tandem Protocol

This protocol runs two pinned Tandem executors against two independent git worktrees. Executor A edits worktree B; executor B edits worktree A. The running executable is therefore never inside the workspace it is allowed to modify.

## Turn lifecycle

1. Read the local `TANDEM.md`, this protocol, and `.tandem/reciprocal-checkpoint.md` if it exists.
2. Run the exact `Claim` command from `TANDEM.md` before investigating or editing.
3. Interpret the result:
   - `CLAIMED`: the relay fast-forwarded this target branch from its peer and assigned this turn to you.
   - `VALIDATE`: the other executor produced a candidate. Before editing anything, run `npm run typecheck`, `npm test`, and `git diff --check`. If the candidate touches `src/agents/`, `src/orchestrator/`, `src/session/compaction`, prompt files, or `src/providers/`, also run one cheap real-model smoke using minimax-m3 credentials from this executor's isolated `.env` (for example `scripts/live-minimax-m3.ts` or an equivalent `createLiveAgents().plan()` call on a trivial request). Require a schema-valid planning result, not merely exit code 0. This costs only fractions of a cent and catches live-dead code that static checks have missed. If all checks pass, run your role's `Accept` command. If an improvement candidate fails, run `Rollback`, verify the restored tree with the same checks, and run `CompleteRollback`. If a rollback candidate fails, pause for human inspection instead of reverting the revert.
   - `RESUME`: an earlier attempt by this same executor stopped. Inspect the reported phase and checkpoint. Resume validation, rollback verification, or implementation as appropriate; do not start a different task.
   - `WAIT` or `PAUSED`: stop immediately with a short direct response. Do not create a plan, edit files, run the full test suite, or spend tokens reviewing the repository.
4. Do not begin an improvement until the relay is in `working` phase. Read `.tandem/shared-control/SHARED_DIRECTION.md` with `scripts/reciprocal-direction.ps1 -Action Show`. Select the highest-priority queued human wishlist item. Until a human explicitly removes this restriction after a few reviewed batches, do not self-select `[AUTO]` improvements; if no human wishlist item is `QUEUED`, use `Pause` with reason `no queued human item`.
5. Run `scripts/reciprocal-direction.ps1 -Action Start -Id <id> -Role <role>` before editing. Humans may append new items while a turn is active; do not switch away from the item already in progress.
6. Write `.tandem/reciprocal-checkpoint.md` with the objective, wishlist ID if any, evidence, intended files, current phase, checks already run, and the next concrete action. Update it after each major phase so a fresh model session can resume after a quota reset.
7. Implement the smallest coherent fix. Add or update focused tests when behavior changes.
8. Run focused checks plus, at minimum:
   - `npm run typecheck`
   - `npm test`
   - `git diff --check`
9. Review the complete diff, stage only intended files, and commit once with a descriptive message beginning `relay:`. Never stage `.tandem`, `TANDEM.md`, secrets, build output, or unrelated files. Mark a wishlist item `Candidate` with that commit before handing off.
10. Re-run `git status --short`. It must be clean before completion. Run the exact relay `Complete` command from `TANDEM.md`, including a concise verification summary.

After the opposite executor accepts a candidate, it marks the matching wishlist item `Complete` with the accepted commit. After a verified rollback or abandoned attempt, it `Requeue`s the item with a concise failure note. Use `Block` only when human input is genuinely required. Do not mark work accomplished merely because its implementing executor reported success.

If no high-confidence improvement is available, use the `Pause` command with a reason. Do not manufacture code churn merely to pass the turn.

If an in-progress approach becomes unrecoverable before it is committed, use the role's `Abandon` command. It stashes tracked and untracked work with a recovery label, restores the stable branch state, and lets the same role retry later. Never abandon merely because a model quota is exhausted; quota interruptions should resume from the checkpoint.

Human pause is reversible. `Pause` records the current relay phase in `pausedFromPhase`, leaves the owner, turn token, refs, and worktrees untouched, and makes later `Claim` attempts return `PAUSED`. `Resume` is valid only while the relay is paused; it restores the saved phase and requires a human-readable summary. `Reset -Force` remains the heavy human recovery path and must not be used as a casual resume.

## Safety boundaries

- Never modify the executor runtime, the peer worktree, the admin worktree, the relay state under the common git directory, or either branch by any route other than the relay command and the current target worktree.
- Synchronization is fast-forward-only. Never merge normally, rebase, cherry-pick, force-push, reset, amend, or rewrite history.
- Every improvement is a one-commit candidate whose parent is the confirmed stable commit. The opposite executor must independently validate it before the stable ref advances.
- Do not change this protocol, the reciprocal scripts, branch topology, model credentials, permissions, release configuration, or dependency versions during an autonomous turn.
- Do not delete broad file sets, disable tests, weaken assertions, suppress errors, or trade correctness for a passing suite.
- Do not run destructive git or filesystem commands.
- Treat pre-existing changes as a recovery signal. Resume only when the relay says `RESUME`; otherwise stop and ask the human to inspect.
- Keep one turn narrow: normally no more than six production files and roughly 400 net new lines. Pause and propose a human-reviewed handoff if the work is larger, architectural, security-sensitive, or ambiguous.
- Local commits are the source of truth. A failed remote push does not justify rewriting or repeating a completed commit.

## Quota and restart behavior

The shared relay state and local checkpoint are durable. If a leader or worker reaches its rolling token limit, crashes, or the app closes, leave the worktree and checkpoint untouched. The same executor owns the turn until it successfully completes or a human resets the relay. The next scheduled run reads `RESUME` and continues from disk rather than starting over.

The common git repository also stores `refs/tandem-relay/stable`, `refs/tandem-relay/candidate`, and (during recovery) `refs/tandem-relay/rollback`. These refs survive app and model failures. Rollback uses ordinary revert commits, so the failed change remains auditable and both branches can continue to synchronize with fast-forward-only merges.

The schedules are intentionally staggered by 30 minutes. Tandem skips a scheduled prompt while another run in that same app is active. Inactive executors exit at `WAIT`, keeping their token use small. `/loop` is suitable only for supervised temporary retries because loop state disappears when the app closes; the persisted `/schedule` entries are the normal unattended mechanism.

## Master reconciliation

`master` remains the trunk. Before starting a relay session, if `codex/reciprocal-a` and `codex/reciprocal-b` are strict ancestors of `master`, fast-forward both reciprocal branches to `master` and update `refs/tandem-relay/stable` to that same commit. If either reciprocal branch contains commits that `master` lacks, stop and ask for human reconciliation.

After a reviewed reciprocal batch, pause the relay, merge the stable ref into `master` through the normal human-supervised flow, then fast-forward both reciprocal branches to the new `master` before resuming. A merge commit on `master` is allowed; the fast-forward-only rule governs the relay branches.

Never run D-round `master` work and relay turns concurrently on overlapping files. If a D-round lands on `master` mid-batch, finish the active reciprocal batch first, pause, then reconcile before starting the next relay turn.
