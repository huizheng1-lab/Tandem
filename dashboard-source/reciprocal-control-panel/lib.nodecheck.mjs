import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalBoundaryPlan,
  approvalFailureDetail,
  approvalCompletionRelayAction,
  approvalFlowRuntimeTopology,
  approvalRemainingActions,
  candidatePreviewArtifactCapabilityStatus,
  classifyReciprocalGate,
  expectedRuntimeTopology,
  loadReciprocalTaxonomy,
  nextQueuedHumanItem,
  parseDirection,
  recoveryPlan,
  rejectedCandidateOriginRetirement,
  rejectedCandidateRelayAction,
  rejectedCandidateWishlist,
  queuedItemNeedsPlanning,
  reciprocalGateTaxonomy,
  reviewOriginItem,
  runtimeTopologyHealth,
  validateAlreadyPromotedAUpgradeRecovery,
} from "./lib.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("parses shared direction and wishlist metadata", () => {
  const result = parseDirection(`# Board\n\n## General Direction\n\nBuild carefully.\n\n## Human Guardrails\n\n- Verify.\n\n## Wishlist And Progress\n\n- [ ] W0003 | P2 | Add remote control | QUEUED added=now\n- [x] W0001 | P1 | Set up copies | DONE stable=abc1234\n\n## Human Notes\n\nKeep it legible.`);
  assert.equal(result.general, "Build carefully.");
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], { done: false, id: "W0003", priority: "P2", text: "Add remote control", status: "QUEUED", detail: "added=now" });
});

test("D175 classifies broad queued work and paused-from-idle planning stops as auto-recoverable", () => {
  const direction = parseDirection(`# Board

## Wishlist And Progress

- [ ] W0027 | P0 | Comprehensive reciprocal workflow repair | QUEUED added=now
- [ ] W0023 | P1 | Later item | QUEUED added=now
`);
  const item = nextQueuedHumanItem(direction);
  assert.equal(item.id, "W0027");
  assert.equal(queuedItemNeedsPlanning(item), true);
  assert.deepEqual(classifyReciprocalGate({ item }), {
    category: reciprocalGateTaxonomy.autoRecoverablePrerequisite,
    code: "auto-recoverable-prerequisite",
    retryable: true,
    nextAction: "normalize-plan-reconcile-or-retry",
  });
  assert.equal(classifyReciprocalGate({
    state: { phase: "paused", pausedFromPhase: "idle", lastSummary: "W0027 rejected as too broad and missing epic metadata" },
  }).category, reciprocalGateTaxonomy.autoRecoverablePrerequisite);
});

test("D175 keeps explicit authority gates hard and active owners waiting", () => {
  assert.equal(classifyReciprocalGate({ reason: "explicit human pause requested" }).category, reciprocalGateTaxonomy.hardHumanGate);
  assert.equal(classifyReciprocalGate({
    item: {
      status: "IN_PROGRESS",
      detail: "epic=true autonomy=full authority=permission action=request-new-network-access checkpoint=step-2 resume=after-approval",
    },
  }).category, reciprocalGateTaxonomy.hardHumanGate);
  assert.notEqual(classifyReciprocalGate({
    item: {
      status: "IN_PROGRESS",
      detail: "epic=true autonomy=full authority=permission action=request-new-network-access checkpoint=step-2 resume=after-approval authorityStatus=approved",
    },
  }).category, reciprocalGateTaxonomy.hardHumanGate);
  assert.notEqual(classifyReciprocalGate({
    item: {
      status: "CANDIDATE",
      detail: "epic=true authority=permission action=request-new-network-access checkpoint=step-2 resume=after-approval authorityStatus=consumed",
    },
  }).category, reciprocalGateTaxonomy.hardHumanGate);
  assert.equal(classifyReciprocalGate({
    item: {
      status: "QUEUED",
      text: "Discover Python, permission state, sandbox helper, and never weaken sandboxing",
      detail: "QUEUED",
    },
  }).category, reciprocalGateTaxonomy.autoRecoverablePrerequisite);
  assert.equal(classifyReciprocalGate({ state: { phase: "working", activeRole: "A" } }).category, reciprocalGateTaxonomy.waitingNotBlocked);
  assert.equal(classifyReciprocalGate({ reason: "endpoint timeout", attemptCount: 3 }).code, "repeated-genuine-blocker");
});

