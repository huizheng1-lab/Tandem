import { describe, expect, it } from "vitest";
import { BuildPlan, ReviewVerdictSchema, validateCompletionReport } from "../src/orchestrator/artifacts.js";

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

  it("matches prose verification entries against the command actually run", () => {
    const prosePlan: BuildPlan = {
      ...plan,
      verification: ["Run `node test.mjs` and observe a successful exit."]
    };
    const report = validateCompletionReport(prosePlan, {
      status: "complete",
      summary: "done",
      taskResults: [{ id: "T1", status: "done" }],
      filesChanged: ["test.mjs"],
      verificationResults: [{ command: "node test.mjs", passed: true, output: "ok" }],
      deviationsFromPlan: []
    });
    expect(report.status).toBe("complete");
  });

  it("still fails prose entries when the matched command failed", () => {
    const prosePlan: BuildPlan = {
      ...plan,
      verification: ["Run `node test.mjs` and observe a successful exit."]
    };
    expect(() =>
      validateCompletionReport(prosePlan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["test.mjs"],
        verificationResults: [{ command: "node test.mjs", passed: false, output: "boom" }],
        deviationsFromPlan: []
      })
    ).toThrow(/failing verification/);
  });

  it("rejects approve verdicts with severe scores", () => {
    expect(() =>
      ReviewVerdictSchema.parse({
        verdict: "approve",
        scores: { correctness: 1, planAdherence: 5, codeQuality: 5 },
        feedback: [],
        userSummary: "Looks good."
      })
    ).toThrow(/approve verdict requires scores above 2/);
  });

  it("allows revise verdicts with severe scores", () => {
    const verdict = ReviewVerdictSchema.parse({
      verdict: "revise",
      scores: { correctness: 1, planAdherence: 2, codeQuality: 2 },
      feedback: [{ issue: "broken", requiredChange: "fix it" }],
      userSummary: "Needs fixes."
    });

    expect(verdict.verdict).toBe("revise");
  });
});
