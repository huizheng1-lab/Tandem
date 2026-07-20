import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitReciprocalCandidate, prepareReciprocalWorktree } from "../src/reciprocal/candidate-commit.js";
import type { CompletionReport } from "../src/orchestrator/artifacts.js";

async function relayWorktree(): Promise<string> {
  const root = path.join(tmpdir(), `tandem-rec-commit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const cwd = path.join(root, "worktrees", "copy-a");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(root, "control"), { recursive: true });
  await writeFile(
    path.join(root, "control", "SHARED_DIRECTION.md"),
    "# Board\n\n<!-- wishlist-items -->\n- [ ] W1234 | P3 | scratch | IN_PROGRESS role=B started=now\n",
    "utf8"
  );
  return cwd;
}

const report: CompletionReport = {
  status: "complete",
  summary: "update scratch docs",
  taskResults: [{ id: "T1", status: "done" }],
  filesChanged: ["docs/scratch.md"],
  verificationResults: [{ command: "npm run typecheck", passed: true, output: "ok" }],
  deviationsFromPlan: []
};

const artifactReport: CompletionReport = {
  status: "complete",
  summary: "candidate preview built for human review",
  taskResults: [{ id: "T1", status: "done" }],
  filesChanged: [],
  verificationResults: [{ command: "npm run typecheck", passed: true, output: "ok" }],
  deviationsFromPlan: [],
  reciprocalArtifact: {
    kind: "candidate-preview",
    wishlistId: "W1234",
    sourceSha: "abc123",
    buildInfoPath: "release/win-unpacked/BUILD_INFO.json",
    executablePath: "release/win-unpacked/Tandem.exe",
    smoke: { command: "Tandem.exe --smoke", passed: true, exitCode: 0, output: "started and terminated" }
  }
};

async function writeArtifactEvidence(cwd: string, sourceSha = "abc123"): Promise<void> {
  await mkdir(path.join(cwd, "release", "win-unpacked"), { recursive: true });
  await writeFile(path.join(cwd, "release", "win-unpacked", "BUILD_INFO.json"), JSON.stringify({ sourceSha }), "utf8");
  await writeFile(path.join(cwd, "release", "win-unpacked", "Tandem.exe"), "fake exe", "utf8");
}

async function writeQueuedArtifactItem(cwd: string): Promise<void> {
  const relayRoot = path.dirname(path.dirname(cwd));
  await writeFile(
    path.join(relayRoot, "control", "SHARED_DIRECTION.md"),
    "# Board\n\n<!-- wishlist-items -->\n- [ ] W1234 | P0 | Build candidate preview | QUEUED added=now\n",
    "utf8"
  );
}

describe("reciprocal candidate commit", () => {
  it("D133: no-ops outside a git repository instead of failing desktop sessions", async () => {
    const cwd = await relayWorktree();
    const result = await commitReciprocalCandidate({
      cwd,
      role: "B",
      report,
      commandRunner: async () => {
        throw new Error("git branch --show-current failed: fatal: not a git repository (or any of the parent directories): .git");
      }
    });

    await expect(
      prepareReciprocalWorktree({
        cwd,
        role: "B",
        commandRunner: async () => {
          throw new Error("fatal: not a git repository (or any of the parent directories): .git");
        }
      })
    ).resolves.toBeUndefined();
    expect(result).toEqual(report);
  });

  it("refuses forbidden paths before staging", async () => {
    const cwd = await relayWorktree();
    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "B",
        report: { ...report, filesChanged: [".tandem/reciprocal-checkpoint.md"] },
        commandRunner: async () => ({ stdout: "codex/reciprocal-a", stderr: "" })
      })
    ).rejects.toThrow(/forbidden path/);
  });

  it("stages reported files and completes the active relay turn", async () => {
    const cwd = await relayWorktree();
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await commitReciprocalCandidate({
      cwd,
      role: "B",
      report,
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: " M docs/scratch.md\n", stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    expect(calls.some((call) => call.file === "git" && call.args.join(" ") === "add -- docs/scratch.md")).toBe(true);
    expect(calls.some((call) => call.file === "git" && call.args[0] === "commit" && call.args.includes("relay: update scratch docs"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Candidate") && call.args.includes("W1234") && call.args.includes("abc123"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Complete") && call.args.includes("B"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.some((arg) => arg.endsWith("scripts\\continue-reciprocal-automation.ps1")) && call.args.includes("-MaxTransitions") && call.args.includes("3"))).toBe(true);
    expect(result.summary).toContain("abc123");
    expect(result.summary).toContain("Immediate reciprocal continuation attempted");
  });

  it("D162: completes verified artifact-only work without creating a source candidate commit", async () => {
    const cwd = await relayWorktree();
    await writeArtifactEvidence(cwd);
    await writeQueuedArtifactItem(cwd);
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await commitReciprocalCandidate({
      cwd,
      role: "A",
      report: artifactReport,
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-b\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    expect(calls.some((call) => call.file === "git" && call.args[0] === "commit")).toBe(false);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Start") && call.args.includes("W1234") && call.args.includes("A"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("ArtifactComplete") && call.args.includes("candidate-preview"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("CompleteArtifact") && call.args.includes("A"))).toBe(true);
    expect(result.summary).toContain("Reciprocal artifact completed for human review");
  });

  it("D162: refuses artifact-only work with mismatched BUILD_INFO provenance", async () => {
    const cwd = await relayWorktree();
    await writeArtifactEvidence(cwd, "different");
    await writeQueuedArtifactItem(cwd);

    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "A",
        report: artifactReport,
        commandRunner: async (file, args) => {
          if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-b\n", stderr: "" };
          if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
          if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
          return { stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow(/BUILD_INFO sourceSha/);
  });

  it("pre-fast-forwards a clean reciprocal worktree from its peer branch", async () => {
    const cwd = await relayWorktree();
    const calls: Array<{ file: string; args: string[] }> = [];
    await prepareReciprocalWorktree({
      cwd,
      role: "B",
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    expect(calls.some((call) => call.file === "git" && call.args.join(" ") === "merge --ff-only codex/reciprocal-b")).toBe(true);
  });
});
