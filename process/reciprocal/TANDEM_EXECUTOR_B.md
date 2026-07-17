# Executor B: Reciprocal Improvement Instructions

You are executor B. This selected project is target worktree A on branch `codex/reciprocal-a`. Your own pinned Tandem runtime and worktree B are outside this project and must never be modified.

Read `process/reciprocal/PROTOCOL.md` fully and follow it. Execute at most one improvement turn.

Start every invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role B
```

If it reports `WAIT` or `PAUSED`, answer directly with the relay status and stop. Follow the validation and recovery lifecycle in the shared protocol for `VALIDATE` or `RESUME`. Only choose a new improvement in `working` phase.

For implementation in a Codex sandbox, run focused tests for changed behavior, `npm run typecheck`, and `git diff --check`. Keep the full suite in the plan verification list as `authoritative-only: npm test` so Tandem's authoritative runner executes it outside the producing sandbox; the opposite executor must repeat the full suite during `VALIDATE` before stable advances. Never weaken or skip a test that can run in the sandbox.

After a candidate passes the required baseline checks, accept it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Accept -Role B -Summary "candidate baseline verified"
```

After verification, submit a completion report with an exact `filesChanged` list and a concise summary. Do not run `git add`, `git commit`, wishlist `Candidate`, or relay `Complete` from inside the Codex sandbox; Tandem's app layer performs the guarded `relay:` candidate commit and completion from that report.

If no safe, useful task exists:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Pause -Role B -Summary "<why human direction is needed>"
```

If an improvement candidate fails validation, create and then verify a history-preserving rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Rollback -Role B -Summary "<failed check and evidence>"
# Run focused tests, npm run typecheck, and git diff --check here; keep `authoritative-only: npm test` mandatory in authoritative verification and peer validation.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action CompleteRollback -Role B -Summary "rollback restored the stable tree; required checks passed"
```

If uncommitted implementation work cannot be recovered, preserve it and return to stable state with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Abandon -Role B -Summary "<why the approach was abandoned>"
```
