import { describe, expect, it } from "vitest";
import { activityStripState } from "../app/renderer/src/activity-strip.js";

const secondsSince = (startedAt: number, now: number) => Math.floor((now - startedAt) / 1000);

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

  it("W0031: shows a concise thinking status without detailed reasoning text", () => {
    const state = activityStripState({
      activityPulse: { role: "worker", kind: "thinking", startedAt: 10_000 },
      fallbackRole: "leader",
      noActivitySeconds: 1,
      activityTick: 11_000,
      secondsSince
    });

    expect(state).toMatchObject({ role: "worker", text: "thinking...", stalled: false });
    expect(state.text).not.toContain("reasoning");
  });
});
