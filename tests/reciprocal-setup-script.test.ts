import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("reciprocal setup script", () => {
  it("D134: generates fresh executor configs with a reciprocal-safe step budget", async () => {
    const script = await readFile(path.resolve("scripts", "setup-reciprocal-tandem.ps1"), "utf8");

    expect(script).toContain("$reciprocalMaxStepsPerAgentTurn = 250");
    expect(script).toContain("-not (Test-Path -LiteralPath $targetConfig)");
    expect(script).toContain("$config.maxStepsPerAgentTurn = $reciprocalMaxStepsPerAgentTurn");
  });

  it.skipIf(process.platform !== "win32")("D182: Role=Both stops a stale isolated B during normal A startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reciprocal-startup-"));
    try {
      const relayRoot = path.join(root, "relay");
      const repoRoot = path.join(root, "repo");
      const scriptDir = path.join(repoRoot, "scripts");
      const stateDir = path.join(repoRoot, ".git", "tandem-relay");
      const runtimeA = path.join(relayRoot, "runtimes", "executor-a");
      const runtimeB = path.join(relayRoot, "runtimes", "executor-b");
      await mkdir(scriptDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(runtimeA, { recursive: true });
      await mkdir(runtimeB, { recursive: true });
      await mkdir(path.join(relayRoot, "worktrees", "copy-a"), { recursive: true });
      await mkdir(path.join(relayRoot, "worktrees", "copy-b"), { recursive: true });
      await copyFile(path.resolve("scripts", "start-reciprocal-tandem.ps1"), path.join(scriptDir, "start-reciprocal-tandem.ps1"));
      const powershellExe = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      await copyFile(powershellExe, path.join(runtimeA, "Tandem.exe"));
      await copyFile(powershellExe, path.join(runtimeB, "Tandem.exe"));
      await writeFile(path.join(stateDir, "state.json"), `${JSON.stringify({ phase: "idle", activeRole: null }, null, 2)}\n`, "utf8");

      const staleB = spawn(path.join(runtimeB, "Tandem.exe"), ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], {
        cwd: runtimeB,
        windowsHide: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(staleB.exitCode).toBeNull();

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn("powershell", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(scriptDir, "start-reciprocal-tandem.ps1"),
          "-Role",
          "Both",
          "-RelayRoot",
          relayRoot,
          "-AutomationPortA",
          "49111",
          "-AutomationPortB",
          "49112",
        ], { cwd: repoRoot, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("Stopping stale executor B");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(staleB.exitCode).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
