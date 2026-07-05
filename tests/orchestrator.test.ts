import { describe, expect, it } from "vitest";
import { AgentFns, runOrchestration } from "../src/orchestrator/machine.js";
import { BuildPlan, CompletionReport, ReviewVerdict } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "Todo CLI",
  objective: "Build a todo CLI.",
  constraints: [],
  tasks: [{ id: "T1", description: "Create CLI" }],
  acceptanceCriteria: ["CLI works"],
  verification: ["npm test"]
};

const report = (status: CompletionReport["status"] = "complete"): CompletionReport => ({
  status,
  summary: "implemented",
  taskResults: [{ id: "T1", status: status === "complete" ? "done" : "partial" }],
  filesChanged: ["src/index.ts"],
  verificationResults: [{ command: "npm test", passed: status === "complete", output: "ok" }],
  deviationsFromPlan: []
});

const verdict = (value: ReviewVerdict["verdict"], feedback: ReviewVerdict["feedback"] = []): ReviewVerdict => ({
  verdict: value,
  scores: { correctness: value === "approve" ? 5 : 3, planAdherence: 4, codeQuality: 4 },
  feedback,
  userSummary: value
});

function agents(overrides: Partial<AgentFns> = {}): AgentFns {
  return {
    plan: async () => ({ kind: "plan", plan }),
    build: async () => report(),
    review: async () => verdict("approve"),
    takeover: async () => ({ report: report(), userSummary: "takeover complete" }),
    ...overrides
  };
}

describe("orchestration", () => {
  it("covers approve path", async () => {
    const result = await runOrchestration({ request: "build", config: { maxReviewRounds: 3 }, agents: agents() });
    expect(result.takeover).toBe(false);
    expect(result.summary).toBe("approve");
  });

  it("covers two revise rounds then approve", async () => {
    let reviews = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({
        review: async () => {
          reviews += 1;
          return reviews < 3 ? verdict("revise", [{ issue: "fix", requiredChange: "fix it" }]) : verdict("approve");
        }
      })
    });
    expect(result.verdicts).toHaveLength(3);
    expect(result.takeover).toBe(false);
  });

  it("forces takeover when rounds are exhausted", async () => {
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0 },
      agents: agents({ review: async () => verdict("revise", [{ issue: "x", requiredChange: "y" }]) })
    });
    expect(result.takeover).toBe(true);
  });

  it("supports leader early takeover", async () => {
    const result = await runOrchestration({ request: "build", config: { maxReviewRounds: 3 }, agents: agents({ review: async () => verdict("takeover") }) });
    expect(result.takeover).toBe(true);
  });

  it("routes worker blocked to takeover", async () => {
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({ build: async () => report("blocked") })
    });
    expect(result.takeover).toBe(true);
  });

  it("retries artifact validation failures", async () => {
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({
        build: async () => {
          builds += 1;
          return builds === 1 ? { nope: true } : report();
        }
      })
    });
    expect(builds).toBe(2);
    expect(result.takeover).toBe(false);
  });
});
