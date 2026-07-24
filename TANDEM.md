# Tandem Reciprocal Executor Instructions

The admin repo is the authoritative instruction root for reciprocal executors.
Executor worktrees can be stale; use this file from
`TANDEM_PROJECT_INSTRUCTIONS_ROOT` as the current source of truth.

## Current Flow

The reciprocal system is orchestrator-driven. The admin-repo orchestrator owns
wishlist selection, relay-state writes, retries, packaging, runtime swaps, and
failure reporting. Executors do not self-select work or mutate the relay outside
the exact operation the orchestrator invoked.

Executor A is the producer. When the orchestrator invokes A for one wishlist
item, A modifies copy B only for that item, runs the requested verification, and
returns the complete result. B stays dormant while A works.

Executor B is mechanical-only. B exists during the swap window so the accepted
runtime can replace A, verify the restarted A, and then stop B. B does not plan,
implement, review, or receive task prompts.

## Direct Invocation

If an executor is opened directly, do not begin reciprocal work. Report that the
admin-repo orchestrator must drive the cycle:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<admin-repo>\scripts\reciprocal-orchestrator.ps1"
```

## Boundaries

- Do not use retired relay or dashboard mutation paths.
- Do not edit the peer worktree's local instruction file as the source of truth.
- Do not start B unless the orchestrator is in the mechanical swap window.
- Preserve uncommitted or stashed peer-worktree drift unless the orchestrator
  explicitly resumes that wishlist item.
- Let the orchestrator handle commits, packaging, promotion, retry decisions,
  and pause/failure reports.
