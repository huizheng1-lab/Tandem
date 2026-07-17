import { describe, expect, it } from "vitest";
import { AgentFns, OrchestrationCheckpoint, runOrchestration, WorkerStepExhaustionError } from "../src/orchestrator/machine.js";
import { BuildPlan, CompletionReport, ReviewVerdict } from "../src/orchestrator/artifacts.js";
import { createVerificationRunner } from "../src/orchestrator/verification.js";
import type { PermissionRequest } from "../src/tools/permissions.js";

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

  it("runs a post-build report hook before leader review", async () => {
    let reviewedReport: CompletionReport | undefined;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 1, maxParallelWorkers: 1 },
      agents: agents({
        review: async ({ report }) => {
          reviewedReport = report;
          return verdict("approve");
        }
      }),
      postBuildReport: async (value) => ({ ...value, summary: `${value.summary} plus app-layer commit` })
    });

    expect(result.takeover).toBe(false);
    expect(reviewedReport?.summary).toContain("app-layer commit");
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

  it("D64-1: a transient plan() failure self-corrects on retry instead of killing the session", async () => {
    // Simulates a transient leader hiccup (e.g. a permission-denial-style throw on the
    // first attempt's read-only explore step) that previously killed the whole session
    // outright. The 3-attempt retry envelope should self-correct and let the run complete.
    let planAttempts = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        plan: async () => {
          planAttempts += 1;
          if (planAttempts === 1) throw new Error("transient hiccup: permission denied on read of C:\\Users\\me\\foo");
          return { kind: "plan" as const, plan };
        }
      })
    });
    expect(planAttempts).toBe(2);
    expect(result.takeover).toBe(false);
    expect(result.summary).toBe("approve");
  });

  it("D64-1: all 3 plan() attempts failing ends the session cleanly (no takeover path is reachable yet)", async () => {
    // When retryArtifact exhausts its 3 attempts it throws. The orchestrator catches that
    // and ends with a clean DONE + a diagnosable summary rather than crashing the session.
    const errorEvents: { message: string; stack?: string }[] = [];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        plan: async () => {
          throw new Error("always fails");
        }
      }),
      emit: (event) => {
        if (event.type === "error") errorEvents.push({ message: event.message, stack: event.stack });
      }
    });
    expect(result.phase).toBe("DONE");
    expect(result.takeover).toBe(false);
    expect(result.summary).toMatch(/Leader planning could not produce a valid result after retries/);
    expect(result.summary).toContain("always fails");
    expect(errorEvents).toHaveLength(3);
    expect(errorEvents.every((event) => event.stack?.includes("always fails"))).toBe(true);
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

  it("D103: retries step-exhausted worker builds with an increased budget", async () => {
    const multipliers: (number | undefined)[] = [];
    const notices: string[] = [];
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        build: async (input) => {
          builds += 1;
          multipliers.push(input.stepBudgetMultiplier);
          if (builds === 1) throw new WorkerStepExhaustionError(150, 150);
          return report();
        }
      }),
      emit: (event) => {
        if (event.type === "notice") notices.push(event.message);
      }
    });

    expect(result.takeover).toBe(false);
    expect(multipliers).toEqual([1, 2]);
    expect(notices.some((message) => message.includes("stream __default__ ran out of steps on attempt 1"))).toBe(true);
    expect(notices.some((message) => message.includes("increased budget (2x)"))).toBe(true);
  });

  it("D103: ordinary worker failures retry without budget escalation", async () => {
    const multipliers: (number | undefined)[] = [];
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        build: async (input) => {
          builds += 1;
          multipliers.push(input.stepBudgetMultiplier);
          if (builds === 1) throw new Error("transient model hiccup");
          return report();
        }
      })
    });

    expect(result.takeover).toBe(false);
    expect(multipliers).toEqual([1, 1]);
  });

  it("D97: attaches authoritative verification results before review", async () => {
    const notices: string[] = [];
    let reviewedReport: CompletionReport | undefined;
    const authoritative = [{ command: "npm test", passed: false, output: "real failure" }];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      verificationRunner: async () => authoritative,
      agents: agents({
        build: async () => ({
          ...report(),
          verificationResults: [{ command: "wrong command", passed: true, output: "model claim" }]
        }),
        review: async ({ report }) => {
          reviewedReport = report;
          return verdict("approve");
        }
      }),
      emit: (event) => {
        if (event.type === "notice") notices.push(event.message);
      }
    });

    expect(result.takeover).toBe(false);
    expect(result.reports[0]?.verificationResults).toEqual(authoritative);
    expect(reviewedReport?.verificationResults).toEqual(authoritative);
    expect(notices).toContain("verification: 0/1 passed");
  });

  it("D97: accepts omitted model verification only when authoritative verification ran", async () => {
    const badModelReport = { ...report(), verificationResults: [] };
    const accepted = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      verificationRunner: async () => [{ command: "npm test", passed: true, output: "real ok" }],
      agents: agents({ build: async () => badModelReport })
    });
    expect(accepted.takeover).toBe(false);
    expect(accepted.reports[0]?.verificationResults).toEqual([{ command: "npm test", passed: true, output: "real ok" }]);

    const fallback = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        build: async () => badModelReport,
        takeover: async () => ({ report: report(), userSummary: "takeover repaired report" })
      })
    });
    expect(fallback.takeover).toBe(true);
  });

  it("D97: complete report with authoritative failure proceeds to review instead of retry-burning", async () => {
    let builds = 0;
    let reviews = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      verificationRunner: async () => [{ command: "npm test", passed: false, output: "assertion failed" }],
      agents: agents({
        build: async () => {
          builds += 1;
          return report("complete");
        },
        review: async ({ report }) => {
          reviews += 1;
          expect(report.verificationResults[0]?.passed).toBe(false);
          return verdict("approve");
        }
      })
    });

    expect(builds).toBe(1);
    expect(reviews).toBe(1);
    expect(result.takeover).toBe(false);
  });

  it("D101: takeover complete claim with authoritative failure is surfaced", async () => {
    const notices: string[] = [];
    const transitions: string[] = [];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0, maxParallelWorkers: 1 },
      verificationRunner: async () => [{ command: "npm test", passed: false, output: "real failure" }],
      agents: agents({
        takeover: async () => ({ report: report("complete"), userSummary: "takeover complete" })
      }),
      emit: (event) => {
        if (event.type === "notice") notices.push(event.message);
        if (event.type === "transition") transitions.push(event.message);
      }
    });

    expect(result.takeover).toBe(true);
    expect(result.reports[0]?.verificationResults).toEqual([{ command: "npm test", passed: false, output: "real failure" }]);
    expect(notices).toContain("verification: 0/1 passed");
    expect(notices.some((message) => message.includes("takeover claimed complete, but authoritative verification failed"))).toBe(true);
    expect(transitions).toContain("takeover done with verification warning");
    expect(result.summary).toMatch(/Warning: takeover claimed complete/);
  });

  it("D97: undisclosed verification script edits still fail with authoritative verification enabled", async () => {
    const tamperPlan: BuildPlan = {
      ...plan,
      tasks: [{ id: "T1", description: "Create CLI", files: ["src/index.ts"] }],
      verification: ["node verify.js"]
    };
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      verificationRunner: async () => [{ command: "node verify.js", passed: true, output: "real ok" }],
      agents: agents({
        plan: async () => ({ kind: "plan", plan: tamperPlan }),
        build: async () => ({
          ...report(),
          taskResults: [{ id: "T1", status: "done" }],
          filesChanged: ["src/index.ts", "verify.js"],
          verificationResults: []
        })
      })
    });

    expect(result.takeover).toBe(true);
    expect(result.summary).toContain("takeover");
  });

  it("D97: build retries receive previous validation feedback", async () => {
    let secondAttemptFeedback = "";
    let builds = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        build: async ({ previousAttemptError }) => {
          builds += 1;
          if (builds === 1) return { nope: true };
          secondAttemptFeedback = previousAttemptError ?? "";
          return report();
        }
      })
    });

    expect(result.takeover).toBe(false);
    expect(secondAttemptFeedback).toContain("invalid_type");
  });

  it("D97: review retries receive previous validation feedback", async () => {
    let secondAttemptFeedback = "";
    let reviews = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        review: async ({ previousAttemptError }) => {
          reviews += 1;
          if (reviews === 1) return { nope: true };
          secondAttemptFeedback = previousAttemptError ?? "";
          return verdict("approve");
        }
      })
    });

    expect(result.takeover).toBe(false);
    expect(secondAttemptFeedback).toContain("invalid_type");
  });

  it("D97: takeover retries receive previous validation feedback", async () => {
    let secondAttemptFeedback = "";
    let takeovers = 0;
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 0, maxParallelWorkers: 1 },
      agents: agents({
        takeover: async ({ previousAttemptError }) => {
          takeovers += 1;
          if (takeovers === 1) return { report: { nope: true } as unknown as CompletionReport, userSummary: "bad" };
          secondAttemptFeedback = previousAttemptError ?? "";
          return { report: report(), userSummary: "takeover complete" };
        }
      })
    });

    expect(result.takeover).toBe(true);
    expect(result.summary).toBe("takeover complete");
    expect(secondAttemptFeedback).toContain("invalid_type");
  });

  it("D97: ask-mode verification runner requests one batched approval and denial falls back", async () => {
    const approvalRequests: PermissionRequest[] = [];
    const runner = createVerificationRunner({
      cwd: process.cwd(),
      permissionMode: "ask",
      permissionBridge: {
        approve: async (request) => {
          approvalRequests.push(request);
          return false;
        }
      }
    });
    const notices: string[] = [];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1, permissionMode: "ask" },
      verificationRunner: runner,
      agents: agents(),
      emit: (event) => {
        if (event.type === "notice") notices.push(event.message);
      }
    });

    expect(result.takeover).toBe(false);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]?.target).toContain("Run the plan's 1 verification command");
    expect(notices.some((message) => message.includes("authoritative verification skipped"))).toBe(true);
  });

  it("sanitizes prompt-unsafe control characters in reports before review", async () => {
    let reviewedOutput = "";
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        build: async () => ({
          ...report(),
          summary: "done\0with controls",
          verificationResults: [{ command: "npm test", passed: true, output: "a\0b\x1Bc" }]
        }),
        review: async ({ report }) => {
          reviewedOutput = report.verificationResults[0]?.output ?? "";
          return verdict("approve");
        }
      })
    });

    expect(result.takeover).toBe(false);
    expect(result.reports[0]?.summary).toContain("donewith controls");
    expect(result.reports[0]?.summary).not.toContain("\0");
    expect(reviewedOutput).toBe("abc");
  });

  it("fast-fails deterministic null-byte subprocess argument errors", async () => {
    let reviews = 0;
    const events: string[] = [];
    const result = await runOrchestration({
      request: "build",
      config: { maxReviewRounds: 3, maxParallelWorkers: 1 },
      agents: agents({
        review: async () => {
          reviews += 1;
          const error = new TypeError("The argument 'args[1]' must be a string without null bytes. Received 'a\\x00b'") as NodeJS.ErrnoException;
          error.code = "ERR_INVALID_ARG_VALUE";
          throw error;
        }
      }),
      emit: (event) => {
        if (event.type === "error") events.push(event.message);
      }
    });

    expect(reviews).toBe(1);
    expect(events.some((message) => message.includes("ReviewVerdict failed on attempt"))).toBe(false);
    expect(result.phase).toBe("DONE");
    expect(result.takeover).toBe(false);
    expect(result.summary).toContain("automated review could not be finalized");
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
