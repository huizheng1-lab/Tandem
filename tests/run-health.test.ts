import { describe, expect, it, vi } from "vitest";
import { RunHealthTracker } from "../src/orchestrator/run-health.js";

describe("RunHealthTracker", () => {
  it("validates thresholds", () => {
    expect(() => new RunHealthTracker({ quietSeconds: 0, stalledSeconds: 10, initialPhase: "IDLE" })).toThrow(/quietSeconds/);
    expect(() => new RunHealthTracker({ quietSeconds: 10, stalledSeconds: 10, initialPhase: "IDLE" })).toThrow(/greater/);
  });

  it("emits only bucket changes and preserves the last meaningful event", () => {
    let now = 1_000;
    const tracker = new RunHealthTracker({ quietSeconds: 5, stalledSeconds: 10, initialPhase: "IDLE", now: () => now });

    expect(tracker.recordMeaningful({ kind: "modelDelta", role: "leader", phase: "BUILDING" })).toMatchObject({
      state: "healthy", lastEventAt: 1_000, lastEventKind: "modelDelta", lastEventRole: "leader", elapsedMs: 0
    });
    now = 6_000;
    expect(tracker.tick({ phase: "BUILDING" })).toMatchObject({ state: "quiet", elapsedMs: 5_000 });
    expect(tracker.tick({ phase: "BUILDING" })).toBeUndefined();
    now = 11_000;
    expect(tracker.tick({ phase: "BUILDING" })).toMatchObject({ state: "stalled", elapsedMs: 10_000 });
    expect(tracker.snapshot({ phase: "BUILDING" })).toMatchObject({ state: "stalled", lastEventRole: "leader" });
    expect(tracker.tick({ phase: "BUILDING" })).toBeUndefined();
    expect(tracker.recordMeaningful({ kind: "toolCall", role: "worker", phase: "BUILDING" })).toMatchObject({
      state: "healthy", lastEventKind: "toolCall", lastEventRole: "worker", elapsedMs: 0
    });
  });

  it("uses the injected clock with fake timer advancement", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const tracker = new RunHealthTracker({ quietSeconds: 5, stalledSeconds: 10, initialPhase: "PLANNING", now: () => Date.now() });
      vi.advanceTimersByTime(5_000);
      expect(tracker.snapshot({ phase: "PLANNING" })).toMatchObject({ state: "quiet", elapsedMs: 5_000 });
      expect(tracker.recordMeaningful({ kind: "checkpoint", phase: "REVIEWING" })).toMatchObject({ state: "healthy", elapsedMs: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
