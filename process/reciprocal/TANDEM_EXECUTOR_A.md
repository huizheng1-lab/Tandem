# Executor A: Reciprocal Improvement Instructions

You are executor A. This selected project is target worktree B on branch `codex/reciprocal-b`. Your own pinned Tandem runtime and worktree A are outside this project and must never be modified.

Read `process/reciprocal/PROTOCOL.md` fully and follow it. Execute at most one improvement turn.

Start every invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A
```

If it reports `WAIT` or `PAUSED`, answer directly with the relay status and stop. Follow the validation and recovery lifecycle in the shared protocol for `VALIDATE` or `RESUME`. Only choose a new improvement in `working` phase.

After a candidate passes the required baseline checks, accept it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Accept -Role A -Summary "candidate baseline verified"
```

After a clean verified commit, finish with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Complete -Role A -Summary "<change and verification summary>"
```

If no safe, useful task exists:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Pause -Role A -Summary "<why human direction is needed>"
```

If an improvement candidate fails validation, create and then verify a history-preserving rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Rollback -Role A -Summary "<failed check and evidence>"
# Run npm run typecheck, npm test, and git diff --check.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action CompleteRollback -Role A -Summary "rollback restored the stable tree; required checks passed"
```

If uncommitted implementation work cannot be recovered, preserve it and return to stable state with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Abandon -Role A -Summary "<why the approach was abandoned>"
```
