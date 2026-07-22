# Executor A: Reciprocal Producer Instructions

You are executor A. This selected project is target worktree B on branch `codex/reciprocal-b`. Your own pinned Tandem runtime and worktree A are outside this project and must never be modified.

Read `process/reciprocal/PROTOCOL.md` fully and follow it. A is the only reciprocal producer. Execute at most one normal A lifecycle unless the relay reports a passive or human-gated step instead.

Start every invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A
```

Interpret the result:

- `CLAIMED`: proceed with one `working` producer lifecycle.
- `RESUME`: continue the same interrupted A lifecycle from `.tandem/reciprocal-checkpoint.md`.
- `PASSIVE_TEST`: do not start new work. Switch to copy A and run the returned `PassiveTest` command.
- `A_UPGRADE_PENDING`: stop for the human A-runtime promotion gate only for a final source-changing runtime replacement. You may report the `PrepareAUpgrade -DryRun` command.
- `WAIT` or `PAUSED`: answer with the relay status and stop. A machine-created paused-from-idle breadth/planning pause is recoverable by the supervisor and is not a request for new human planning metadata.

For implementation, claim a shared-direction item with `scripts/reciprocal-direction.ps1 -Action Start -Id <id> -Role A`, keep `.tandem/reciprocal-checkpoint.md` current, implement a narrow one-commit candidate, and run focused checks plus `npm run typecheck` and `git diff --check`. If the highest-priority human item is ordinary `QUEUED` work that is broad, architectural, or missing epic metadata, first run `NormalizeQueued -Id <id>` and create `process/reciprocal/epics/<ID>-plan.md`; preserve the same wishlist ID/text/priority and do not implement product changes in the plan-only turn. Keep `authoritative-only: npm test` in the plan verification list so Tandem's authoritative runner executes the full suite outside the sandbox.

After verification, submit a completion report with exact `filesChanged` and a concise summary. Do not run `git add`, `git commit`, wishlist `Candidate`, or relay `Complete` from inside Codex; Tandem's app layer performs those guarded actions.

If no human item exists or the next exact step needs new credentials, pairing, permissions, sandbox weakening, destructive action, paid/public publication, or final live-runtime promotion:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Pause -Role A -Summary "<why human direction is needed>"
```

If a passive candidate is ready, run from copy A; this checks the candidate and produces the canonical Launch Candidate package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action PassiveTest -Role A
```

If the relay is at the A-upgrade gate, prepare the human action:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action PrepareAUpgrade -Role A -DryRun
```
