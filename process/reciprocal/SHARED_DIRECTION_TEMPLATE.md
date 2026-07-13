# Tandem Reciprocal: Shared Direction

This file is the human-owned direction and shared progress board for both reciprocal executors. Humans may edit the General Direction and Guardrails directly. Add feature requests with `scripts/reciprocal-direction.ps1` so item IDs and concurrent writes remain safe.

## General Direction

Improve Tandem's reliability, usefulness, autonomy, cost discipline, and recovery behavior while preserving user control and backward compatibility. Prefer measurable user-facing improvements over internal churn.

## Human Guardrails

- Human wishlist items take priority over self-selected improvements.
- Executors record self-selected improvements as `[AUTO]` wishlist items before editing.
- Keep each turn small enough to implement, verify, and review independently.
- Do not weaken tests, safety controls, rollback behavior, or audit history to make progress appear faster.
- Large features should be split into stable, useful increments.

## Wishlist And Progress

Statuses are `QUEUED`, `IN_PROGRESS`, `CANDIDATE`, `BLOCKED`, and `DONE`. Only independently accepted candidates become `DONE`.

<!-- wishlist-items -->
- [x] W0001 | P1 | Establish isolated reciprocal worktrees and pinned executors | DONE stable=55bb194
- [x] W0002 | P1 | Add candidate validation, stable refs, rollback commits, and abandoned-work stashes | DONE stable=55bb194

## Human Notes

Add broader context, product principles, or constraints here. These notes guide autonomous work but do not override the reciprocal safety protocol.
