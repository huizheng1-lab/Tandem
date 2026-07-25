# Handoff D165 (D164 exposes Build latest for review before the active Reciprocal executor supports the artifact protocol)

## Review verdict

D164's isolated artifact lifecycle and real GUI smoke are technically sound, but D164
is **not operationally approved**. The active control plane and execution plane are at
different protocol versions, and the dashboard currently exposes an action that can
strand another wishlist item.

Do not implement W0021 or W0016 in this round. Do not bypass runtime-promotion or
main-integration human gates.

## Confirmed live mismatch

Immediately after D164:

- The external dashboard is active and shows **Build latest for review**. Its endpoint
  can create a P0 item with `artifact=candidate-preview` metadata.
- Pinned Executor A and B runtimes are still built from `396a18d` (D123 promotion).
- Active `copy-b` is at `1fcc4cc`, and repository search there finds no
  `artifactWork`, `Get-NextArtifactInstruction`, `CompleteArtifact`, or
  `ArtifactComplete` implementation.
- Relay is currently `a-upgrade-pending`, stable `1fcc4cc`; that pending runtime build
  does not contain D164 either.

Therefore the visible dashboard action can queue an item that the active scheduled
executor cannot understand or complete. The old executor may treat it as ordinary
source work or leave it QUEUED/working, recreating the W0020 failure.

D164's done report said the external dashboard was active, but it did not state that
the executor/app-layer protocol remained inactive or protect the button/endpoint from
that mismatch.

## Required capability negotiation

Introduce an explicit versioned capability for this workflow, for example
`candidatePreviewArtifactLifecycle: 1`. Do not infer support by grepping files,
comparing arbitrary SHAs, or assuming that a newer version is compatible.

1. The version-controlled relay/app layer must advertise supported reciprocal
   capabilities in a machine-readable Status/automation response.
2. The dashboard must read the capability from the **actual active producer path and
   pinned Executor A runtime**, not local master alone.
3. Enable both the dashboard button and `/api/wishlist/artifact` only when all required
   active components advertise a compatible version. The endpoint must enforce the
   gate server-side even if the UI is bypassed.
4. When unsupported, show a precise non-destructive state such as "Artifact build
   workflow requires Reciprocal executor upgrade" with the active runtime SHA,
   worktree SHA/capability, and required capability version. Do not create a wishlist
   item.
5. If an artifact item already exists while capability is absent, surface it as
   blocked-by-upgrade and prevent old Executor A from claiming it as ordinary work.
   Preserve it for recovery; do not silently remove or convert it.

## Deployment path must remain human-gated

Prepare a coherent, reviewable protocol-upgrade path that brings these D162-D164
pieces together in the Reciprocal producer worktree/runtime:

- direction/relay artifact actions and claim payload;
- app-layer completion and real GUI smoke script;
- completion-report schema support;
- external dashboard endpoint/UI/rejection logic.

Do not promote or integrate automatically. Stop at the existing human gate with clear
instructions/evidence identifying the exact build that contains the capability. A
human must still approve runtime promotion and main/GitHub integration separately.

The dashboard may offer the existing gated update flow, but it must never imply that
promoting stable `1fcc4cc` enables D164 unless that exact candidate actually contains
the capability.

## Compatibility behavior

- Old runtimes/worktrees continue ordinary source wishlist behavior unchanged.
- A new dashboard with an old executor must safely disable/reject artifact creation.
- A new executor with an old dashboard must not self-create artifact jobs.
- Mixed A/B runtime versions must not enable the action if the promotion/restart flow
  would leave the system inconsistent.
- Capability loss after an item is queued must block safely before Claim/Start and
  provide recovery guidance.

## Tests and live proof

Add focused tests for:

1. old dashboard/new executor, new dashboard/old executor, mixed runtimes, and all-new
   compatible topology;
2. server-side `/api/wishlist/artifact` refusal when capability is absent, with no
   board mutation or audit claiming creation;
3. UI disabled state and exact upgrade message;
4. existing declared artifact item remains preserved/blocked and cannot be selected as
   ordinary work by an incapable claim path;
5. compatible topology still runs D164's distinct-SHA artifact completion, GUI smoke,
   idle closure, rejection follow-up, and idempotence;
6. ordinary W0021-style source lifecycle and W0016 plan metadata remain unchanged.

Perform two isolated live proofs:

- **current-like mismatch:** dashboard D165 + executor/worktree without capability;
  button/endpoint refuse, no item is added, relay/board unchanged;
- **compatible scratch topology:** all components advertise capability v1; artifact
  item is created and completes through D164 end-to-end.

Also inspect the real current environment read-only and record active runtime SHA,
copy-b SHA/capability, relay phase/stable, dashboard capability decision, and exact
human-gated next action. Do not mutate real W0021 or W0016.

Run dashboard node checks/nodecheck/endpoint tests, focused reciprocal tests,
`npm run typecheck`, full `npm test`, and `git diff --check`.

## Completion record

In `handoffs/D165_done.txt`, include:

- capability name/version and every advertising/consuming component;
- mismatch and compatible live-proof results;
- proof that the real dashboard cannot queue an unsupported artifact item;
- exact current active and candidate SHAs;
- the human action still required before the feature becomes operational;
- confirmation that no runtime was promoted and no master/GitHub integration occurred.

Commit implementation with `D165-<n>:` subject(s), then commit the done marker
separately.
