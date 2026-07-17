import { describe, expect, it } from "vitest";
import type { RunHeartbeatEvent } from "../app/shared/ipc.js";
import { activityStripState } from "../app/renderer/src/activity-strip.js";

const secondsSince = (startedAt: number, now: number) => Math.floor((now - startedAt) / 1000);

function makeHeartbeat(overrides: Partial<RunHeartbeatEvent> = {}): RunHeartbeatEvent {
  return {
    type: "heartbeat",
    state: "healthy",
    phase: "BUILDING",
    lastEventAt: 0,
    lastEventKind: "modelDelta",
    lastEventRole: "worker",
    elapsedMs: 0,
    quietSeconds: 30,
    stalledSeconds: 180,
    ...overrides
  };
}

describe("renderer activity strip", () => {
  it("labels stale pulses as silence instead of active thinking", () => {
    const state = activityStripState({
      activityPulse: { role: "worker", kind: "thinking", startedAt: 0 },
      fallbackRole: "leader",
      noActivitySeconds: 12,
      activityTick: 12_000,
      secondsSince
    });
    expect(state).toMatchObject({ role: "worker", text: "no output for 12s", stalled: false });
  });

  it("uses the incoming tool role instead of a stale pulse role", () => {
    const state = activityStripState({
      activeTool: { role: "leader", phase: "start", tool: "read_file", target: "a.txt", startedAt: 10_000 },
      activityPulse: { role: "worker", kind: "thinking", startedAt: 0 },
      fallbackRole: "worker",
      noActivitySeconds: 1,
      activityTick: 11_000,
      secondsSince
    });
    expect(state.role).toBe("leader");
    expect(state.text).toBe("running: a.txt (1s)");
  });

  it("formats the strip from the orchestrator run-health snapshot, ignoring the stale pulse", () => {
    const heartbeat = makeHeartbeat({ state: "quiet", lastEventKind: "toolCall", elapsedMs: 45_000, lastEventAt: 0 });
    const state = activityStripState({
      activityPulse: { role: "leader", kind: "writing", startedAt: 0 },
      fallbackRole: "leader",
      noActivitySeconds: 12,
      activityTick: 45_000,
      secondsSince,
      runHealth: heartbeat
    });
    expect(state.role).toBe("worker");
    expect(state.text).toBe("WORKER BUILDING quiet (45s since last tool call)");
    expect(state.stalled).toBe(false);
  });

  it("marks the strip stalled when the heartbeat reports likely stalled, ignoring a stale activityPulse", () => {
    const heartbeat = makeHeartbeat({ state: "stalled", lastEventKind: "checkpoint", elapsedMs: 200_000, lastEventAt: 0 });
    const state = activityStripState({
      activityPulse: { role: "leader", kind: "writing", startedAt: 0 },
      fallbackRole: "leader",
      noActivitySeconds: 12,
      activityTick: 200_000,
      secondsSince,
      runHealth: heartbeat
    });
    expect(state.stalled).toBe(true);
    expect(state.text).toMatch(/likely stalled \(200s since last checkpoint\) - Stop to abort$/);
  });
});