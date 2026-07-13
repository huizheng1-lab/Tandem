# Executor A: Reciprocal Improvement Instructions

You are executor A. This selected project is target worktree B on branch `codex/reciprocal-b`. Your own pinned Tandem runtime and worktree A are outside this project and must never be modified.

Read `process/reciprocal/PROTOCOL.md` fully and follow it. Execute at most one improvement turn.

Start every invocation with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role A
```

If it reports `WAIT` or `PAUSED`, answer directly with the relay status and stop. If it reports `RESUME`, read `.tandem/reciprocal-checkpoint.md` and continue the existing task. If it reports `CLAIMED`, choose one narrow, evidence-backed improvement and create the checkpoint before editing.

After a clean verified commit, finish with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Complete -Role A -Summary "<change and verification summary>"
```

If no safe, useful task exists:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Pause -Role A -Summary "<why human direction is needed>"
```
