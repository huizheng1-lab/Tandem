# Reciprocal Tandem Protocol

This protocol runs two pinned Tandem executors against two independent git worktrees. Executor A edits worktree B; executor B edits worktree A. The running executable is therefore never inside the workspace it is allowed to modify.

## Turn lifecycle

1. Read the local `TANDEM.md`, this protocol, and `.tandem/reciprocal-checkpoint.md` if it exists.
2. Run the exact `Claim` command from `TANDEM.md` before investigating or editing.
3. Interpret the result:
   - `CLAIMED`: the relay fast-forwarded this target branch from its peer and assigned this turn to you.
   - `RESUME`: an earlier attempt by this same executor stopped. Resume the checkpoint and current diff; do not start a new task.
   - `WAIT` or `PAUSED`: stop immediately with a short direct response. Do not create a plan, edit files, run the full test suite, or spend tokens reviewing the repository.
4. On a new turn, inspect the current code, recent commits, tests, and any human-maintained backlog. Select exactly one evidence-backed improvement that can be completed in about 90 minutes.
5. Write `.tandem/reciprocal-checkpoint.md` with the objective, evidence, intended files, current phase, checks already run, and the next concrete action. Update it after each major phase so a fresh model session can resume after a quota reset.
6. Implement the smallest coherent fix. Add or update focused tests when behavior changes.
7. Run focused checks plus, at minimum:
   - `npm run typecheck`
   - `npm test`
   - `git diff --check`
8. Review the complete diff, stage only intended files, and commit once with a descriptive message beginning `relay:`. Never stage `.tandem`, `TANDEM.md`, secrets, build output, or unrelated files.
9. Re-run `git status --short`. It must be clean before completion. Run the exact `Complete` command from `TANDEM.md`, including a concise verification summary.

If no high-confidence improvement is available, use the `Pause` command with a reason. Do not manufacture code churn merely to pass the turn.

## Safety boundaries

- Never modify the executor runtime, the peer worktree, the admin worktree, the relay state under the common git directory, or either branch by any route other than the relay command and the current target worktree.
- Synchronization is fast-forward-only. Never merge normally, rebase, cherry-pick, force-push, reset, amend, or rewrite history.
- Do not change this protocol, the reciprocal scripts, branch topology, model credentials, permissions, release configuration, or dependency versions during an autonomous turn.
- Do not delete broad file sets, disable tests, weaken assertions, suppress errors, or trade correctness for a passing suite.
- Do not run destructive git or filesystem commands.
- Treat pre-existing changes as a recovery signal. Resume only when the relay says `RESUME`; otherwise stop and ask the human to inspect.
- Keep one turn narrow: normally no more than six production files and roughly 400 net new lines. Pause and propose a human-reviewed handoff if the work is larger, architectural, security-sensitive, or ambiguous.
- Local commits are the source of truth. A failed remote push does not justify rewriting or repeating a completed commit.

## Quota and restart behavior

The shared relay state and local checkpoint are durable. If a leader or worker reaches its rolling token limit, crashes, or the app closes, leave the worktree and checkpoint untouched. The same executor owns the turn until it successfully completes or a human resets the relay. The next scheduled run reads `RESUME` and continues from disk rather than starting over.

The schedules are intentionally staggered by 30 minutes. Tandem skips a scheduled prompt while another run in that same app is active. Inactive executors exit at `WAIT`, keeping their token use small. `/loop` is suitable only for supervised temporary retries because loop state disappears when the app closes; the persisted `/schedule` entries are the normal unattended mechanism.
