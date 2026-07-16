# Two-Copy Reciprocal Tandem

This setup uses two source worktrees, two local branches, two pinned packaged executors, two isolated `TANDEM_HOME` directories, and two isolated Electron user-data directories.

The direction is deliberately crossed:

- executor A runs from immutable runtime A and edits worktree B (`codex/reciprocal-b`);
- executor B runs from immutable runtime B and edits worktree A (`codex/reciprocal-a`).

The launcher also injects protected roots for the admin repository, the executor's own source worktree, both runtimes, and both state stores. Tandem rejects writes to those paths even if a model emits an absolute path; only the selected peer target remains writable.

Only the executor named by the shared relay state may work. A completed turn gives ownership to the other executor. Each target branch first fast-forwards from its peer, so successful turns form one linear history and divergence stops the relay.

A completion is initially only a candidate. The opposite executor runs the full baseline checks before accepting it as stable. A failed candidate is reverted in a new commit and verified against the stable tree; uncommitted failed attempts are preserved in a named git stash. The stable, candidate, and rollback commits also have durable refs under `refs/tandem-relay/`.

## One-time setup

Run from the admin repository after committing the reciprocal files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-reciprocal-tandem.ps1 -CopyEnv
```

The default root is `C:\Users\huizh\Apps\Tandem Reciprocal`. The script installs dependencies in both worktrees and copies the current packaged D107 runtime twice. The copied executors remain pinned; autonomous changes affect source branches only. Rebuild and promote a runtime manually after reviewing a batch of turns.

The setup script is safe to rerun: it preserves an existing relay token. Use its `-ResetRelay` switch only for deliberate human recovery.

`-CopyEnv` copies the current local `.env` into each isolated `TANDEM_HOME`. Omit it if credentials are already supplied another way. The generated configs use `permissionMode: yolo`, which is required for unattended verification and commits; isolation, protected runtimes, narrow instructions, linear history, and the turn token are the safety controls.

## Start and kickstart

The dashboard **Kickstart** button is the normal entry point. It starts both executor runtimes hidden, waits for their authenticated loopback endpoints, and injects the first-turn prompt into executor A for worktree B. The executors do not steal focus or show composer input; relay state and step results remain visible in the dashboard.

The reciprocal launcher opts each runtime into the otherwise-disabled automation surface with `--hidden`, `--automation-port`, `--automation-token-file`, and `--automation-project-dir`. Each launch generates a new bearer token in its isolated executor state directory. The server binds only to `127.0.0.1` and exposes only `/status`, `/session`, and `/prompt`; every session and prompt is restricted to that executor's configured peer worktree.

To start both hidden apps manually without injecting a prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-reciprocal-tandem.ps1 -Role Both
```

Each app loads its preselected peer worktree:

- executor A must show `...\worktrees\copy-b`;
- executor B must show `...\worktrees\copy-a`.

If dashboard automation is unavailable, launch executor A without `--hidden` for diagnosis and send this fallback prompt once:

```text
Follow the injected TANDEM.md and execute exactly one reciprocal improvement invocation. Begin with the Claim command.
```

No manual message is normally needed in either app. On completion, A hands the durable turn token to B. The persisted schedules then poll at minute 07 for A and minute 37 for B each hour. A waiting executor exits before planning. If a quota limit interrupts a turn, the owner and `.tandem/reciprocal-checkpoint.md` remain on disk; that same executor resumes on a later hourly trigger after the rolling five-hour limit clears.

Use `/loop 1h <the same prompt>` only for a supervised temporary retry. Stop it with `/loop stop` before relying on the schedules; loops are not restored after an app restart.

## Shared human direction

Both executors see the same live file through their ignored `.tandem/shared-control` junction:

`C:\Users\huizh\Apps\Tandem Reciprocal\control\SHARED_DIRECTION.md`

Edit its General Direction and Human Notes directly. Add a feature safely while the process continues with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Add -Priority P1 -Text "Add Feature A with requirements X, Y, and Z"
```

Show the shared board with `-Action Show`. Executors prioritize queued human items, record the item in their durable checkpoint, mark it as a candidate after implementation, and mark it done only after the opposite executor independently accepts the commit. Self-selected work is recorded as a lower-priority `[AUTO]` item, so its result remains visible too. New items do not interrupt the item already in progress; they are picked up on a later working turn.

## Observe and recover

Show relay state from either worktree or the admin repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Status
git worktree list
git log --all --graph --decorate --oneline -20
```

`phase: paused` means an executor found no safe small task or needs a human decision. Inspect `lastSummary`. A human may restart from A only after cleaning both worktrees and understanding any partial commit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Reset -Force
```

Do not reset merely because a model quota is exhausted; `working` is intentionally resumable.

Recovery commands are normally issued by the role instructions:

- `Rollback` plus `CompleteRollback` creates an auditable revert when the other executor's candidate fails validation.
- `Abandon` stashes an unrecoverable uncommitted attempt and restores the same role to the confirmed stable base.
- `git show refs/tandem-relay/stable` identifies the last independently verified working commit even if the JSON state file is damaged.

## GitHub backup and promotion

Use **Backup to GitHub** in the reciprocal dashboard after an approved runtime promotion or at any other human-selected checkpoint. It pushes only `codex/reciprocal-a`, `codex/reciprocal-b`, and, when the remote accepts it, `refs/tandem-relay/stable`. The backup operation never pushes `master`, never force-pushes, and never changes the relay token or state. A non-fast-forward rejection is reported and audited for human resolution.

The equivalent manual branch-only backup is:

```powershell
git push -u origin codex/reciprocal-a
git push -u origin codex/reciprocal-b
```

Do not make remote availability part of the turn token, because a transient network failure should not corrupt local sequencing.

After a reviewed batch, select the branch containing `lastCompletedCommit`, run all checks plus `npm run dist:app`, stop the corresponding pinned executor, replace only its runtime directory with the reviewed build, and restart it. Keep the other executor pinned until the promoted build completes at least one clean turn. This creates a simple canary rollback path.

## Master reconciliation

`master` remains the trunk. Before starting or resuming a relay session, compare each reciprocal branch with `master`. If `codex/reciprocal-a` and `codex/reciprocal-b` are strict ancestors of `master`, fast-forward both branches to `master` and update `refs/tandem-relay/stable` to that same commit. If either branch has commits that `master` lacks, stop for human reconciliation instead of merging inside the relay.

After a reviewed reciprocal batch, use **Update main branch** in the dashboard and provide a human review comment. The gate refuses active turns and unvalidated candidates, pauses an idle relay, verifies the exact stable commit with `npm run typecheck` and `npm test`, merges stable into `master`, creates and pushes a sequential annotated `main-update-NNN` tag with the relay turn and completed wishlist IDs, fast-forwards both reciprocal branches, updates the stable ref/state, and resumes only if the flow paused the relay. A merge commit on `master` is fine; the fast-forward-only rule applies to the relay branches.

The dashboard presents the latest `main-update-NNN` identity, pending stable commit count, and the matching identities for candidate and promoted runtime builds. Remote pushes are atomic where master and its tag must move together, and no update path uses force.

Do not run D-round `master` work and reciprocal relay turns concurrently on overlapping files. If a D-round lands on `master` mid-batch, finish the active reciprocal batch, pause, reconcile against `master`, and then resume the relay.
