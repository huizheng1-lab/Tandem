# Two-Copy Reciprocal Tandem

This setup uses two source worktrees, two local branches, two pinned packaged executors, two isolated `TANDEM_HOME` directories, and two isolated Electron user-data directories. The direction remains crossed for self-modification safety, but the roles are no longer symmetric.

- Executor A is the sole producer. It runs from runtime A and edits worktree B (`codex/reciprocal-b`).
- Executor B is a passive build/launch test target. It runs from runtime B against worktree A (`codex/reciprocal-a`) and does no agentic wishlist work.

The launcher protects the admin repository, the executor's own source worktree, both runtimes, and both state stores. Only the selected target worktree and shared control directory are writable through the reciprocal flow.

## Setup

Run from the admin repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-reciprocal-tandem.ps1 -CopyEnv
```

The default root is `C:\Users\huizh\Apps\Tandem Reciprocal`. Setup creates both worktrees and runtimes, writes A's producer schedule on copy B, and intentionally writes an empty schedule file for copy A so B does not poll for wishlist work.

## Start and Kickstart

The dashboard **Kickstart** button starts both hidden runtimes, waits for their loopback automation endpoints, and injects the producer prompt only into executor A. B may be running as a passive process, but it is not prompted on a cadence.

Manual hidden launch:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-reciprocal-tandem.ps1 -Role Both
```

A targets `...\worktrees\copy-b`. B targets `...\worktrees\copy-a` only for passive build/launch checks.

Fallback prompt for A only:

```text
Follow the injected TANDEM.md and execute one reciprocal improvement invocation as Executor A. Begin with the Claim command. If the relay reports PASSIVE_TEST, run the passive test command instead of starting new work. If it reports A_UPGRADE_PENDING, stop for the human gate.
```

## Lifecycle

1. A claims work with `Claim -Role A`.
2. A implements one narrow candidate on copy B and Tandem's app layer commits it.
3. The relay enters `passive-testing`.
4. The passive copy A is fast-forwarded to the candidate and checked with `PassiveTest -Role A`.
5. Passing passive checks advance stable and enter `a-upgrade-pending`.
6. A's runtime is rebuilt from that same verified commit only after human confirmation, using `promote-reciprocal-runtime.ps1 -TargetRole A`.
7. `CompleteAUpgrade -Role A -Force` releases the relay back to `idle`.

## Shared Human Direction

Both copies see the shared board through `.tandem/shared-control/SHARED_DIRECTION.md`. Add human work with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Add -Priority P1 -Text "Add Feature A with requirements X, Y, and Z"
```

Epics still use one candidate per plan or step. Fully autonomous epic continuation is recorded for A, but the D151 A-upgrade gate remains human-gated before the next producer lifecycle can start.

## Observe and Recover

Show relay state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Status
git worktree list
git log --all --graph --decorate --oneline -20
```

`phase: passive-testing` means A's candidate is waiting for mechanical passive checks. `phase: a-upgrade-pending` means stable advanced after passive checks, but A's runtime still needs human-confirmed promotion. `phase: paused` means a human decision or recovery is required.

`Reset -Force` is reserved for deliberate human recovery. Do not reset merely because a model quota is exhausted; A's `working` turns are resumable.

## Backup, Promotion, And Master

Branch backup remains separate from relay sequencing and must never force-push. Runtime promotion is human-gated. Use `scripts/promote-reciprocal-runtime.ps1 -TargetRole A -DryRun` to inspect the A promotion target before replacing runtime files.

`master` remains trunk. Pause or finish the reciprocal state before integrating stable work into `master`, then fast-forward both reciprocal branches to the reconciled master before A claims more work.
