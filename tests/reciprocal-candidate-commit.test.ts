import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitReciprocalCandidate } from "../src/reciprocal/candidate-commit.js";
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

describe("reciprocal candidate commit", () => {
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
    expect(result.summary).toContain("abc123");
  });
});
