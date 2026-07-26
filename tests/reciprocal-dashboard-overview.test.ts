import { describe, expect, it } from "vitest";

// @ts-expect-error Browser-native module intentionally has no TypeScript declaration.
import { buildOverview } from "../dashboard-source/reciprocal-control-panel/public/overview-state.js";

describe("reciprocal dashboard orchestrator overview", () => {
  it("renders D196 failed-paused state instead of the legacy supervisor display", () => {
    expect(buildOverview({
      schemaVersion: "D196-orchestrator",
      phase: "failed-paused",
      step: "failed-paused",
      currentItem: { id: "W0029" },
      consecutiveFailures: 2,
      nextRole: "A",
    }, "Dispatch-Highest-Priority-Human-Item")).toEqual({
      phase: "Failed — paused",
      context: "Item W0029",
      nextGate: "Human review",
      gateDetail: "W0029 · 2 failed rounds",
      cycle: "Failed — paused · W0029",
    });
  });

  it("shows the active D196 verification checkpoint and current item", () => {
    expect(buildOverview({
      schemaVersion: "D196-orchestrator",
      phase: "improving",
      step: "a-tests",
      currentItem: { id: "W0030" },
    }, "stale legacy state")).toEqual({
      phase: "Improving · Running verification",
      context: "Item W0030",
      nextGate: "Verification",
      gateDetail: "W0030 · Running verification",
      cycle: "Improving · Running verification · W0030",
    });
  });

  it("preserves legacy relay display semantics outside D196", () => {
    expect(buildOverview({
      phase: "working",
      turn: 5,
      activeRole: "A",
      nextRole: "A",
      resumeCount: 1,
      resumeThreshold: 3,
    }, "Wait-For-Current-Owner-Or-Review")).toEqual({
      phase: "Wait-For-Current-Owner-Or-Review",
      context: "Turn 5",
      nextGate: "Executor A",
      gateDetail: "Active owner: A · resumes 1/3",
      cycle: "Wait-For-Current-Owner-Or-Review · A · resumes 1/3",
    });
  });
});