test("D177 loads canonical taxonomy fixtures and classifies machine pauses distinctly from human pauses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reciprocal-taxonomy-"));
  try {
    const file = path.join(dir, "gate-taxonomy.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      categories: {
        autoRecoverablePrerequisite: "fixture-auto",
        hardBlocked: "fixture-hard",
        hardHumanGate: "fixture-human",
        waitingNotBlocked: "fixture-wait",
      },
      codes: {
        idleSupervisorDispatch: "fixture-idle",
        humanAuthorityRequired: "fixture-authority",
        explicitHumanPause: "fixture-human-pause",
        progressWait: "fixture-progress",
        endpointUnavailable: "fixture-endpoint",
        leaseHeld: "fixture-lease",
        repeatedGenuineBlocker: "fixture-repeat",
        recoverPausedIdlePrerequisite: "fixture-recover",
        sourceReconciliationPending: "fixture-source",
      },
      pauseOrigins: { human: "human", machine: "machine", unknown: "unknown" },
      displayStates: {
        working: "fixture-working",
        testing: "fixture-testing",
        waitingForReview: "fixture-review",
        humanPaused: "fixture-human-paused",
        machineBlocked: "fixture-machine-blocked",
        hardBlocked: "fixture-hard-blocked",
        retryBackoff: "fixture-backoff",
        retryingPrerequisite: "fixture-retry",
        planning: "fixture-planning",
        unknown: "fixture-unknown",
        waitingNotBlocked: "fixture-waiting",
      },
      retry: { baseSeconds: 1, maxSeconds: 2, escalateAfterIdenticalAttempts: 2 },
    }), "utf8");
    const taxonomy = loadReciprocalTaxonomy(file);
    assert.equal(taxonomy.hardBlocked, "fixture-hard");
    assert.equal(taxonomy.codes.repeatedGenuineBlocker, "fixture-repeat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.deepEqual(classifyReciprocalGate({
    state: { phase: "paused", pauseOrigin: "machine", pauseReasonCode: "repeated-genuine-blocker", resumeCount: 3 },
  }), {
    category: reciprocalGateTaxonomy.hardBlocked,
    code: reciprocalGateTaxonomy.codes.repeatedGenuineBlocker,
    retryable: false,
    nextAction: "inspect-checkpoint-before-diagnostic-retry",
  });
  assert.equal(classifyReciprocalGate({
    state: { phase: "paused", pauseOrigin: "human", lastSummary: "human paused at checkpoint" },
  }).code, reciprocalGateTaxonomy.codes.explicitHumanPause);
});

test("D186 classifies passive failure reason codes explicitly", () => {
  assert.deepEqual(classifyReciprocalGate({
    state: {
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "candidate-failure",
      candidateCommit: "abc123",
    },
  }), {
    category: reciprocalGateTaxonomy.hardHumanGate,
    code: reciprocalGateTaxonomy.pauseReasonCodes.candidateFailure,
    retryable: false,
    nextAction: "review-candidate-failure",
  });

  assert.deepEqual(classifyReciprocalGate({
    state: {
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      candidateCommit: "abc123",
    },
  }), {
    category: reciprocalGateTaxonomy.autoRecoverablePrerequisite,
    code: reciprocalGateTaxonomy.pauseReasonCodes.environmentFailure,
    retryable: true,
    nextAction: "resume-and-rerun-passive-test",
  });

  assert.deepEqual(classifyReciprocalGate({
    attemptCount: 3,
    state: {
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      candidateCommit: "abc123",
    },
  }), {
    category: reciprocalGateTaxonomy.hardBlocked,
    code: reciprocalGateTaxonomy.codes.repeatedGenuineBlocker,
    retryable: false,
    nextAction: "surface-actionable-blocker",
  });
});

test("builds an auditable rollback plan for a failed candidate", () => {
  const plan = recoveryPlan({ phase: "validating", candidateKind: "improvement", activeRole: "B" }, { a: { path: "copy-a" }, b: { path: "copy-b" } });
  assert.equal(plan.workspace, "copy-a");
  assert.match(plan.commands[0], /-Action Rollback -Role B/);
  assert.ok(plan.commands.includes("npm test"));
});

