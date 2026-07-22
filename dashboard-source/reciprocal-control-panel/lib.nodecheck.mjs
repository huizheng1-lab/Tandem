import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalBoundaryPlan,
  approvalFailureDetail,
  approvalCompletionRelayAction,
  approvalRemainingActions,
  candidatePreviewArtifactCapabilityStatus,
  parseDirection,
  recoveryPlan,
  rejectedCandidateOriginRetirement,
  rejectedCandidateRelayAction,
  rejectedCandidateWishlist,
  reviewOriginItem,
  validateAlreadyPromotedAUpgradeRecovery,
} from "./lib.mjs";

test("parses shared direction and wishlist metadata", () => {
  const result = parseDirection(`# Board\n\n## General Direction\n\nBuild carefully.\n\n## Human Guardrails\n\n- Verify.\n\n## Wishlist And Progress\n\n- [ ] W0003 | P2 | Add remote control | QUEUED added=now\n- [x] W0001 | P1 | Set up copies | DONE stable=abc1234\n\n## Human Notes\n\nKeep it legible.`);
  assert.equal(result.general, "Build carefully.");
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], { done: false, id: "W0003", priority: "P2", text: "Add remote control", status: "QUEUED", detail: "added=now" });
});

test("builds an auditable rollback plan for a failed candidate", () => {
  const plan = recoveryPlan({ phase: "validating", candidateKind: "improvement", activeRole: "B" }, { a: { path: "copy-a" }, b: { path: "copy-b" } });
  assert.equal(plan.workspace, "copy-a");
  assert.match(plan.commands[0], /-Action Rollback -Role B/);
  assert.ok(plan.commands.includes("npm test"));
});

test("approval completion closes the A-upgrade gate instead of resuming it", () => {
  assert.deepEqual(approvalCompletionRelayAction("a-upgrade-pending"), {
    action: "CompleteAUpgrade",
    role: "A",
    force: true,
    workspace: "a",
    step: "a-upgrade-completed",
  });

  assert.deepEqual(approvalCompletionRelayAction("working"), {
    action: "Resume",
    role: null,
    force: false,
    step: "relay-resumed",
  });
});

test("approval flow treats idle A-upgrade as a direct boundary and closes through passive copy-a", () => {
  const boundary = approvalBoundaryPlan({
    phase: "a-upgrade-pending",
    activeRole: null,
    nextRole: "A",
    turn: 2,
  });
  assert.deepEqual(boundary, {
    action: "complete-a-upgrade-boundary",
    interruptedPhase: "a-upgrade-pending",
    pausedByFlow: true,
    forced: false,
    step: "a-upgrade-boundary",
    detail: "Relay already at A-upgrade approval boundary; turn 2 remains gated.",
  });
  const completion = approvalCompletionRelayAction(boundary.interruptedPhase);
  assert.equal(completion.action, "CompleteAUpgrade");
  assert.equal(completion.workspace, "a");
  assert.equal(completion.role, "A");
  assert.equal(completion.force, true);
});

test("approval boundary preserves ordinary paused and working approval behavior", () => {
  assert.equal(approvalBoundaryPlan({ phase: "working", activeRole: "B" }), null);
  assert.equal(approvalBoundaryPlan({ phase: "idle", activeRole: null }), null);
  assert.equal(approvalBoundaryPlan({ phase: "paused", pausedFromPhase: "working", activeRole: null }), null);
});

test("already-promoted A-upgrade recovery closes only matching paused gate", () => {
  const sourceSha = "ead38ad2692d2a5641ce3cdaed684ab75ebf2db1";
  assert.deepEqual(validateAlreadyPromotedAUpgradeRecovery({
    state: {
      phase: "paused",
      pausedFromPhase: "a-upgrade-pending",
      activeRole: null,
      stableCommit: sourceSha,
    },
    sourceSha,
    review: { decision: "approve" },
    buildA: { sourceSha },
    buildB: { sourceSha },
  }), {
    action: "CompleteAUpgrade",
    role: "A",
    force: true,
    workspace: "a",
    step: "a-upgrade-recovered",
  });
});

test("already-promoted A-upgrade recovery rejects non-matching or mutating states", () => {
  const sourceSha = "ead38ad2692d2a5641ce3cdaed684ab75ebf2db1";
  const base = {
    state: {
      phase: "paused",
      pausedFromPhase: "a-upgrade-pending",
      activeRole: null,
      stableCommit: sourceSha,
    },
    sourceSha,
    review: { decision: "approve" },
    buildA: { sourceSha },
    buildB: { sourceSha },
  };
  assert.throws(() => validateAlreadyPromotedAUpgradeRecovery({ ...base, state: { ...base.state, pausedFromPhase: "working" } }), /pausedFromPhase=a-upgrade-pending/);
  assert.throws(() => validateAlreadyPromotedAUpgradeRecovery({ ...base, state: { ...base.state, activeRole: "A" } }), /no active reciprocal turn/);
  assert.throws(() => validateAlreadyPromotedAUpgradeRecovery({ ...base, state: { ...base.state, stableCommit: "0000000000000000000000000000000000000000" } }), /stable SHA mismatch/);
  assert.throws(() => validateAlreadyPromotedAUpgradeRecovery({ ...base, buildA: { sourceSha: "0000000000000000000000000000000000000000" } }), /Executor A/);
  assert.throws(() => validateAlreadyPromotedAUpgradeRecovery({ ...base, review: { decision: "reject" } }), /approved review/);
});

