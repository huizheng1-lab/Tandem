import { describe, expect, it } from "vitest";
import { AgentFns, OrchestrationCheckpoint, runOrchestration } from "../src/orchestrator/machine.js";
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
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0 },
      agents: agents({
        build: async () => {
          builds += 1;
          return report();
        },
        review: async () => verdict("revise", [{ issue: "x", requiredChange: "y" }])
      })
    });
    expect(result.takeover).toBe(true);
    expect(builds).toBe(0);
  });

  it("gives the worker exactly maxReviewRounds build attempts", async () => {
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 2 },
      agents: agents({
        build: async () => {
          builds += 1;
          return report();
        },
        review: async () => verdict("revise", [{ issue: "x", requiredChange: "y" }])
      })
    });
    expect(result.takeover).toBe(true);
    expect(builds).toBe(2);
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

  it("takes over when the worker cannot produce a valid report", async () => {
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({ build: async () => ({ nope: true }) })
    });
    expect(result.takeover).toBe(true);
    expect(result.phase).toBe("DONE");
  });

  it("preserves takeover builds when takeover report validation keeps failing", async () => {
    let takeovers = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0 },
      agents: agents({
        takeover: async () => {
          takeovers += 1;
          return {
            report: {
              ...report(),
              verificationResults: [{ command: "node test.mjs", passed: true, output: "adapted command output" }]
            },
            userSummary: "takeover work finished"
          };
        }
      })
    });

    expect(takeovers).toBe(3);
    expect(result.phase).toBe("DONE");
    expect(result.takeover).toBe(true);
    expect(result.summary).toContain("takeover verification bookkeeping could not be finalized");
    expect(result.summary).toContain("takeover work finished");
    expect(result.reports).toHaveLength(1);
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

  it("resumes from a mid-review checkpoint without rerunning earlier build rounds", async () => {
    let builds = 0;
    let lastCheckpoint: OrchestrationCheckpoint | undefined;
    await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({
        build: async () => {
          builds += 1;
          return report();
        },
        review: async () => ({ nope: true })
      }),
      emit: (event) => {
        if (event.type === "checkpoint" && event.checkpoint.phase === "REVIEWING" && !lastCheckpoint) {
          lastCheckpoint = event.checkpoint;
        }
      }
    });

    expect(lastCheckpoint?.phase).toBe("REVIEWING");
    expect(lastCheckpoint?.reports).toHaveLength(1);

    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      initialState: lastCheckpoint,
      agents: agents({
        build: async () => {
          builds += 1;
          return report();
        },
        review: async () => verdict("approve")
      })
    });

    expect(result.takeover).toBe(false);
    expect(result.reports).toHaveLength(1);
    expect(builds).toBe(1);
  });

  it("ends kindly when review cannot produce a verdict", async () => {
    let reviews = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3 },
      agents: agents({
        review: async () => {
          reviews += 1;
          throw new Error("review model failed");
        }
      })
    });

    expect(reviews).toBe(3);
    expect(result.phase).toBe("DONE");
    expect(result.takeover).toBe(false);
    expect(result.reports).toHaveLength(1);
    expect(result.summary).toContain("Build completed, but automated review could not be finalized");
  });
});
