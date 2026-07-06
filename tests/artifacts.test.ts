import { describe, expect, it } from "vitest";
import { BuildPlan, ReviewVerdictSchema, validateBuildPlan, validateCompletionReport } from "../src/orchestrator/artifacts.js";

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

  it("rejects prose verification entries in build plans", () => {
    expect(() =>
      validateBuildPlan(
        {
          ...plan,
          verification: ["Play game and verify all effects are working"]
        },
        "win32"
      )
    ).toThrow(/does not look like a runnable shell command/);
  });

  it("rejects POSIX verification commands on Windows with safer alternatives", () => {
    expect(() => validateBuildPlan({ ...plan, verification: ["cat launch.bat"] }, "win32")).toThrow(/POSIX-only tool `cat`.*type <file>/s);
    expect(() => validateBuildPlan({ ...plan, verification: ["cat index.html | grep -E 'src=|title='"] }, "win32")).toThrow(/POSIX-only tool `cat`.*POSIX-only tool `grep`.*findstr/s);
  });

  it("accepts Windows-safe and cross-platform verification commands", () => {
    expect(validateBuildPlan({ ...plan, verification: ["npm test", "node test.mjs", "type launch.bat"] }, "win32").verification).toHaveLength(3);
  });

  it("requires completion reports to echo plan verification commands exactly", () => {
    const exactPlan: BuildPlan = {
      ...plan,
      verification: ["node test.mjs"]
    };
    const report = validateCompletionReport(exactPlan, {
      status: "complete",
      summary: "done",
      taskResults: [{ id: "T1", status: "done" }],
      filesChanged: ["test.mjs"],
      verificationResults: [{ command: "node test.mjs", passed: true, output: "ok" }],
      deviationsFromPlan: []
    });
    expect(report.status).toBe("complete");
    expect(() =>
      validateCompletionReport(exactPlan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["test.mjs"],
        verificationResults: [{ command: "npm test", passed: true, output: "adapted from node test.mjs" }],
        deviationsFromPlan: []
      })
    ).toThrow(/omitted verification commands: node test\.mjs/);
  });

  it("fails verification entries when the exact matched command failed", () => {
    const exactPlan: BuildPlan = {
      ...plan,
      verification: ["node test.mjs"]
    };
    expect(() =>
      validateCompletionReport(exactPlan, {
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
