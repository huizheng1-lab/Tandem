import { describe, expect, it } from "vitest";
import { buildWorkerContext, summarizePreviousReport } from "../src/agents/live.js";
import type { BuildPlan, CompletionReport, ReviewFeedback } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "Big project",
  objective: "Build the thing",
  constraints: [],
  tasks: [{ id: "T1", description: "Implement" }],
  acceptanceCriteria: ["Works"],
  verification: ["npm test"]
};

function reportWithHugeOutput(): CompletionReport {
  return {
    status: "complete",
    summary: "done",
    taskResults: [{ id: "T1", status: "done", notes: "ok" }],
    filesChanged: ["src/index.ts"],
    verificationResults: [
      { command: "npm test", passed: true, output: "PASS\n".repeat(5000) },
      { command: "node smoke.mjs", passed: false, output: `FAIL\n${"stack\n".repeat(5000)}` }
    ],
    deviationsFromPlan: ["none"]
  };
}

describe("worker context", () => {
  it("summarizes previous reports without carrying successful full outputs", () => {
    const summary = summarizePreviousReport(reportWithHugeOutput());

    expect(summary?.failedVerifications).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain("PASS\\nPASS\\nPASS");
    expect(JSON.stringify(summary).length).toBeLessThan(3000);
  });

  it("caps worker context to the configured char budget", () => {
    const feedback: ReviewFeedback = [
      {
        issue: "issue ".repeat(2000),
        location: "src/index.ts",
        requiredChange: "change ".repeat(2000)
      }
    ];

    const bigPlan: BuildPlan = {
      ...plan,
      tasks: Array.from({ length: 80 }, (_, index) => ({ id: `T${index}`, description: `Task ${index} ${"details ".repeat(20)}` }))
    };

    const content = buildWorkerContext({ round: 2, plan: bigPlan, feedback, previousReport: reportWithHugeOutput() }, 4000);

    expect(content.length).toBeLessThanOrEqual(4000);
    expect(content).toContain("context truncated");
    expect(content).not.toContain("PASS\nPASS\nPASS");
  });
});
