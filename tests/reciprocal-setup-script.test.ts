import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { describe, expect, it } from "vitest";

describe("reciprocal setup script", () => {
  async function freePort() {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  async function stopProcess(pid: number | undefined) {
    if (!pid) return;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  it("D134: generates fresh executor configs with a reciprocal-safe step budget", async () => {
    const script = await readFile(path.resolve("scripts", "setup-reciprocal-tandem.ps1"), "utf8");

    expect(script).toContain("$reciprocalMaxStepsPerAgentTurn = 250");
    expect(script).toContain("-not (Test-Path -LiteralPath $targetConfig)");
    expect(script).toContain("$config.maxStepsPerAgentTurn = $reciprocalMaxStepsPerAgentTurn");
  });

  it.skipIf(process.platform !== "win32")("D182: Role=Both stops a stale isolated B during normal A startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reciprocal-startup-"));
    let startedAPid: number | undefined;
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
      const automationPortA = await freePort();
      const automationPortB = await freePort();
      await copyFile(path.resolve("scripts", "start-reciprocal-tandem.ps1"), path.join(scriptDir, "start-reciprocal-tandem.ps1"));
      const powershellExe = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      await copyFile(process.execPath, path.join(runtimeA, "Tandem.exe"));
      await copyFile(powershellExe, path.join(runtimeB, "Tandem.exe"));
      await writeFile(path.join(runtimeA, "BUILD_INFO.json"), `${JSON.stringify({
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        packageIdentity: "package-a",
        reciprocalCapabilities: { role: "A", passiveRuntime: true },
      }, null, 2)}\n`, "utf8");
      await writeFile(path.join(runtimeB, "BUILD_INFO.json"), `${JSON.stringify({
        sourceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        packageIdentity: "package-b",
        reciprocalCapabilities: { role: "B", passiveRuntime: true },
      }, null, 2)}\n`, "utf8");
      const fakeRuntime = path.join(root, "fake-runtime.mjs");
      await writeFile(fakeRuntime, `
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";

const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf("=");
  return index === -1 ? [arg, ""] : [arg.slice(0, index), arg.slice(index + 1)];
}));
const port = Number(args.get("--automation-port"));
const tokenFile = args.get("--automation-token-file");
const projectDir = args.get("--automation-project-dir");
const token = "startup-token";
const buildInfo = JSON.parse(await readFile(process.env.TANDEM_RUNTIME_BUILD_INFO, "utf8"));
await writeFile(tokenFile, JSON.stringify({ port, token, pid: process.pid }, null, 2));
http.createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    ok: true,
    pid: process.pid,
    projectDir,
    tokenFile,
    sourceSha: buildInfo.sourceSha,
    packageIdentity: buildInfo.packageIdentity,
    capabilities: buildInfo.reciprocalCapabilities,
  }));
  setImmediate(() => process.exit(0));
}).listen(port, "127.0.0.1");
`, "utf8");
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
          String(automationPortA),
          "-AutomationPortB",
          String(automationPortB),
        ], {
          cwd: repoRoot,
          env: {
            ...process.env,
            TANDEM_EXECUTOR_A_NODE_ENTRY: fakeRuntime,
          },
          windowsHide: true,
        });
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
      const tokenFile = path.join(relayRoot, "state", "executor-a", "automation.json");
      const token = JSON.parse(await readFile(tokenFile, "utf8"));
      startedAPid = token.pid;
      expect(token.pid).toEqual(expect.any(Number));
      const status = await fetch(`http://127.0.0.1:${token.port}/status`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body.pid).toBe(token.pid);
      expect(body.projectDir).toBe(path.join(relayRoot, "worktrees", "copy-b"));
      expect(body.sourceSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(body.packageIdentity).toBe("package-a");
      await stopProcess(startedAPid);
      startedAPid = undefined;
    } finally {
      await stopProcess(startedAPid);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
