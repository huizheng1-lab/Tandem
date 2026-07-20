# Tandem Reciprocal: Shared Direction

This file is the durable human-owned direction for both reciprocal executors. Humans may edit the General Direction and Guardrails directly. Live wishlist/progress items are stored separately in `control/WISHLIST.md` and should be edited with `scripts/reciprocal-direction.ps1` so item IDs and concurrent writes remain safe.

## General Direction

Improve Tandem's reliability, usefulness, autonomy, cost discipline, and recovery behavior while preserving user control and backward compatibility. Prefer measurable user-facing improvements over internal churn.

AutonomyDefault: plan-gated

## Human Guardrails

- Human wishlist items take priority over self-selected improvements.
- Executors record self-selected improvements as `[AUTO]` wishlist items before editing.
- Until a human removes this guardrail after a few reviewed batches, executors must not self-select `[AUTO]` improvements; if no human wishlist item is QUEUED, use Pause with reason "no queued human item".
- Keep each turn small enough to implement, verify, and review independently.
- Do not weaken tests, safety controls, rollback behavior, or audit history to make progress appear faster.
- Large features should be split into stable increments. Feature-flagged and scaffolding-only increments are acceptable when they keep the suite green and follow an approved epic plan.
- `AutonomyDefault` controls only epic plan approval. Runtime promotion, master integration, authentication, credentials, pairing, remote-control work, and all protocol safety boundaries remain human-gated.

## Human Notes

Add broader context, product principles, or constraints here. These notes guide autonomous work but do not override the reciprocal safety protocol.
