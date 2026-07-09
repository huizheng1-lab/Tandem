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
    const result = await runOrchestration({ request: "build", config: { maxReviewRounds: 3, maxParallelWorkers: 1 }, agents: agents() });
    expect(result.takeover).toBe(false);
    expect(result.summary).toBe("approve");
  });

  it("covers two revise rounds then approve", async () => {
    let reviews = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 0, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 2, maxParallelWorkers: 1 },
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
    const result = await runOrchestration({ request: "build", config: { maxReviewRounds: 3, maxParallelWorkers: 1 }, agents: agents({ review: async () => verdict("takeover") }) });
    expect(result.takeover).toBe(true);
  });

  it("routes worker blocked to takeover", async () => {
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({ build: async () => report("blocked") })
    });
    expect(result.takeover).toBe(true);
  });

  it("takes over when the worker cannot produce a valid report", async () => {
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({ build: async () => ({ nope: true }) })
    });
    expect(result.takeover).toBe(true);
    expect(result.phase).toBe("DONE");
  });

  it("preserves takeover builds when takeover report validation keeps failing", async () => {
    let takeovers = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
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
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
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

  it("D58: revise round that targets only some streams still includes carried-forward streams in the merged report (no dropped task results / filesChanged)", async () => {
    // 2-stream plan: A1/a.txt in stream A, B1/b.txt in stream B. Round 1: both build. Round 2:
    // leader returns `revise` with feedback that ONLY names B1 - so only stream B is re-run.
    // The merged report passed to round-2 review() (and pushed onto result.reports) MUST
    // include both A1 and B1's task results, both a.txt and b.txt in filesChanged, both
    // verificationResults. The D58-1 bug dropped the carried-forward stream from the merged
    // report; the test guards against the regression.
    const twoStreamPlan: BuildPlan = {
      ...plan,
      tasks: [
        { id: "A1", description: "task a", stream: "A", files: ["a.txt"] },
        { id: "B1", description: "task b", stream: "B", files: ["b.txt"] }
      ]
    };
    const reportFor = (streamId: string): CompletionReport => ({
      status: "complete",
      summary: `${streamId} done`,
      taskResults: [{ id: streamId === "A" ? "A1" : "B1", status: "done" }],
      filesChanged: [streamId === "A" ? "a.txt" : "b.txt"],
      verificationResults: [{ command: "npm test", passed: true, output: "ok" }],
      deviationsFromPlan: []
    });
    let reviewInputs: CompletionReport[] = [];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: {
        plan: async () => ({ kind: "plan" as const, plan: twoStreamPlan }),
        build: async (input) => {
          const taskId = input.tasks[0]?.id;
          if (taskId === "A1") return reportFor("A");
          if (taskId === "B1") return reportFor("B");
          throw new Error(`unexpected task ${taskId}`);
        },
        review: async ({ report }) => {
          reviewInputs.push(report);
          return reviewInputs.length === 1
            ? verdict("revise", [{ issue: "B1 needs more work", location: "b.txt", requiredChange: "fix it" }])
            : verdict("approve");
        },
        takeover: async () => ({ report: reportFor("A"), userSummary: "takeover complete" })
      }
    });

    expect(result.takeover).toBe(false);
    expect(result.summary).toBe("approve");
    // Two merged reports: one for round 1 (both streams), one for round 2 (only B re-run; A
    // carried forward).
    expect(result.reports).toHaveLength(2);
    // CRITICAL: round 2's merged report must contain BOTH task results, BOTH files, BOTH
    // verificationResults - not just stream B's.
    const round2Report = result.reports[1];
    expect(round2Report).toBeDefined();
    if (!round2Report) throw new Error("unreachable");
    const round2TaskIds = round2Report.taskResults.map((r) => r.id).sort();
    expect(round2TaskIds).toEqual(["A1", "B1"]);
    expect(round2Report.filesChanged.sort()).toEqual(["a.txt", "b.txt"]);
    expect(round2Report.verificationResults).toHaveLength(2);
    // The carry-forward stream A's report from round 1 must be intact in the merged report
    // (status complete, same filesChanged) - if it dropped to "skipped" or "partial" the bug
    // returned.
    const a1 = round2Report.taskResults.find((r) => r.id === "A1");
    expect(a1?.status).toBe("done");
    expect(round2Report.status).toBe("complete");
  });
});