test("approval completion reports passive copy-a recovery after promoted A-upgrade failures", () => {
  const flow = {
    interruptedPhase: "a-upgrade-pending",
    pausedByFlow: true,
    relayResumed: false,
    executorsStopped: true,
    promoted: true,
    executorsRestarted: true,
    steps: [{ step: "review-recorded" }],
  };

  assert.deepEqual(approvalRemainingActions(flow), [
    "run CompleteAUpgrade from passive copy-a (codex/reciprocal-a) to close the already-promoted A-upgrade gate",
  ]);
  assert.match(approvalFailureDetail(flow, "CompleteAUpgrade failed"), /runtime promotion succeeded/);
  assert.match(approvalFailureDetail(flow, "CompleteAUpgrade failed"), /passive copy-a \(codex\/reciprocal-a\)/);
});

test("turns a candidate rejection into a highest-priority implementation wishlist item", () => {
  const result = rejectedCandidateWishlist(
    { sourceSha: "abcdef1234567890" },
    { id: "W0016" },
    "The Telegram reply never updates.\nShow the real edit failure.",
  );
  assert.equal(result.priority, "P0");
  assert.match(result.text, /^Fix rejected candidate abcdef1 for W0016\./);
  assert.match(result.text, /The Telegram reply never updates\. Show the real edit failure\./);
  assert.equal(result.marker, "[review-rejection:abcdef1234567890]");
  assert.ok(result.text.endsWith(result.marker));
});

test("releases only the matching rejected candidate upgrade gate", () => {
  assert.deepEqual(rejectedCandidateRelayAction({
    phase: "a-upgrade-pending",
    activeRole: null,
    stableCommit: "abcdef1234567890",
  }, "abcdef1234567890"), {
    action: "CompleteAUpgrade",
    role: "A",
    force: true,
    workspace: "a",
  });
  assert.equal(rejectedCandidateRelayAction({
    phase: "a-upgrade-pending",
    activeRole: null,
    stableCommit: "different",
  }, "abcdef1234567890"), null);
  assert.equal(rejectedCandidateRelayAction({
    phase: "working",
    activeRole: "A",
    stableCommit: "abcdef1234567890",
  }, "abcdef1234567890"), null);
});

test("maps rejected preview origins through explicit metadata", () => {
  const direction = parseDirection(`# Board

## Wishlist And Progress

- [x] W0020 | P0 | Build preview | DONE artifact=candidate-preview source=bbbbbbb evidence=abc123 role=A completed=now
- [ ] W0021 | P0 | Fix rejected preview | QUEUED added=now
`);
  const origin = reviewOriginItem(direction, "bbbbbbb");
  assert.equal(origin.id, "W0020");
  assert.equal(rejectedCandidateOriginRetirement(origin, "W0021"), null);

  const stale = { id: "W0099", done: false, status: "IN_PROGRESS", detail: "artifact=candidate-preview source=bbbbbbb role=A" };
  assert.deepEqual(rejectedCandidateOriginRetirement(stale, "W0021"), {
    action: "Retire",
    id: "W0099",
    note: "rejected-review-followup-W0021",
  });
  assert.deepEqual(rejectedCandidateRelayAction({
    phase: "paused",
    pausedFromPhase: "working",
    activeRole: "A",
    baseCommit: "aaaaaaa",
    stableCommit: "aaaaaaa",
    candidateCommit: null,
    rollbackCommit: null,
  }, "bbbbbbb", stale), {
    action: "CompleteArtifact",
    role: "A",
    force: false,
    workspace: "b",
  });
});

test("candidate preview artifacts require producer and both pinned runtimes to advertise capability", () => {
  const producer = { capabilities: { candidatePreviewArtifactLifecycle: 1 }, path: "copy-b", sha: "abcdef1234567890" };
  const upgradedA = { path: "executor-a", buildInfo: { sourceSha: "aaaaaa1234567890", reciprocalCapabilities: { candidatePreviewArtifactLifecycle: 1 } } };
  const upgradedB = { path: "executor-b", buildInfo: { sourceSha: "bbbbbb1234567890", reciprocalCapabilities: { candidatePreviewArtifactLifecycle: 1 } } };

  assert.equal(candidatePreviewArtifactCapabilityStatus({ producer, runtimeA: upgradedA, runtimeB: upgradedB }).compatible, true);

  const oldExecutor = candidatePreviewArtifactCapabilityStatus({ producer, runtimeA: { path: "executor-a", buildInfo: { sourceSha: "old" } }, runtimeB: upgradedB });
  assert.equal(oldExecutor.compatible, false);
  assert.match(oldExecutor.message, /Executor A runtime has v0/);

  const mixedExecutors = candidatePreviewArtifactCapabilityStatus({ producer, runtimeA: upgradedA, runtimeB: { path: "executor-b", buildInfo: { sourceSha: "old" } } });
  assert.equal(mixedExecutors.compatible, false);
  assert.match(mixedExecutors.message, /Executor B runtime has v0/);

  const oldProducer = candidatePreviewArtifactCapabilityStatus({ producer: { path: "copy-b", capabilities: {} }, runtimeA: upgradedA, runtimeB: upgradedB });
  assert.equal(oldProducer.compatible, false);
  assert.match(oldProducer.message, /Producer relay has v0/);
});
