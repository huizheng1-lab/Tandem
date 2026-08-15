import { describe, expect, it } from "vitest";
import { isTaskStale, taskOutcomeFromRun } from "../src/task-outcome-status.js";

describe("task outcome status", () => {
  it("reports a verified DONE run as successful", () => {
    expect(taskOutcomeFromRun({ phase: "DONE", summary: "ok", reports: [{ status: "complete" }], verdicts: [{ verdict: "approve" }], takeover: false } as never)).toBe("successful");
  });

  it("reports blocked or rejected runs as failed", () => {
    expect(taskOutcomeFromRun({ phase: "DONE", summary: "blocked", reports: [{ status: "blocked" }], verdicts: [], takeover: false } as never)).toBe("failed");
    expect(taskOutcomeFromRun({ phase: "DONE", summary: "rejected", reports: [{ status: "complete" }], verdicts: [{ verdict: "revise" }], takeover: false } as never)).toBe("failed");
  });

  it("uses the shared existing 180-second stall window", () => {
    expect(isTaskStale(0, 180_000)).toBe(true);
    expect(isTaskStale(0, 179_999)).toBe(false);
  });
});