test("D181 expected runtime topology keeps B dormant during normal A work", () => {
  const idle = expectedRuntimeTopology({ phase: "idle", activeRole: null });
  assert.equal(idle.key, "a-ready");
  assert.deepEqual(idle.expectedOnline, { A: true, B: false });
  assert.equal(idle.startRole, "A");
  assert.deepEqual(runtimeTopologyHealth(idle, { a: { running: true }, b: { running: false } }), {
    ok: true,
    online: { A: true, B: false },
    expectedOnline: { A: true, B: false },
    expectedCount: 1,
    onlineCount: 1,
    problems: [],
    detail: "A online, B dormant",
  });
  const staleB = runtimeTopologyHealth(idle, { a: { running: true }, b: { running: true } });
  assert.equal(staleB.ok, false);
  assert.match(staleB.detail, /Executor B is online while topology expects it dormant/);

  const working = expectedRuntimeTopology({ phase: "working", activeRole: "A" });
  assert.equal(working.label, "A producing / B dormant");
  assert.deepEqual(working.expectedOnline, { A: true, B: false });
});

test("D182 expected runtime topology keeps A alive until B is recovery authority", () => {
  const passive = expectedRuntimeTopology({ phase: "passive-testing", activeRole: null });
  assert.equal(passive.startRole, "A");
  assert.deepEqual(passive.expectedOnline, { A: true, B: false });

  const pending = expectedRuntimeTopology({ phase: "a-upgrade-pending", activeRole: null });
  assert.equal(pending.key, "a-running-verifying-b");
  assert.equal(pending.startRole, "B");
  assert.deepEqual(pending.expectedOnline, { A: true, B: true });
  assert.equal(runtimeTopologyHealth(pending, { a: { running: true }, b: { running: true } }).ok, true);

  const upgrading = expectedRuntimeTopology({ phase: "a-upgrade-pending", activeRole: null }, { stage: "a-stopped" });
  assert.equal(upgrading.key, "b-recovery-upgrading-a");
  assert.deepEqual(upgrading.expectedOnline, { A: false, B: true });
});

test("D182 approval flow topology reports launch, awaiting approval, upgrade, and B-stop phases", () => {
  assert.deepEqual(approvalFlowRuntimeTopology({ status: "running", current: "recovery-authority-promoted" }), {
    key: "b-launch-verification",
    label: "A running / verifying B",
    expectedOnline: { A: true, B: true },
    startRole: "B",
    normalOnlineText: "A remains online while B is verified",
    detail: "Executor B is being launched from the exact verified candidate while Executor A remains the known-good producer.",
  });
  assert.equal(approvalFlowRuntimeTopology({ status: "running", stage: "b-verified" }).key, "a-running-b-verified-awaiting-approval");
  assert.equal(approvalFlowRuntimeTopology({ status: "running", stage: "a-promoted" }).key, "b-recovery-upgrading-a");
  assert.equal(approvalFlowRuntimeTopology({ status: "running", stage: "relay-completed" }).key, "a-healthy-stopping-b");
  assert.equal(approvalFlowRuntimeTopology({ status: "completed", current: "complete" }), null);
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
    recoveryAuthorityReady: true,
    executorsStopped: true,
    promoted: true,
    executorsRestarted: true,
    steps: [{ step: "review-recorded" }],
  };

  assert.deepEqual(approvalRemainingActions(flow), [
    "run CompleteAUpgrade from passive copy-a (codex/reciprocal-a) to close the already-promoted A-upgrade gate",
  ]);
  assert.match(approvalFailureDetail(flow, "CompleteAUpgrade failed"), /runtime promotion succeeded/);
  assert.match(approvalFailureDetail(flow, "CompleteAUpgrade failed"), /Executor B recovery authority was verified/);
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

test("D181 dormant B is not a preview capability blocker unless it is started", () => {
  const topology = { expectedOnline: { A: true, B: false } };
  const producer = { capabilities: { candidatePreviewArtifactLifecycle: 1 }, path: "copy-b", sha: "abcdef1234567890" };
  const upgradedA = { path: "executor-a", buildInfo: { sourceSha: "aaaaaa1234567890", reciprocalCapabilities: { candidatePreviewArtifactLifecycle: 1 } } };
  const staleDormantB = { running: false, path: "executor-b", buildInfo: { sourceSha: "old" } };

  const dormant = candidatePreviewArtifactCapabilityStatus({ producer, runtimeA: upgradedA, runtimeB: staleDormantB, topology });
  assert.equal(dormant.compatible, true);
  assert.match(dormant.message, /dormant Executor B/i);

  const staleStartedB = candidatePreviewArtifactCapabilityStatus({ producer, runtimeA: upgradedA, runtimeB: { ...staleDormantB, running: true }, topology });
  assert.equal(staleStartedB.compatible, false);
  assert.match(staleStartedB.message, /Executor B runtime has v0/);
});
