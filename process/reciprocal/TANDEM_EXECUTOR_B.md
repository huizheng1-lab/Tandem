# Executor B: Reciprocal Improvement Instructions

You are executor B. This selected project is target worktree A on branch `codex/reciprocal-a`. Your own pinned Tandem runtime and worktree B are outside this project and must never be modified.

Read `process/reciprocal/PROTOCOL.md` fully and follow it. Execute at most one normal improvement turn. The only allowed extra lifecycle in the same invocation is the explicit fully autonomous epic continuation returned by `Accept`/`Validate`; if used, produce exactly one next-step candidate and then stop.

Start every invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role B
```

If it reports `WAIT` or `PAUSED`, answer directly with the relay status and stop. For `VALIDATE`, do not launch a peer review session or edit files; run the validation gate below. Follow the recovery lifecycle in the shared protocol for `RESUME`. Only choose a new improvement in `working` phase.

For implementation in a Codex sandbox, run focused tests for changed behavior, `npm run typecheck`, and `git diff --check`. Keep the full suite in the plan verification list as `authoritative-only: npm test` so Tandem's authoritative runner executes it outside the producing sandbox; the opposite executor must repeat the full suite during `VALIDATE` before stable advances. Never weaken or skip a test that can run in the sandbox.

When `Claim` reports `VALIDATE`, run the two-step validation gate with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Validate -Role B -TandemHome $env:TANDEM_HOME
```

This command runs the mechanical checks directly, then performs exactly one read-only leader review. It accepts an approved candidate and rolls back a failed or revision-requested improvement candidate through the normal relay lifecycle.

If the validation output includes `autonomousContinuation.available=true`, and the output still shows `activeRole=B` and `phase=working`, continue immediately in this same invocation with only that returned wishlist item. Run the returned `startCommand`, implement exactly that one next step with the normal verification and completion-report discipline, and then stop after Tandem's app layer commits that one step candidate. Do not use this exception for plan-gated epics, non-epic work, final epic steps, or any output where `autonomousContinuation` is null.

After verification, submit a completion report with an exact `filesChanged` list and a concise summary. Do not run `git add`, `git commit`, wishlist `Candidate`, or relay `Complete` from inside the Codex sandbox; Tandem's app layer performs the guarded `relay:` candidate commit and completion from that report.

If no safe, useful task exists:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Pause -Role B -Summary "<why human direction is needed>"
```

If a manual recovery path has already created a rollback, verify it and complete the rollback:

```powershell
# Run focused tests, npm run typecheck, and git diff --check here; keep `authoritative-only: npm test` mandatory in authoritative verification and mechanical validation.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action CompleteRollback -Role B -Summary "rollback restored the stable tree; required checks passed"
```

If uncommitted implementation work cannot be recovered, preserve it and return to stable state with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Abandon -Role B -Summary "<why the approach was abandoned>"
```
