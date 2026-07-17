# Reciprocal Tandem Protocol

This protocol runs two pinned Tandem executors against two independent git worktrees. Executor A edits worktree B; executor B edits worktree A. The running executable is therefore never inside the workspace it is allowed to modify.

## Turn lifecycle

1. Read the local `TANDEM.md`, this protocol, and `.tandem/reciprocal-checkpoint.md` if it exists.
2. Run the exact `Claim` command from `TANDEM.md` before investigating or editing.
3. Interpret the result:
   - `CLAIMED`: the relay fast-forwarded this target branch from its peer and assigned this turn to you.
   - `VALIDATE`: the other executor produced a candidate. Full-suite peer validation remains mandatory before stable advances. Before editing anything, run `npm run typecheck`, `npm test`, and `git diff --check`. These commands must also remain in the turn plan's verification list so Tandem's authoritative runner executes them outside the producing Codex sandbox. If the candidate touches `src/agents/`, `src/orchestrator/`, `src/session/compaction`, prompt files, or `src/providers/`, also run one cheap real-model smoke using minimax-m3 credentials from this executor's isolated `.env` (for example `scripts/live-minimax-m3.ts` or an equivalent `createLiveAgents().plan()` call on a trivial request). Require a schema-valid planning result, not merely exit code 0. This costs only fractions of a cent and catches live-dead code that static checks have missed. If all checks pass, run your role's `Accept` command. If an improvement candidate fails, run `Rollback`, verify the restored tree with the same checks, and run `CompleteRollback`. If a rollback candidate fails, pause for human inspection instead of reverting the revert.
   - `RESUME`: an earlier attempt by this same executor stopped. Inspect the reported phase and checkpoint. Resume validation, rollback verification, or implementation as appropriate; do not start a different task.
   - `WAIT` or `PAUSED`: stop immediately with a short direct response. Do not create a plan, edit files, run the full test suite, or spend tokens reviewing the repository.
4. Do not begin an improvement until the relay is in `working` phase. Read `.tandem/shared-control/SHARED_DIRECTION.md` with `scripts/reciprocal-direction.ps1 -Action Show`. Select the highest-priority claimable human wishlist item: a normal `QUEUED` item, an epic `QUEUED` for its plan-only turn, or an approved epic with a recorded next step and no current owner. An epic plan candidate is not claimable until it is `PLAN_APPROVED`, whether approval is human or automatic. Until a human explicitly removes this restriction after a few reviewed batches, do not self-select `[AUTO]` improvements; if no human item is claimable, use `Pause` with reason `no queued human item`.
5. Run `scripts/reciprocal-direction.ps1 -Action Start -Id <id> -Role <role>` before editing. Humans may append new items while a turn is active; do not switch away from the item already in progress.
6. Write `.tandem/reciprocal-checkpoint.md` with the objective, wishlist ID if any, evidence, intended files, current phase, checks already run, and the next concrete action. Update it after each major phase so a fresh model session can resume after a quota reset.
7. Implement the smallest coherent fix. Add or update focused tests when behavior changes.
8. Inside a sandboxed producing turn, run focused tests for every changed behavior plus, at minimum:
   - `npm run typecheck`
   - `git diff --check`
   Never weaken, skip, or suppress a test that can run in the sandbox. Every implementation plan must still list the full `npm test` command in its verification array. Tandem's authoritative verification runner executes that full suite outside the producing Codex sandbox after the worker returns, and the opposite executor repeats the full suite during `VALIDATE` before stable advances. On Windows, do not repeatedly retry a full-suite command inside Codex when workspace-write blocks Vitest configuration loading or child-process cleanup; only that redundant in-sandbox invocation is relocated. The two authoritative full-suite gates remain mandatory, and a failure at either gate prevents acceptance.
9. Review the complete diff and ensure `filesChanged` in the completion report lists every intended changed path and no forbidden path. Never include `.tandem`, `TANDEM.md`, secrets, build output, or unrelated files. Do not run `git add`, `git commit`, wishlist `Candidate`, or relay `Complete` from inside a sandboxed Codex producing turn. Tandem's unsandboxed app layer validates the reported file list, stages exactly those files, creates the single `relay:` commit, marks the active wishlist item `Candidate`, and runs relay `Complete`. Epic plan files are tracked under `process/reciprocal/epics/`, not the ignored `.tandem/` directory.
10. The completion report summary becomes the `relay:` commit message subject, so make it concise and descriptive. Re-run `git status --short` before reporting; the only dirty paths should be the intended files listed in `filesChanged`.

Acceptance infrastructure follows the same cleanup rule as scratch files: stop every temporary dashboard or test-server instance and verify its port is no longer listening before writing the round marker.

After the opposite executor accepts a candidate, it marks the matching wishlist item `Complete` with the accepted commit. After a verified rollback or abandoned attempt, it `Requeue`s the item with a concise failure note. Use `Block` only when human input is genuinely required. Do not mark work accomplished merely because its implementing executor reported success.

If no high-confidence improvement is available, use the `Pause` command with a reason. Do not manufacture code churn merely to pass the turn.

## Epics

An epic spans multiple ordinary one-commit relay turns. Add one with `reciprocal-direction.ps1 -Action Add -Epic`. Add `-Autonomy full` when the human's act of adding the item should authorize its validated plan automatically. Otherwise the item uses `AutonomyDefault: plan-gated|autonomous` from the shared board. The shipped default is `plan-gated`. The turn-size norm remains per commit; an epic is not permission to bundle a large change.

