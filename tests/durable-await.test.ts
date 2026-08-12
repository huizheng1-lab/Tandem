import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resumeBackgroundAwait, suspendOnBackgroundAwait, waitForDurableAwait } from "../src/orchestrator/await.js";
import { runOrchestration, runOrchestrationDurably, type OrchestrationCheckpoint } from "../src/orchestrator/machine.js";
import type { BuildPlan, CompletionReport, ReviewVerdict } from "../src/orchestrator/artifacts.js";
import { bashTool } from "../src/tools/shell.js";

const plan: BuildPlan = { title: "await", objective: "await", constraints: [], tasks: [{ id: "T1", description: "work" }], acceptanceCriteria: ["done"], verification: [] };
const report: CompletionReport = { status: "complete", summary: "done", taskResults: [{ id: "T1", status: "done" }], filesChanged: [], verificationResults: [], deviationsFromPlan: [] };
const verdict: ReviewVerdict = { verdict: "approve", scores: { correctness: 5, planAdherence: 5, codeQuality: 5 }, feedback: [], userSummary: "approved" };

async function fixture(deadlineAt: string): Promise<{ cwd: string; id: string }> {
  const cwd = path.join(tmpdir(), `tandem-await-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const id = "await-fixture";
  await mkdir(path.join(cwd, ".tandem", "awaits"), { recursive: true });
  await writeFile(path.join(cwd, ".tandem", "awaits", `${id}.json`), JSON.stringify({
    id, condition: "background_process", processId: "gone", pid: 2147483647,
    deadlineAt, status: "suspended", createdAt: new Date().toISOString(), round: 1,
    checkpoint: { plan, tasks: plan.tasks, evidence: { marker: "prior" } }
  }));
  return { cwd, id };
}

describe("durable await", () => {
  it("keeps a live render parked through an early wakeup and resumes without takeover", async () => {
    const cwd = path.join(tmpdir(), `tandem-live-await-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    const started = await bashTool({ cwd, permissionMode: "yolo" }, "Start-Sleep -Milliseconds 150", 5_000, true);
    const processId = started.output.match(/Started background process (\S+)/)?.[1];
    if (!processId) throw new Error(`background process did not start: ${started.output}`);
    let builds = 0;
    let takeovers = 0;
    const phases: string[] = [];
    try {
      const result = await runOrchestrationDurably({
        cwd,
        request: "render",
        config: { maxReviewRounds: 1, maxParallelWorkers: 1 },
        agents: {
          plan: async () => ({ kind: "plan" as const, plan }),
          build: async () => {
            builds += 1;
            if (builds === 1) {
              await suspendOnBackgroundAwait({ cwd, processId, timeoutMs: 1, id: "live-render" });
            }
            return report;
          },
          review: async () => verdict,
          takeover: async () => {
            takeovers += 1;
            return { report, userSummary: "unexpected takeover" };
          }
        },
        emit: (event) => {
          if (event.type === "transition") phases.push(event.phase);
        }
      });
      expect(result.phase).toBe("DONE");
      expect(result.takeover).toBe(false);
      expect(builds).toBe(2);
      expect(takeovers).toBe(0);
      expect(phases).toContain("PARKED");
      expect(phases.indexOf("DONE")).toBeGreaterThan(phases.indexOf("PARKED"));
    } finally {
      await resumeBackgroundAwait(cwd, "live-render").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resumes a persisted parked round on deadline without spending a round", async () => {
    const { cwd, id } = await fixture(new Date(Date.now() - 1).toISOString());
    try {
      const initialState: OrchestrationCheckpoint = { phase: "PARKED", round: 1, plan, reports: [], verdicts: [], feedbackHistory: [], parkedAwaitId: id };
      const builds: number[] = [];
      const result = await runOrchestration({ cwd, request: "resume", config: { maxReviewRounds: 3, maxParallelWorkers: 1 }, initialState,
        agents: { plan: async () => ({ kind: "plan", plan }), build: async ({ round }) => { builds.push(round); return report; }, review: async () => verdict, takeover: async () => ({ report, userSummary: "takeover" }) } });
      expect(result.phase).toBe("DONE");
      expect(builds).toEqual([1]);
      expect(result.summary).toBe("approved");
      expect((await resumeBackgroundAwait(cwd, id)).status).toBe("timed_out");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("observer resolves a deadline from the file-backed record", async () => {
    const { cwd, id } = await fixture(new Date(Date.now() - 1).toISOString());
    try { expect((await waitForDurableAwait(cwd, id, { pollMs: 25 })).status).toBe("timed_out"); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
