const ORCHESTRATOR_SCHEMA = "D196-orchestrator";

const stepLabels = {
  "a-implements": "Implementing",
  "a-tests": "Running verification",
  "b-swaps": "Swapping runtimes",
  "failed-paused": "Failed — paused",
};

const phaseLabels = {
  improving: "Improving",
  swapping: "Swapping runtimes",
  idle: "Idle",
  "failed-paused": "Failed — paused",
};

function humanize(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildOverview(relay, supervisorDisplay) {
  if (relay?.schemaVersion !== ORCHESTRATOR_SCHEMA) {
    const phase = supervisorDisplay || relay?.phase || "Unknown";
    const resumeCount = Number(relay?.resumeCount || 0);
    const resumeThreshold = Number(relay?.resumeThreshold || 3);
    const resumeSuffix = resumeCount ? ` · resumes ${resumeCount}/${resumeThreshold}` : "";
    return {
      phase,
      context: `Turn ${relay?.turn ?? "--"}`,
      nextGate: relay?.nextRole ? `Executor ${relay.nextRole}` : "--",
      gateDetail: relay?.activeRole ? `Active owner: ${relay.activeRole}${resumeSuffix}` : "No active owner",
      cycle: relay?.activeRole
        ? `${phase} · ${relay.activeRole}${resumeSuffix}`
        : `${phase} · next ${relay?.nextRole || "--"}`,
    };
  }

  const itemId = relay.currentItem?.id || null;
  const phase = phaseLabels[relay.phase] || humanize(relay.phase) || "Unknown";
  const step = stepLabels[relay.step] || humanize(relay.step);
  const displayPhase = step && step !== phase ? `${phase} · ${step}` : phase;
  const failures = Number(relay.consecutiveFailures || 0);

  let nextGate = "Orchestrator";
  if (relay.phase === "failed-paused") nextGate = "Human review";
  else if (relay.step === "a-implements") nextGate = "Implementation helper";
  else if (relay.step === "a-tests") nextGate = "Verification";
  else if (relay.phase === "swapping" || relay.step === "b-swaps") nextGate = "Runtime swap";

  let gateDetail = itemId ? `${itemId} · ${step || phase}` : "No current item";
  if (relay.phase === "failed-paused" && itemId) {
    gateDetail = `${itemId} · ${failures} failed round${failures === 1 ? "" : "s"}`;
  }

  return {
    phase: displayPhase,
    context: itemId ? `Item ${itemId}` : "No active item",
    nextGate,
    gateDetail,
    cycle: itemId ? `${displayPhase} · ${itemId}` : displayPhase,
  };
}
