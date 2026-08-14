import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DURABLE_AWAIT_MIN_WAKEUP_MS, extendDurableAwait, registerBackgroundAwait, resumeBackgroundAwait, suspendOnBackgroundAwait, waitForDurableAwait } from "../src/orchestrator/await.js";
import { runOrchestration, runOrchestrationDurably, type OrchestrationCheckpoint } from "../src/orchestrator/machine.js";
import type { BuildPlan, CompletionReport, ReviewVerdict } from "../src/orchestrator/artifacts.js";
import { backgroundProcessTool, bashTool } from "../src/tools/shell.js";

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
  it("uses the supplied duration estimate and never persists a sub-minute wakeup", async () => {
    const cwd = path.join(tmpdir(), `tandem-await-floor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    const started = await bashTool({ cwd, permissionMode: "yolo" }, "Start-Sleep -Seconds 5", 5_000, true);
    const processId = started.output.match(/Started background process (\S+)/)?.[1];
    if (!processId) throw new Error(`background process did not start: ${started.output}`);
    try {
      const before = Date.now();
      const record = await registerBackgroundAwait({
        cwd,
        processId,
        timeoutMs: 1_000,
        expectedDurationMs: 120_000,
        safetyMarginMs: 30_000,
        id: "estimated-render"
      });
      const interval = Date.parse(record.wakeupDeadlineAt ?? record.deadlineAt) - before;
      expect(interval).toBeGreaterThanOrEqual(149_000);
      expect(record.wakeupIntervalMs).toBe(150_000);
      expect(record.minimumWakeupIntervalMs).toBe(DURABLE_AWAIT_MIN_WAKEUP_MS);
    } finally {
      await backgroundProcessTool("stop", processId).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the floor across repeated re-registration of a live process", async () => {
    const cwd = path.join(tmpdir(), `tandem-await-reregister-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    const started = await bashTool({ cwd, permissionMode: "yolo" }, "Start-Sleep -Seconds 5", 5_000, true);
    const processId = started.output.match(/Started background process (\S+)/)?.[1];
    if (!processId) throw new Error(`background process did not start: ${started.output}`);
    try {
      const initial = await registerBackgroundAwait({ cwd, processId, timeoutMs: 1_000, id: "repeated-render" });
      let current = initial;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        current = await extendDurableAwait(cwd, current.id, 1_000);
        expect(current.wakeupIntervalMs).toBeGreaterThanOrEqual(DURABLE_AWAIT_MIN_WAKEUP_MS);
        expect(Date.parse(current.wakeupDeadlineAt ?? current.deadlineAt)).toBeGreaterThan(Date.now() + 55_000);
      }
    } finally {
      await backgroundProcessTool("stop", processId).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a live render parked through an early wakeup and resumes without takeover", async () => {
    const cwd = path.join(tmpdir(), `tandem-live-await-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    const started = await bashTool({ cwd, permissionMode: "yolo" }, "Start-Sleep -Milliseconds 150", 5_000, true);
    const processId = started.output.match(/Started background process (\S+)/)?.[1];
    if (!processId) throw new Error(`background process did not start: ${started.output}`);
    let builds = 0;
    let takeovers = 0;
    const phases: string[] = [];
    const events: Array<{ type: string; name?: string; message?: string; checkpointDir?: string }> = [];
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
          events.push({
            type: event.type,
            name: event.type === "artifact" ? event.name : undefined,
            message: event.type === "notice" || event.type === "transition" ? event.message : undefined,
            checkpointDir: event.type === "checkpoint" ? event.checkpoint.projectDir : undefined
          });
        }
      });
      expect(result.phase).toBe("DONE");
      expect(result.takeover).toBe(false);
      expect(builds).toBe(2);
      expect(takeovers).toBe(0);
      expect(phases).toContain("PARKED");
      expect(phases.indexOf("DONE")).toBeGreaterThan(phases.indexOf("PARKED"));
      const parkIndex = events.findIndex((event) => event.type === "transition" && event.message?.includes("parked"));
      const doneIndex = events.findIndex((event) => event.type === "transition" && event.message?.includes("approved"));
      expect(events.slice(parkIndex + 1, doneIndex)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "WorkspaceInventory" }),
        expect.objectContaining({ message: expect.stringContaining("Decision precedence") })
      ]));
      expect(events.filter((event) => event.type === "checkpoint").every((event) => event.checkpointDir === cwd)).toBe(true);
    } finally {
      await resumeBackgroundAwait(cwd, "live-render").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses the parked checkpoint directory for every resume even when the live selection changes", async () => {
    const projectDir = path.join(tmpdir(), `tandem-captured-await-${Date.now()}`);
    const otherDir = path.join(tmpdir(), `tandem-other-await-${Date.now()}`);
    await mkdir(path.join(projectDir, ".tandem", "awaits"), { recursive: true });
    await writeFile(path.join(projectDir, ".tandem", "awaits", "captured.json"), JSON.stringify({
      id: "captured", condition: "background_process", processId: "gone", pid: 2147483647,
      deadlineAt: new Date(Date.now() - 1).toISOString(), status: "suspended", createdAt: new Date().toISOString(), round: 1
    }));
    const checkpointDirs: string[] = [];
    try {
      const result = await runOrchestration({
        cwd: otherDir,
        request: "resume",
        config: { maxReviewRounds: 1, maxParallelWorkers: 1 },
        initialState: { phase: "PARKED", projectDir, round: 1, plan, reports: [], verdicts: [], feedbackHistory: [], parkedAwaitId: "captured", parkedProcessId: "gone" },
        agents: { plan: async () => ({ kind: "plan", plan }), build: async () => report, review: async () => verdict, takeover: async () => ({ report, userSummary: "takeover" }) },
        emit: (event) => { if (event.type === "checkpoint") checkpointDirs.push(event.checkpoint.projectDir ?? ""); }
      });
      expect(result.phase).toBe("DONE");
      expect(checkpointDirs).toContain(projectDir);
      expect(checkpointDirs).not.toContain(otherDir);
      expect((await resumeBackgroundAwait(projectDir, "captured")).status).toBe("timed_out");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("reports a missing await record with process identity and recovery location", async () => {
    const projectDir = path.join(tmpdir(), `tandem-missing-await-${Date.now()}`);
    try {
      const result = await runOrchestration({
        cwd: path.join(tmpdir(), "wrong-live-selection"),
        request: "resume",
        config: { maxReviewRounds: 1, maxParallelWorkers: 1 },
        initialState: { phase: "PARKED", projectDir, round: 1, plan, reports: [], verdicts: [], feedbackHistory: [], parkedAwaitId: "missing", parkedProcessId: "bg-recovery" },
        agents: { plan: async () => ({ kind: "plan", plan }), build: async () => report, review: async () => verdict, takeover: async () => ({ report, userSummary: "takeover" }) }
      });
      expect(result.phase).toBe("DONE");
      expect(result.summary).toContain("bg-recovery");
      expect(result.summary).toContain(projectDir);
      expect(result.summary).toContain("Completed output may exist");
    } finally { await rm(projectDir, { recursive: true, force: true }); }
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
