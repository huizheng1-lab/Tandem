import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryWorkspace } from "../src/orchestrator/inventory.js";
import { runOrchestration } from "../src/orchestrator/machine.js";
import type { BuildPlan, CompletionReport, ReviewVerdict } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "reuse",
  objective: "reuse",
  constraints: [],
  tasks: [{ id: "T1", description: "use the artifact" }],
  acceptanceCriteria: ["work/existing.txt"],
  verification: []
};
const verdict: ReviewVerdict = {
  verdict: "approve",
  scores: { correctness: 5, planAdherence: 5, codeQuality: 5 },
  feedback: [],
  userSummary: "finalized"
};

describe("workspace inventory and resume", () => {
  it("records stable artifacts and excludes a partially written artifact from completion", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-inventory-"));
    try {
      await mkdir(path.join(cwd, "work"));
      await writeFile(path.join(cwd, "work", "existing.txt"), "complete");
      await writeFile(path.join(cwd, "work", "render.mp4.partial"), "still writing");
      const inventory = await inventoryWorkspace(cwd, plan);
      expect(inventory.satisfiedCriteria).toEqual(["work/existing.txt"]);
      expect(inventory.completeArtifactCount).toBe(1);
      expect(inventory.incompleteArtifactCount).toBe(1);
      expect(inventory.artifacts.find((artifact) => artifact.path.endsWith("render.mp4.partial"))?.complete).toBe(false);
      expect(inventory.verificationRequired).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips regeneration when all criteria are already satisfied and records the decision", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-resume-"));
    try {
      await mkdir(path.join(cwd, "work"));
      await writeFile(path.join(cwd, "work", "existing.txt"), "complete");
      let builds = 0;
      const report: CompletionReport = {
        status: "complete", summary: "unused", taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [], verificationResults: [], deviationsFromPlan: []
      };
      const result = await runOrchestration({
        cwd, request: "resume", config: { maxReviewRounds: 1, maxParallelWorkers: 1 },
        agents: {
          plan: async () => ({ kind: "plan" as const, plan }),
          build: async () => { builds += 1; return report; },
          review: async () => verdict,
          takeover: async () => ({ report, userSummary: "takeover" })
        }
      });
      expect(result.phase).toBe("DONE");
      expect(builds).toBe(0);
      expect(result.reports[0]?.deviationsFromPlan[0]).toContain("regeneration was skipped");
      expect(result.reports[0]?.workspaceInventory?.completeArtifactCount).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
