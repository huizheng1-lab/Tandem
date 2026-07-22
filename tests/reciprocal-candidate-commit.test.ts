import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitReciprocalCandidate, prepareReciprocalWorktree, recoverReciprocalFinalization } from "../src/reciprocal/candidate-commit.js";
import type { CompletionReport } from "../src/orchestrator/artifacts.js";

async function relayWorktree(): Promise<string> {
  const root = path.join(tmpdir(), `tandem-rec-commit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const cwd = path.join(root, "worktrees", "copy-a");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(root, "control"), { recursive: true });
  await writeFile(
    path.join(root, "control", "WISHLIST.md"),
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

async function writeArtifactEvidence(root: string, sourceSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"): Promise<void> {
  await mkdir(path.join(root, "release", "win-unpacked"), { recursive: true });
  await writeFile(path.join(root, "release", "win-unpacked", "BUILD_INFO.json"), JSON.stringify({ sourceSha }), "utf8");
  await writeFile(path.join(root, "release", "win-unpacked", "Tandem.exe"), "fake exe", "utf8");
}

async function writeQueuedArtifactItem(cwd: string, sourceSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", detail = `QUEUED artifact=candidate-preview source=${sourceSha} declared=now`): Promise<void> {
  const relayRoot = path.dirname(path.dirname(cwd));
  await writeFile(
    path.join(relayRoot, "control", "WISHLIST.md"),
    `# Board\n\n<!-- wishlist-items -->\n- [ ] W1234 | P0 | Build candidate preview | ${detail}\n`,
    "utf8"
  );
}

const producerSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const artifactSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function artifactCommandRunner(calls: Array<{ file: string; args: string[] }>, options: { relayStatus?: Record<string, unknown>; failCompleteArtifact?: boolean } = {}) {
  return async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-b\n", stderr: "" };
    if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
    if (file === "git" && args[0] === "rev-parse") return { stdout: `${producerSha}\n`, stderr: "" };
    if (file === "powershell" && args.includes("Status")) {
      return {
        stdout: JSON.stringify(options.relayStatus ?? {
          phase: "working",
          activeRole: "A",
          baseCommit: producerSha,
          stableCommit: producerSha,
          candidateCommit: null,
          rollbackCommit: null
        }),
        stderr: ""
      };
    }
    if (file === "powershell" && args.includes("CompleteArtifact") && options.failCompleteArtifact) {
      throw new Error("relay close failed");
    }
    return { stdout: "", stderr: "" };
  };
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
        if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify({ phase: "working", activeRole: "B", stableCommit: "base123" }), stderr: "" };
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

  it("finalizes an epic planning turn with its durable ordered-step metadata", async () => {
    const cwd = await relayWorktree();
    const relayRoot = path.dirname(path.dirname(cwd));
    const planPath = "process/reciprocal/epics/W1234-plan.md";
    await mkdir(path.join(cwd, "process", "reciprocal", "epics"), { recursive: true });
    await writeFile(
      path.join(cwd, ...planPath.split("/")),
      "# Plan\n\n## Ordered Steps\n\n- [ ] Step 1: discover\n- [ ] Step 2: propagate\n- [ ] Step 3: recover\n\n## Verification\n\nRun tests.\n",
      "utf8"
    );
    await writeFile(
      path.join(relayRoot, "control", "WISHLIST.md"),
      `# Board\n\n<!-- wishlist-items -->\n- [ ] W1234 | P0 | Environment resolver | IN_PROGRESS epic=true autonomy=full phase=PLAN revision=1 completed=0 plan=${planPath} role=B started=now\n`,
      "utf8"
    );
    const calls: Array<{ file: string; args: string[] }> = [];
    await commitReciprocalCandidate({
      cwd,
      role: "B",
      report: { ...report, filesChanged: [planPath] },
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: ` M ${planPath}\n`, stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify({ phase: "working", activeRole: "B", stableCommit: "base123" }), stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    const candidate = calls.find((call) => call.file === "powershell" && call.args.includes("Candidate"));
    expect(candidate?.args).toEqual(expect.arrayContaining(["-Steps", "3", "-CompletedSteps", "0", "-Plan", planPath]));
  });

  it("finalizes a resumed epic plan with a checked completed-step prefix", async () => {
    const cwd = await relayWorktree();
    const relayRoot = path.dirname(path.dirname(cwd));
    const planPath = "process/reciprocal/epics/W1234-plan.md";
    await mkdir(path.join(cwd, "process", "reciprocal", "epics"), { recursive: true });
    await writeFile(
      path.join(cwd, ...planPath.split("/")),
      "# Plan\n\n## Ordered Steps\n\n- [x] Step 1: accepted baseline\n- [x] Step 2: accepted routing\n- [ ] Step 3: approval integration\n\n## Verification\n\nRun tests.\n",
      "utf8"
    );
    await writeFile(
      path.join(relayRoot, "control", "WISHLIST.md"),
      `# Board\n\n<!-- wishlist-items -->\n- [ ] W1234 | P0 | Remaining step | IN_PROGRESS epic=true autonomy=full phase=PLAN revision=1 completed=0 plan=${planPath} role=B started=now\n`,
      "utf8"
    );
    const calls: Array<{ file: string; args: string[] }> = [];
    await commitReciprocalCandidate({
      cwd,
      role: "B",
      report: { ...report, filesChanged: [planPath] },
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: ` M ${planPath}\n`, stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify({ phase: "working", activeRole: "B", stableCommit: "base123" }), stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });

    const candidate = calls.find((call) => call.file === "powershell" && call.args.includes("Candidate"));
    expect(candidate?.args).toEqual(expect.arrayContaining(["-Steps", "3", "-CompletedSteps", "2", "-Plan", planPath]));
  });

  it("durably recovers a commit when board finalization fails after git commit", async () => {
    const cwd = await relayWorktree();
    const relayRoot = path.dirname(path.dirname(cwd));
    let dirty = true;
    const firstCalls: Array<{ file: string; args: string[] }> = [];
    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "B",
        report,
        commandRunner: async (file, args) => {
          firstCalls.push({ file, args });
          if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
          if (file === "git" && args[0] === "status") return { stdout: dirty ? " M docs/scratch.md\n" : "", stderr: "" };
          if (file === "git" && args[0] === "commit") { dirty = false; return { stdout: "committed\n", stderr: "" }; }
          if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
          if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify({ phase: "working", activeRole: "B", stableCommit: "base123" }), stderr: "" };
          if (file === "powershell" && args.includes("Candidate")) throw new Error("simulated board write interruption");
          return { stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow(/board write interruption/);

    const pendingPath = path.join(relayRoot, "state", "finalization-b.json");
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toMatchObject({ stage: "committed", commit: "abc123", wishlistId: "W1234" });

    const recoveryCalls: Array<{ file: string; args: string[] }> = [];
    let relayState: Record<string, unknown> = {
      phase: "paused",
      pausedFromPhase: "working",
      pauseOrigin: null,
      pauseReasonCode: null,
      lastSummary: "Auto-paused turn 2: executor B received 3 consecutive RESUME claims without completing. Human attention is required before resuming.",
      activeRole: "B",
      stableCommit: "base123"
    };
    const recovered = await recoverReciprocalFinalization({
      cwd,
      role: "B",
      commandRunner: async (file, args) => {
        recoveryCalls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify(relayState), stderr: "" };
        if (file === "powershell" && args.includes("Resume")) {
          relayState = { ...relayState, phase: "working", pausedFromPhase: null, pauseOrigin: null, pauseReasonCode: null };
          return { stdout: JSON.stringify({ outcome: "RESUMED", ...relayState }), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }
    });

    expect(recovered?.summary).toContain("abc123");
    expect(recoveryCalls.filter((call) => call.file === "git" && call.args[0] === "commit")).toHaveLength(0);
    expect(recoveryCalls.some((call) => call.file === "powershell" && call.args.includes("Resume"))).toBe(true);
    expect(recoveryCalls.some((call) => call.file === "powershell" && call.args.includes("Candidate") && call.args.includes("abc123"))).toBe(true);
    expect(recoveryCalls.some((call) => call.file === "powershell" && call.args.includes("Complete"))).toBe(true);
    await expect(readFile(pendingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not auto-resume an explicit human pause while finalization is pending", async () => {
    const cwd = await relayWorktree();
    const relayRoot = path.dirname(path.dirname(cwd));
    const pendingPath = path.join(relayRoot, "state", "finalization-b.json");
    await mkdir(path.dirname(pendingPath), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(pendingPath, JSON.stringify({
      schemaVersion: 1,
      role: "B",
      cwd,
      wishlistId: "W1234",
      files: report.filesChanged,
      report,
      summary: report.summary,
      stage: "committed",
      commit: "abc123",
      createdAt: now,
      updatedAt: now,
    }), "utf8");
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(recoverReciprocalFinalization({
      cwd,
      role: "B",
      commandRunner: async (file, args) => {
        calls.push({ file, args });
        if (file === "git" && args.join(" ") === "branch --show-current") return { stdout: "codex/reciprocal-a\n", stderr: "" };
        if (file === "git" && args[0] === "status") return { stdout: "", stderr: "" };
        if (file === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        if (file === "powershell" && args.includes("Status")) return { stdout: JSON.stringify({ phase: "paused", pausedFromPhase: "working", pauseOrigin: "human", pauseReasonCode: "explicit-human-pause", activeRole: "B", stableCommit: "base123" }), stderr: "" };
        return { stdout: "", stderr: "" };
      }
    })).rejects.toThrow(/requires its working owner/);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Resume"))).toBe(false);
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toMatchObject({ stage: "committed", commit: "abc123" });
  });

  it("D163: completes distinct-topology artifact work from a trusted admin release without creating a source candidate commit", async () => {
    const cwd = await relayWorktree();
    const adminRoot = path.join(path.dirname(path.dirname(cwd)), "admin-root");
    await writeArtifactEvidence(adminRoot, artifactSha);
    await writeQueuedArtifactItem(cwd);
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await commitReciprocalCandidate({
      cwd,
      role: "A",
      artifactRoot: adminRoot,
      report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
      commandRunner: artifactCommandRunner(calls),
      artifactSmokeRunner: async (executablePath, releaseDir, context) => {
        expect(executablePath).toBe(path.join(adminRoot, "release", "win-unpacked", "Tandem.exe"));
        expect(releaseDir).toBe(path.join(adminRoot, "release", "win-unpacked"));
        expect(context.stateRoot).toBe(path.join(path.dirname(path.dirname(cwd)), "state", "candidate-preview-smoke"));
        expect(context.scriptPath).toBe(path.join(cwd, "scripts", "candidate-preview-smoke.ps1"));
        return { exitCode: 0, stdout: "launched and exited", stderr: "" };
      }
    });

    expect(calls.some((call) => call.file === "git" && call.args[0] === "commit")).toBe(false);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Start") && call.args.includes("W1234") && call.args.includes("A"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("ArtifactComplete") && call.args.includes("candidate-preview") && call.args.includes(artifactSha))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("CompleteArtifact") && call.args.includes("A"))).toBe(true);
    expect(result.summary).toContain("Reciprocal artifact completed for human review");
    expect(result.summary).toContain(artifactSha);
    expect(result.summary).toContain(producerSha);
  });

  it("D163: refuses ordinary source items even when the model reports reciprocalArtifact", async () => {
    const cwd = await relayWorktree();
    const adminRoot = path.join(path.dirname(path.dirname(cwd)), "admin-root");
    await writeArtifactEvidence(adminRoot, artifactSha);
    await writeQueuedArtifactItem(cwd, artifactSha, "QUEUED added=now");
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "A",
        artifactRoot: adminRoot,
        report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
        commandRunner: artifactCommandRunner(calls),
        artifactSmokeRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" })
      })
    ).rejects.toThrow(/not declared for artifact kind/);
  });

  it("D163: refuses model-asserted smoke success when the app-layer smoke fails", async () => {
    const cwd = await relayWorktree();
    const adminRoot = path.join(path.dirname(path.dirname(cwd)), "admin-root");
    await writeArtifactEvidence(adminRoot, artifactSha);
    await writeQueuedArtifactItem(cwd);
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "A",
        artifactRoot: adminRoot,
        report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
        commandRunner: artifactCommandRunner(calls),
        artifactSmokeRunner: async () => ({ exitCode: 42, stdout: "", stderr: "launch failed" })
      })
    ).rejects.toThrow(/smoke failed/);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("ArtifactComplete"))).toBe(false);
  });

  it("D163: leaves the board nonterminal when relay artifact close fails before terminal write", async () => {
    const cwd = await relayWorktree();
    const adminRoot = path.join(path.dirname(path.dirname(cwd)), "admin-root");
    await writeArtifactEvidence(adminRoot, artifactSha);
    await writeQueuedArtifactItem(cwd);
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "A",
        artifactRoot: adminRoot,
        report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
        commandRunner: artifactCommandRunner(calls, { failCompleteArtifact: true }),
        artifactSmokeRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" })
      })
    ).rejects.toThrow(/relay close failed/);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("Start"))).toBe(true);
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("ArtifactComplete"))).toBe(false);
  });

  it("D163: retries after relay close by writing the terminal board metadata exactly once", async () => {
    const cwd = await relayWorktree();
    const adminRoot = path.join(path.dirname(path.dirname(cwd)), "admin-root");
    await writeArtifactEvidence(adminRoot, artifactSha);
    await writeQueuedArtifactItem(cwd, artifactSha, `IN_PROGRESS artifact=candidate-preview source=${artifactSha} role=A started=now`);
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await commitReciprocalCandidate({
      cwd,
      role: "A",
      artifactRoot: adminRoot,
      report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
      commandRunner: artifactCommandRunner(calls, { relayStatus: { phase: "idle", activeRole: null, lastCompletedCommit: producerSha } }),
      artifactSmokeRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" })
    });

    expect(calls.some((call) => call.file === "powershell" && call.args.includes("CompleteArtifact"))).toBe(false);
    expect(calls.filter((call) => call.file === "powershell" && call.args.includes("ArtifactComplete"))).toHaveLength(1);
    expect(result.summary).toContain(artifactSha);
  });

  it("D164: refuses legacy board-DONE relay-working split-brain with explicit recovery guidance", async () => {
    const cwd = await relayWorktree();
    await writeQueuedArtifactItem(cwd, artifactSha, `DONE artifact=candidate-preview source=${artifactSha} evidence=abc123 role=A completed=now`);
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(
      commitReciprocalCandidate({
        cwd,
        role: "A",
        report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
        commandRunner: artifactCommandRunner(calls),
      })
    ).rejects.toThrow(/Legacy reciprocal artifact recovery required/);
  });

  it("D164: treats board-DONE and relay-idle as an idempotent artifact completion retry", async () => {
    const cwd = await relayWorktree();
    await writeQueuedArtifactItem(cwd, artifactSha, `DONE artifact=candidate-preview source=${artifactSha} evidence=abc123 role=A completed=now`);
    const calls: Array<{ file: string; args: string[] }> = [];

    const result = await commitReciprocalCandidate({
      cwd,
      role: "A",
      report: { ...artifactReport, reciprocalArtifact: { ...artifactReport.reciprocalArtifact!, sourceSha: artifactSha } },
      commandRunner: artifactCommandRunner(calls, { relayStatus: { phase: "idle", activeRole: null, lastCompletedCommit: producerSha } }),
    });

    expect(result.summary).toContain("already terminal");
    expect(calls.some((call) => call.file === "powershell" && call.args.includes("ArtifactComplete"))).toBe(false);
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
