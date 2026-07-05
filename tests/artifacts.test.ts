import { describe, expect, it } from "vitest";
import { BuildPlan, validateCompletionReport } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "Demo",
  objective: "Build demo.",
  constraints: [],
  tasks: [{ id: "T1", description: "Do work" }],
  acceptanceCriteria: ["Works"],
  verification: ["npm test"]
};

describe("artifacts", () => {
  it("rejects reports that omit plan verification commands", () => {
    expect(() =>
      validateCompletionReport(plan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      })
    ).toThrow(/omitted verification/);
  });
});
