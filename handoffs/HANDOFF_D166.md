# Handoff D166 (Finish D165 compatible proof and produce an exact non-destructive upgrade plan)

## Review verdict

D165's incompatibility gate is correct and immediately prevents another stranded
artifact item. It is **not yet fully approved** because the required compatible
end-to-end proof and exact reviewable upgrade path were omitted.

This round is proof/deployment-readiness work. Do not implement W0021 or W0016, do not
overwrite the current W0021 Candidate Preview, and do not promote/integrate/push
anything automatically. Change code only if the required proof exposes a defect.

## Current real state to preserve

At review time:

- local admin `master`: `0e9db7b14332b6e84851e774f8df42ea282e7761`;
- reciprocal producer/copy-b and stable: `1fcc4cc8ff9fdd697c9472802f4569c4cf68668d`;
- pinned Executor A and B runtimes: `396a18da5e10bf0ca2481c6e3ab1ae2c633e55d6`;
- relay phase: `a-upgrade-pending`;
- canonical Candidate Preview: `1fcc4cc`, the W0021 product candidate awaiting human
  review;
- capability decision: incompatible (producer v0, runtime A v0, runtime B v0; v1
  required).

The `1fcc4cc` W0021 candidate does **not** contain D162-D165 and promoting it must not
be described as enabling artifact lifecycle v1. Do not replace its preview while it is
awaiting review.

## Required compatible live proof

D165 proved only the incompatible endpoint refusal. Run the compatible proof required
by HANDOFF_D165 using a wholly isolated topology:

1. scratch producer/relay advertises
   `candidatePreviewArtifactLifecycle: 1`;
2. scratch Executor A and B BUILD_INFO both advertise v1;
3. scratch dashboard status reports compatible and enables server-side artifact
   creation;
4. `/api/wishlist/artifact` creates exactly one app-owned P0 item bound to trusted
   artifact source `BBB` while producer/stable is distinct `AAA`;
5. Claim returns deterministic `artifactWork`;
6. zero-source completion runs D164 provenance plus GUI-smoke path, closes relay idle,
   leaves stable/last producer commit `AAA`, and marks the item DONE with `source=BBB`;
7. reject creates one exact follow-up, and repeated reject is idempotent;
8. no source candidate ref, runtime promotion, main integration, real board mutation,
   or manual DeclareArtifact/Resume/Abandon is used.

Use a temporary dashboard port/root and record exact commands, roots, SHAs, response
payloads, final board, relay refs/state, smoke evidence, and audit entries. A helper
unit test is not a substitute for this proof.

## Exact human-gated upgrade plan

Produce a machine-readable/readable upgrade manifest or dashboard status detail that
identifies a source commit containing the complete D162-D165 capability chain and the
steps still required to activate it. It must:

- identify the exact source commit and required capability v1;
- state that current stable/candidate `1fcc4cc` and runtimes `396a18d` do not contain
  it;
- preserve the current W0021 preview and review decision independently;
- sequence the future human-gated actions safely: finish W0021 review, reconcile a
  capability-containing source into both reciprocal worktrees through the existing
  human main/protocol gate, package/passive-test that exact source, verify BUILD_INFO
  advertises v1, then use the existing human runtime promotion/restart gate;
- state whether A and B must be promoted atomically (D165 currently requires both v1);
- refuse to claim the feature is operational until producer plus both runtime
  capability checks pass;
- avoid a force push, automatic branch reconciliation, automatic promotion, or
  overwriting `release\win-unpacked` while W0021 remains under review.

The active dashboard's incompatibility message should make the exact next safe human
action discoverable and explicitly warn that approving/promoting `1fcc4cc` alone will
not enable v1. If that information is not presently visible, add it without enabling
the artifact button.

## Regression checks

Retain and rerun:

- D165 incompatible endpoint proof: no item/audit mutation;
- compatible endpoint and full D164 lifecycle proof above;
- old/new/mixed/all-new capability matrix;
- existing artifact item blocked on capability loss;
- ordinary source lifecycle and W0016 plan metadata unchanged;
- dashboard node checks/nodecheck/endpoint tests;
- focused reciprocal tests, `npm run typecheck`, full `npm test`, and
  `git diff --check`.

## Completion

In `handoffs/D166_done.txt`, include the complete compatible proof and exact upgrade
manifest/status output. State clearly whether code changed or the round was proof-only.
Confirm the real W0021 preview, board, relay, worktrees, runtimes, local master remote,
and GitHub were not mutated by the proof.

If changes are required, commit with `D166-<n>:` subject(s). Commit the done marker
separately.
