import { describe, expect, it } from "vitest";
import type { RunHeartbeatEvent } from "../app/shared/ipc.js";
import { formatRunHealth } from "../app/renderer/src/run-health-display.js";
import { RUN_HEALTH_QUIET_SECONDS } from "../app/renderer/src/session-state.js";

function makeSnapshot(overrides: Partial<RunHeartbeatEvent> = {}): RunHeartbeatEvent {
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

describe("renderer run health display", () => {
  it("exports the run-health quiet threshold as 30 seconds", () => {
    expect(RUN_HEALTH_QUIET_SECONDS).toBe(30);
  });

  it("formats a healthy heartbeat with role and phase", () => {
    expect(formatRunHealth(makeSnapshot({ state: "healthy", elapsedMs: 1_000 }), 1_000)).toEqual({
      label: "WORKER BUILDING healthy",
      stalled: false,
      cssClass: "healthy"
    });
  });

  it("formats a quiet heartbeat with the time since the last event kind", () => {
    const snapshot = makeSnapshot({ state: "quiet", lastEventKind: "toolCall", lastEventAt: 0, elapsedMs: 45_000 });
    expect(formatRunHealth(snapshot, 45_000)).toEqual({
      label: "WORKER BUILDING quiet (45s since last tool call)",
      stalled: false,
      cssClass: "quiet"
    });
  });

  it("formats a stalled heartbeat with the Stop-to-abort wording", () => {
    const snapshot = makeSnapshot({ state: "stalled", lastEventKind: "checkpoint", lastEventAt: 0, elapsedMs: 200_000 });
    expect(formatRunHealth(snapshot, 200_000)).toMatchObject({
      stalled: true,
      cssClass: "stalled",
      label: expect.stringMatching(/likely stalled \(200s since last checkpoint\) - Stop to abort$/)
    });
  });

  it("falls back to the phase when lastEventRole is missing", () => {
    const snapshot = makeSnapshot({ state: "quiet", lastEventKind: "transition", lastEventRole: undefined, elapsedMs: 31_000 });
    expect(formatRunHealth(snapshot, 31_000)).toEqual({
      label: "BUILDING quiet (31s since last transition)",
      stalled: false,
      cssClass: "quiet"
    });
  });

  it("advances the displayed elapsed seconds when now moves beyond elapsedMs", () => {
    const snapshot = makeSnapshot({ state: "quiet", lastEventKind: "toolCall", lastEventAt: 1_000, elapsedMs: 45_000 });
    // now is 60 seconds after the lastEventAt; the formatter derives the
    // elapsed counter from now - lastEventAt (Math.floor) so it advances to
    // 60s even though the serialized elapsedMs frozen at emit time was 45s.
    expect(formatRunHealth(snapshot, 61_000).label).toBe("WORKER BUILDING quiet (60s since last tool call)");
  });
});