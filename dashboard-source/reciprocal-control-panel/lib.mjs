import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseDirection(markdown) {
  const general = section(markdown, "General Direction", "Human Guardrails");
  const notes = section(markdown, "Human Notes", null);
  const items = markdown.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^- \[( |x)\] (W\d{4}) \| (P[0-3]) \| (.*?) \| ([A-Z_]+)(?:\s+(.*))?$/);
    if (!match) return [];
    return [{
      done: match[1] === "x",
      id: match[2],
      priority: match[3],
      text: match[4],
      status: match[5],
      detail: match[6] || "",
    }];
  });

  return { general, notes, items };
}

export function section(markdown, start, end) {
  const startMarker = `## ${start}`;
  const startIndex = markdown.indexOf(startMarker);
  if (startIndex < 0) return "";
  const bodyStart = startIndex + startMarker.length;
  const endIndex = end ? markdown.indexOf(`## ${end}`, bodyStart) : markdown.length;
  return markdown.slice(bodyStart, endIndex < 0 ? markdown.length : endIndex).trim();
}

export function shortSha(value) {
  return value ? String(value).slice(0, 7) : null;
}

export const requiredReciprocalCapabilities = {
  candidatePreviewArtifactLifecycle: 1,
};

export function capabilityVersion(source, name) {
  const direct = source?.reciprocalCapabilities?.[name] ?? source?.capabilities?.[name];
  const nested = source?.sourceBuildInfo?.reciprocalCapabilities?.[name] ?? source?.sourceBuildInfo?.capabilities?.[name];
  const value = Number(direct ?? nested ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function candidatePreviewArtifactCapabilityStatus({ producer = null, runtimeA = null, runtimeB = null } = {}) {
  const capability = "candidatePreviewArtifactLifecycle";
  const required = requiredReciprocalCapabilities[capability];
  const components = [
    { key: "producer", label: "Producer relay", version: capabilityVersion(producer, capability), path: producer?.path || producer?.workspace || null, sha: producer?.sha || producer?.sourceSha || null },
    { key: "runtimeA", label: "Executor A runtime", version: capabilityVersion(runtimeA?.buildInfo || runtimeA, capability), path: runtimeA?.path || null, sha: runtimeA?.buildInfo?.sourceSha || runtimeA?.sourceSha || null },
    { key: "runtimeB", label: "Executor B runtime", version: capabilityVersion(runtimeB?.buildInfo || runtimeB, capability), path: runtimeB?.path || null, sha: runtimeB?.buildInfo?.sourceSha || runtimeB?.sourceSha || null },
  ].map((component) => ({
    ...component,
    required,
    ok: component.version >= required,
    shortSha: shortSha(component.sha),
  }));
  const missing = components.filter((component) => !component.ok);
  return {
    compatible: missing.length === 0,
    required: { [capability]: required },
    actual: { [capability]: missing.length === 0 ? required : 0 },
    components,
    message: missing.length === 0
      ? "Artifact build workflow ready."
      : `Artifact build workflow requires Reciprocal executor upgrade: ${missing.map((component) => `${component.label} has v${component.version}`).join("; ")}; required v${required}.`,
  };
}

export function expectedRuntimeTopology(state = {}) {
  const phase = String(state?.phase || "unknown");
  const activeRole = state?.activeRole || null;
  if (phase === "a-upgrade-pending") {
    return {
      key: "b-recovery-authority",
      label: "B recovery authority / A awaiting upgrade",
      expectedOnline: { A: false, B: true },
      startRole: "B",
      normalOnlineText: "B online as recovery authority",
      detail: "Executor B must be the verified passive runtime that can recover and promote Executor A.",
    };
  }
  if (phase === "passive-testing" || phase === "validating") {
    return {
      key: "mechanical-candidate-checks",
      label: "Mechanical candidate checks",
      expectedOnline: { A: false, B: false },
      startRole: null,
      normalOnlineText: "No agentic runtime required",
      detail: "Candidate checks run mechanically from isolated worktrees; B is launched only after an exact package is ready for recovery verification.",
    };
  }
  if (phase === "working" && activeRole === "A") {
    return {
      key: "a-producing",
      label: "A producing / B dormant",
      expectedOnline: { A: true, B: false },
      startRole: "A",
      normalOnlineText: "A online, B dormant",
      detail: "Executor A is the sole agentic producer; Executor B must not claim, plan, implement, review, or receive prompts.",
    };
  }
  return {
    key: "a-ready",
    label: "A ready / B dormant",
    expectedOnline: { A: true, B: false },
    startRole: "A",
    normalOnlineText: "A online, B dormant",
    detail: "Normal reciprocal operation keeps only Executor A available for producer prompts.",
  };
}

export function runtimeTopologyHealth(topology, runtimes = {}) {
  const aRunning = Boolean(runtimes.a?.running ?? runtimes.A?.running);
  const bRunning = Boolean(runtimes.b?.running ?? runtimes.B?.running);
  const expected = topology?.expectedOnline || { A: true, B: false };
  const problems = [];
  if (expected.A && !aRunning) problems.push("Executor A expected online");
  if (!expected.A && aRunning && topology?.key === "b-recovery-authority") problems.push("Executor A should be stopped while B is recovery authority");
  if (expected.B && !bRunning) problems.push("Executor B expected online");
  if (!expected.B && bRunning) problems.push("Executor B is online while topology expects it dormant");
  return {
    ok: problems.length === 0,
    online: { A: aRunning, B: bRunning },
    expectedOnline: expected,
    expectedCount: Number(Boolean(expected.A)) + Number(Boolean(expected.B)),
    onlineCount: Number(aRunning) + Number(bRunning),
    problems,
    detail: problems.length ? problems.join("; ") : topology?.normalOnlineText || "Runtime topology matches phase",
  };
}

export function detailMetadata(value) {
  return Object.fromEntries([...String(value || "").matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map((match) => [match[1], match[2]]));
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const candidateTaxonomyPaths = [
  process.env.TANDEM_RECIPROCAL_TAXONOMY,
  process.env.TANDEM_SOURCE_REPO ? path.join(process.env.TANDEM_SOURCE_REPO, "process", "reciprocal", "gate-taxonomy.json") : null,
  path.resolve(libDir, "..", "..", "HZ code", "process", "reciprocal", "gate-taxonomy.json"),
  path.resolve(libDir, "..", "..", "process", "reciprocal", "gate-taxonomy.json"),
].filter(Boolean);

export function validateReciprocalTaxonomy(value) {
  const missing = [];
  for (const key of ["autoRecoverablePrerequisite", "hardBlocked", "hardHumanGate", "waitingNotBlocked"]) {
    if (!value?.categories?.[key]) missing.push(`categories.${key}`);
  }
  for (const key of ["idleSupervisorDispatch", "humanAuthorityRequired", "explicitHumanPause", "progressWait", "leaseHeld", "repeatedGenuineBlocker"]) {
    if (!value?.codes?.[key]) missing.push(`codes.${key}`);
  }
  for (const key of ["baseSeconds", "maxSeconds", "escalateAfterIdenticalAttempts"]) {
    if (!Number.isFinite(Number(value?.retry?.[key]))) missing.push(`retry.${key}`);
  }
  for (const key of ["working", "testing", "waitingForReview", "humanPaused", "machineBlocked", "hardBlocked", "retryBackoff", "retryingPrerequisite", "planning", "unknown", "waitingNotBlocked"]) {
    if (!value?.displayStates?.[key]) missing.push(`displayStates.${key}`);
  }
  if (missing.length) throw new Error(`Invalid reciprocal gate taxonomy: missing ${missing.join(", ")}`);
  return Object.freeze({
    raw: Object.freeze(value),
    ...Object.freeze(value.categories),
    codes: Object.freeze(value.codes),
    retry: Object.freeze(value.retry),
    pauseOrigins: Object.freeze(value.pauseOrigins || {}),
    pauseReasonCodes: Object.freeze(value.pauseReasonCodes || {}),
    displayStates: Object.freeze(value.displayStates || {}),
  });
}

export function loadReciprocalTaxonomy(taxonomyPath = null) {
  const paths = taxonomyPath ? [taxonomyPath] : candidateTaxonomyPaths;
  const errors = [];
  for (const item of paths) {
    try {
      return validateReciprocalTaxonomy(JSON.parse(readFileSync(item, "utf8")));
    } catch (error) {
      errors.push(`${item}: ${error.message}`);
    }
  }
  throw new Error(`Unable to load canonical reciprocal taxonomy. Tried ${errors.join("; ")}`);
}

export const reciprocalGateTaxonomy = loadReciprocalTaxonomy();

const hardAuthorityPattern = /\b(human pause|explicit pause|cancel|reject|runtime promotion|promote executor|replace runtime|live runtime|unresolved conflict)\b/i;
const autoRecoverablePattern = /\b(too broad|broad|architectural|ambiguous|missing epic|epic metadata|missing plan|no safe item|paused-from-idle|paused from idle|source branch(?:es)? stale|stale source|dirty admin|dirty worktree|endpoint|file-lock|file lock|timeout|startup)\b/i;
const explicitAuthorityKinds = new Set(["credentials", "authentication", "pairing", "permission", "sandbox", "destructive", "payment", "publication", "runtime"]);

export function classifyReciprocalGate({ reason = "", state = {}, item = null, attemptCount = 0 } = {}) {
  const metadata = detailMetadata(item?.detail);
  const explicitAuthority = metadata.authority
    && metadata.authorityStatus !== "approved"
    && metadata.authorityStatus !== "consumed"
    && explicitAuthorityKinds.has(String(metadata.authority).toLowerCase());
  const text = [reason, state?.lastSummary].filter(Boolean).join(" ");
  const pauseOrigin = String(state?.pauseOrigin || "").toLowerCase();
  const pauseReasonCode = String(state?.pauseReasonCode || "");
  const escalatedAttempts = Number(attemptCount || state?.resumeCount || 0) >= Number(reciprocalGateTaxonomy.retry.escalateAfterIdenticalAttempts || 3);
  if (state?.phase === "paused" && pauseOrigin === reciprocalGateTaxonomy.pauseOrigins.machine && pauseReasonCode === reciprocalGateTaxonomy.codes.repeatedGenuineBlocker) {
    return {
      category: reciprocalGateTaxonomy.hardBlocked,
      code: reciprocalGateTaxonomy.codes.repeatedGenuineBlocker,
      retryable: false,
      nextAction: "inspect-checkpoint-before-diagnostic-retry",
    };
  }
  if (state?.humanPaused === true || pauseOrigin === reciprocalGateTaxonomy.pauseOrigins.human || explicitAuthority || hardAuthorityPattern.test(text)) {
    return {
      category: reciprocalGateTaxonomy.hardHumanGate,
      code: state?.humanPaused === true || pauseOrigin === reciprocalGateTaxonomy.pauseOrigins.human ? reciprocalGateTaxonomy.codes.explicitHumanPause : reciprocalGateTaxonomy.codes.humanAuthorityRequired,
      retryable: false,
      nextAction: "wait-for-human-authority",
      authority: explicitAuthority ? {
        kind: metadata.authority,
        action: metadata.action || null,
        checkpoint: metadata.checkpoint || null,
        resume: metadata.resume || null,
      } : null,
    };
  }
  if (["working", "passive-testing", "validating", "a-upgrade-pending"].includes(state?.phase) || state?.activeRole) {
    return {
      category: reciprocalGateTaxonomy.waitingNotBlocked,
      code: reciprocalGateTaxonomy.codes.progressWait,
      retryable: false,
      nextAction: "wait-for-current-owner-or-review",
    };
  }
  if (
    (state?.phase === "paused" && state?.pausedFromPhase === "idle" && autoRecoverablePattern.test(text))
    || (item?.status === "QUEUED" && !metadata.epic)
    || autoRecoverablePattern.test(text)
  ) {
    const escalates = escalatedAttempts;
    return {
      category: escalates ? reciprocalGateTaxonomy.hardBlocked : reciprocalGateTaxonomy.autoRecoverablePrerequisite,
      code: escalates ? reciprocalGateTaxonomy.codes.repeatedGenuineBlocker : reciprocalGateTaxonomy.autoRecoverablePrerequisite,
      retryable: !escalates,
      nextAction: escalates ? "surface-actionable-blocker" : "normalize-plan-reconcile-or-retry",
    };
  }
  return {
    category: reciprocalGateTaxonomy.autoRecoverablePrerequisite,
    code: reciprocalGateTaxonomy.codes.idleSupervisorDispatch,
    retryable: true,
    nextAction: "dispatch-highest-priority-human-item",
  };
}

export function nextQueuedHumanItem(direction) {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...(direction?.items || [])]
    .filter((item) => !item.done && item.status === "QUEUED")
    .sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || a.id.localeCompare(b.id))[0] || null;
}

export function queuedItemNeedsPlanning(item) {
  if (!item || item.status !== "QUEUED") return false;
  const metadata = detailMetadata(item.detail);
  return !metadata.artifact && metadata.epic !== "true";
}

export function reviewOriginItem(direction, sourceSha) {
  const sha = String(sourceSha || "").trim();
  if (!sha) return null;
  return (direction?.items || []).find((item) => {
    const metadata = detailMetadata(item.detail);
    return metadata.source === sha || metadata.stable === sha || metadata.commit === sha;
  }) || null;
}

export function rejectedCandidateOriginRetirement(item, followupId) {
  if (!item) return null;
  if (item.done || item.status === "DONE") return null;
  if (!["QUEUED", "IN_PROGRESS", "CANDIDATE", "BLOCKED"].includes(item.status)) return null;
  return {
    action: "Retire",
    id: item.id,
    note: `rejected-review-followup-${followupId || "pending"}`,
  };
}

export function approvalCompletionRelayAction(interruptedPhase) {
  if (interruptedPhase === "a-upgrade-pending") {
    return {
      action: "CompleteAUpgrade",
      role: "A",
      force: true,
      workspace: "a",
      step: "a-upgrade-completed",
    };
  }
  return {
    action: "Resume",
    role: null,
    force: false,
    step: "relay-resumed",
  };
}

export function approvalBoundaryPlan(state = {}) {
  if (state?.phase === "a-upgrade-pending" && !state?.activeRole) {
    return {
      action: "complete-a-upgrade-boundary",
      interruptedPhase: "a-upgrade-pending",
      pausedByFlow: true,
      forced: false,
      step: "a-upgrade-boundary",
      detail: `Relay already at A-upgrade approval boundary; turn ${state?.turn ?? "unknown"} remains gated.`,
    };
  }
  return null;
}

export function validateAlreadyPromotedAUpgradeRecovery({ state = {}, sourceSha = "", review = null, buildA = {}, buildB = {} } = {}) {
  const sha = String(sourceSha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("A-upgrade recovery requires the exact approved 40-character source SHA.");
  if (state?.phase !== "paused") throw new Error(`A-upgrade recovery requires relay phase paused; current phase is ${state?.phase || "unknown"}.`);
  if (state?.pausedFromPhase !== "a-upgrade-pending") throw new Error(`A-upgrade recovery requires pausedFromPhase=a-upgrade-pending; current pausedFromPhase is ${state?.pausedFromPhase || "unknown"}.`);
  if (state?.activeRole) throw new Error(`A-upgrade recovery requires no active reciprocal turn; activeRole=${state.activeRole}.`);
  if (state?.stableCommit !== sha) throw new Error(`A-upgrade recovery stable SHA mismatch: relay stable=${shortSha(state?.stableCommit)}, approved=${shortSha(sha)}.`);
  if (review?.decision && review.decision !== "approve") throw new Error(`A-upgrade recovery requires an approved review; current review decision is ${review.decision}.`);
  if (!review?.decision) throw new Error(`A-upgrade recovery requires a recorded approved review for ${shortSha(sha)}.`);
  if (buildA?.sourceSha !== sha) throw new Error(`A-upgrade recovery BUILD_INFO mismatch: Executor A=${shortSha(buildA?.sourceSha)}, approved=${shortSha(sha)}.`);
  if (buildB?.sourceSha !== sha) throw new Error(`A-upgrade recovery BUILD_INFO mismatch: Executor B=${shortSha(buildB?.sourceSha)}, approved=${shortSha(sha)}.`);
  return {
    action: "CompleteAUpgrade",
    role: "A",
    force: true,
    workspace: "a",
    step: "a-upgrade-recovered",
  };
}

export function approvalCompletionRecoveryStep(interruptedPhase) {
  if (interruptedPhase === "a-upgrade-pending") {
    return "run CompleteAUpgrade from passive copy-a (codex/reciprocal-a) to close the already-promoted A-upgrade gate";
  }
  return "resume or cancel the approval pause after the runtime state is coherent";
}

export function approvalRemainingActions(flow = {}) {
  const remaining = [];
  if (!flow.executorsStopped) remaining.push("stop both executors after reaching or overriding the safe boundary");
  if (!flow.promoted) remaining.push("promote the candidate runtime to both pinned executor directories");
  if (!flow.executorsRestarted) remaining.push("restart both executors hidden and verify their automation endpoints");
  if (flow.pausedByFlow && !flow.relayResumed) remaining.push(approvalCompletionRecoveryStep(flow.interruptedPhase));
  return remaining;
}

export function approvalFailureDetail(flow = {}, errorMessage = "Approval failed") {
  const remaining = approvalRemainingActions(flow);
  const completed = [];
  if ((flow.steps || []).some((entry) => entry.step === "review-recorded")) completed.push("review was recorded");
  if (flow.promoted) completed.push("runtime promotion succeeded");
  if (flow.executorsRestarted) completed.push("executors restarted");
  const completedText = completed.length ? ` Completed before the failure: ${completed.join("; ")}.` : "";
  const remainingText = remaining.length ? ` Remaining recovery action: ${remaining.join("; ")}.` : "";
  return `${errorMessage}.${completedText}${remainingText}`.replace(/\.\./g, ".");
}

export function rejectedCandidateWishlist(candidate, item, comment) {
  const sourceSha = String(candidate?.sourceSha || "").trim();
  if (!sourceSha) throw new Error("Rejected candidate wishlist requires a source SHA.");
  const review = String(comment || "").replace(/\s+/g, " ").trim();
  if (!review) throw new Error("Rejected candidate wishlist requires a review comment.");
  const marker = `[review-rejection:${sourceSha}]`;
  const context = item?.id ? ` for ${item.id}` : "";
  return {
    marker,
    priority: "P0",
    text: `Fix rejected candidate ${shortSha(sourceSha)}${context}. Human review: ${review} ${marker}`,
  };
}

export function rejectedCandidateRelayAction(state, sourceSha, originItem = null) {
  if (state?.phase === "a-upgrade-pending" && !state?.activeRole && sourceSha && state?.stableCommit === sourceSha) {
    return {
      action: "CompleteAUpgrade",
      role: "A",
      force: true,
      workspace: "a",
    };
  }

  const originMetadata = detailMetadata(originItem?.detail);
  const sourceMatchesOrigin = originMetadata.source === sourceSha || originMetadata.stable === sourceSha || originMetadata.commit === sourceSha;
  const workingArtifactPhase = state?.phase === "working" || (state?.phase === "paused" && state?.pausedFromPhase === "working");
  if (
    sourceMatchesOrigin &&
    originMetadata.artifact &&
    workingArtifactPhase &&
    state?.activeRole === "A" &&
    state?.baseCommit &&
    state?.baseCommit === state?.stableCommit &&
    !state?.candidateCommit &&
    !state?.rollbackCommit
  ) {
    return {
      action: "CompleteArtifact",
      role: "A",
      force: false,
      workspace: "b",
    };
  }

  return null;
}

export function recoveryPlan(state, worktrees) {
  const active = state?.activeRole;
  const workspace = active === "A" ? worktrees?.b?.path : active === "B" ? worktrees?.a?.path : worktrees?.a?.path;
  const roleArg = active ? ` -Role ${active}` : " -Role <A-or-B>";
  const relay = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1";
  const checks = ["npm run typecheck", "npm test", "git diff --check"];

  if (state?.phase === "validating" && state?.candidateKind === "improvement") {
    return {
      level: "warning",
      title: "Candidate can be rolled back",
      summary: "The active validator can create an auditable revert, verify the restored tree, and hand the turn back.",
      workspace,
      commands: [
        `${relay} -Action Rollback${roleArg} -Summary \"<failed check and evidence>\"`,
        ...checks,
        `${relay} -Action CompleteRollback${roleArg} -Summary \"rollback restored stable tree; required checks passed\"`,
      ],
    };
  }

  if (state?.phase === "working" && active) {
    return {
      level: "caution",
      title: "Active work is recoverable",
      summary: "Resume from the checkpoint. If the uncommitted approach is irrecoverable, preserve it in a named stash with Abandon.",
      workspace,
      commands: [
        "Get-Content .tandem\\reciprocal-checkpoint.md",
        `${relay} -Action Status`,
        `${relay} -Action Abandon${roleArg} -Summary \"<why this approach cannot be recovered>\"`,
      ],
    };
  }

  if (state?.phase === "rollback-verification") {
    return {
      level: "warning",
      title: "Rollback awaits verification",
      summary: "Run the full baseline against the rollback commit, then complete it only if the tree matches the stable ref.",
      workspace,
      commands: [
        ...checks,
        `${relay} -Action CompleteRollback${roleArg} -Summary \"rollback restored stable tree; required checks passed\"`,
      ],
    };
  }

  return {
    level: "safe",
    title: "Stable recovery point available",
    summary: "No rollback is currently required. The durable stable ref identifies the last independently verified version.",
    workspace,
    commands: [
      "git show --stat refs/tandem-relay/stable",
      "git log --oneline --decorate -8 refs/tandem-relay/stable",
      ...checks,
    ],
  };
}