1. The first `Start` on a queued epic is plan-only. Make no production-code changes. Create `process/reciprocal/epics/<ID>-plan.md` with ordered Markdown checkbox steps, acceptance evidence for each step, and an explicit statement that every intermediate commit leaves required checks green. Commit only the plan and mark it with `Candidate -Steps <n> -Plan process/reciprocal/epics/<ID>-plan.md`.
2. The opposite executor validates that plan candidate through the normal relay. For a plan-gated epic, implementation remains blocked until a human uses the dashboard plan gate. For a fully autonomous epic, immediately after relay `Accept`, run `reciprocal-direction.ps1 -Action AutoApprovePlan -Id <id> -Commit <accepted-stable>`; this records `approval=auto`, writes the plan auto-approval audit entry, and changes the board to `PLAN_APPROVED` without a human click.
3. `Start` on an approved epic assigns exactly the recorded next step. Implement only that step and check its plan checkbox in the same commit. Mark the commit with ordinary `Candidate`; do not skip, reorder, or combine steps.
4. After peer validation of a non-final step, record `AcceptStep -Commit <stable>` so the board returns to `IN_PROGRESS` with `step k/n` and the next step. The final accepted step uses `Complete` and moves the epic from `CANDIDATE` to `DONE`.
5. If a step is wrong-sized or remaining steps need restructuring, change only the plan in that turn and use `Candidate -PlanRevision -Steps <new-total> -Plan <path>`. All remaining implementation is blocked until that revision is peer-validated and approved under the same policy again.

The human can pause the relay at any time. `Requeue -Id <id> -Note <reason>` on an autonomous epic step is a retroactive plan rejection: it preserves completed history, increments the revision, and sends the epic back to a plan-only turn. The dashboard keeps the plan visible throughout.

Feature-flagged or scaffolding-only steps are valid stable increments. Full autonomy never relaxes this protocol's safety boundaries and never authorizes runtime promotion or master integration. Authentication, credentials, pairing, and remote-control work are forced to plan-gated mode regardless of the board default. Epics do not replace human-designed D-round handoffs when security-sensitive work cannot be decomposed safely.

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
- Keep one turn narrow: normally no more than six production files and roughly 400 net new lines. This norm applies to every epic plan or step commit as well as non-epic work. Pause and propose a human-reviewed handoff if the work cannot be decomposed into stable steps or is architectural, security-sensitive, or ambiguous.
- Local commits are the source of truth. A failed remote push does not justify rewriting or repeating a completed commit.

## Quota and restart behavior

The shared relay state and local checkpoint are durable. If a leader or worker reaches its rolling token limit, crashes, or the app closes, leave the worktree and checkpoint untouched. The same executor owns the turn until it successfully completes or a human resets the relay. The next scheduled run reads `RESUME` and continues from disk rather than starting over.

The common git repository also stores `refs/tandem-relay/stable`, `refs/tandem-relay/candidate`, and (during recovery) `refs/tandem-relay/rollback`. These refs survive app and model failures. Rollback uses ordinary revert commits, so the failed change remains auditable and both branches can continue to synchronize with fast-forward-only merges.

The reciprocal launcher gives Codex's sandbox write access to the shared control directory and the admin repository's common `.git` relay state. Codex CLI 0.144.2 still denies writes under the linked-worktree Git metadata directory `.git/worktrees/<name>` even when the common `.git` and that child directory are passed through `--add-dir`; direct `git add` therefore fails on `index.lock`. The producing model must not commit directly. Tandem's app process is outside the Codex shell sandbox and performs the final guarded candidate commit and relay completion after the worker returns its completion report.

The schedules are intentionally staggered by 30 minutes. Tandem skips a scheduled prompt while another run in that same app is active. Inactive executors exit at `WAIT`, keeping their token use small. `/loop` is suitable only for supervised temporary retries because loop state disappears when the app closes; the persisted `/schedule` entries are the normal unattended mechanism.

Reciprocal executors normally run hidden and are started through the dashboard Kickstart flow. Their local automation server exists only with explicit launcher flags, binds to `127.0.0.1`, requires a per-launch bearer token stored in the isolated executor state directory, and restricts session/prompt requests to the configured peer worktree. It does not expose shell or arbitrary command verbs. The manual visible-app prompt remains a diagnostic fallback.

## Master reconciliation

`master` remains the trunk. Before starting a relay session, if `codex/reciprocal-a` and `codex/reciprocal-b` are strict ancestors of `master`, fast-forward both reciprocal branches to `master` and update `refs/tandem-relay/stable` to that same commit. If either reciprocal branch contains commits that `master` lacks, stop and ask for human reconciliation.

After a reviewed reciprocal batch, pause the relay, merge the stable ref into `master` through the normal human-supervised flow, then fast-forward both reciprocal branches to the new `master` before resuming. A merge commit on `master` is allowed; the fast-forward-only rule governs the relay branches.

The reciprocal dashboard is the normal human-supervised integration surface. Its **Update main branch** gate requires a comment, refuses an active turn or dangling candidate, verifies the exact stable commit, pushes `master` together with a sequential annotated `main-update-NNN` tag without force, reconciles both reciprocal branches and the stable state, and audits the result. Branch-only **Backup to GitHub** is separate from integration and from the relay token; it must never push `master` or retry a rejected push with force.

Never run D-round `master` work and relay turns concurrently on overlapping files. If a D-round lands on `master` mid-batch, finish the active reciprocal batch first, pause, then reconcile before starting the next relay turn.
