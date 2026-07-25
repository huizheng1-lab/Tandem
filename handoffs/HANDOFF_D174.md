# Handoff D174 (Clear the authorized copy-b scratch-file blocker and finish D173 reconciliation)

## Objective

D173 successfully created and deployed the canonical Reciprocal dashboard source, but
the guarded main-update workflow stopped before reconciliation because eight old,
untracked worker diagnostic scripts remain in `copy-b`. The human has now explicitly
authorized removing those eight files. Clear only that known blocker in a recoverable
way, rerun the guarded reconciliation, and prove both Reciprocal source worktrees
incorporate D171-D173.

Do not implement or claim W0027. Do not promote, rebuild, copy, or restart the pinned
Executor A/B runtimes.

## Authorized blocker files

Only these exact files under
`C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-b` are authorized for removal
from the worktree:

- `.build-report.ps1`
- `.capture-passive-error.ps1`
- `.claim-round2-capture.ps1`
- `.passive-test-capture.ps1`
- `.read-captures.ps1`
- `.run-focused-test.ps1`
- `.run-typecheck.ps1`
- `.show-captures.ps1`

Before removing them from `copy-b`, preserve them recoverably under a clearly named
D174 archive directory outside every Git worktree, for example
`C:\Users\huizh\Apps\Tandem Reciprocal\control\reconciliation-backups\D174-copy-b-scratch`.
Record each original path, byte length, and SHA-256 before and after the move. Refuse
to proceed if a source path is not one of the exact eight names, resolves outside
`copy-b`, is a directory/reparse point, or its destination would overwrite an existing
file. Do not recursively delete or broadly clean the worktree.

## Required corrective work

1. Capture the current admin/copy-a/copy-b statuses and heads, relay state, runtime
   BUILD_INFO values, W0026/W0027 states, and the exact metadata/hashes of the eight
   authorized files.
2. Move only those eight files to the recoverable D174 archive. Verify `copy-b` is
   clean afterward. Preserve every other modified or untracked file everywhere,
   especially the admin worktree's `scripts/setup-reciprocal-tandem.ps1` change.
3. Rerun the existing guarded main-update/reconciliation workflow from D173. Use its
   normal preflight and non-force update path; do not substitute manual branch
   rewriting, reset, stash, checkout-discard, force-push, or an untracked-copy hack.
4. If the workflow succeeds, prove `codex/reciprocal-a` and
   `codex/reciprocal-b` contain D171, D172, and D173 and record their exact heads plus
   the reconciled relay stable SHA.
5. If a different guard blocks reconciliation, stop without bypassing it and report
   the exact new blocker with file/status evidence. Do not remove or alter anything
   else without fresh human authorization.

## Runtime and queue boundary

- Do not invoke `promote-reciprocal-runtime.ps1` or any equivalent runtime promotion.
- Do not rebuild/copy/restart either live Executor runtime.
- Keep W0026 `DONE` and W0027 `QUEUED`; do not dispatch or claim W0027 in this round.
- Leave any runtime update as a separate, human-visible approval step.

## Acceptance checks

- All eight authorized scratch scripts exist in the recoverable archive with matching
  SHA-256 hashes, and none remains in `copy-b`.
- No other `copy-b` path changed as part of blocker cleanup.
- The guarded reconciliation either succeeds normally or stops at a concretely
  evidenced new guard; no safety control is bypassed.
- On success, both reciprocal branches/worktrees contain D171-D173 by ancestor/log
  proof, and relay state is coherent and idle with no owner.
- Admin unrelated changes remain byte-for-byte/status-preserved.
- Runtime BUILD_INFO values and processes remain unchanged.
- W0026 remains `DONE`; W0027 remains `QUEUED` and unclaimed.

Run and record the reconciliation workflow's focused checks plus:

- canonical dashboard `node --check` for `server.mjs` and `lib.mjs`;
- canonical dashboard `approval-flow.e2e.mjs` and helper tests;
- `scripts/deploy-reciprocal-dashboard.ps1 -VerifyOnly`;
- live `GET http://127.0.0.1:4782/api/status`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## Safety constraints

- The human authorization applies only to the exact eight listed scratch files.
- Preserve them recoverably; do not permanently erase them.
- Never touch or commit the unrelated admin
  `scripts/setup-reciprocal-tandem.ps1` change or unrelated untracked files.
- No broad cleanup, recursive deletion, reset, stash, force-push, or discarded changes.
- Do not edit application/product behavior, W0026, or W0027.
- Do not create a Reciprocal product candidate or implementation commit.

## Completion

Commit only the D174 reconciliation evidence/marker required by the established
handoff workflow, using `D174-<n>:` subject(s). The done marker must list:

- the archive path and before/after hash table for all eight files;
- all statuses/SHAs before and after;
- exact guarded reconciliation command and result;
- ancestor proof for D171-D173 if successful;
- proof unrelated admin changes and runtime builds/processes were preserved;
- all acceptance-check results;
- explicit confirmation that W0027 was not claimed or implemented.
