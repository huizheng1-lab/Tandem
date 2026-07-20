import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeWindows = process.platform === "win32" ? describe : describe.skip;

async function scratch(): Promise<string> {
  const root = path.join(tmpdir(), `tandem-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function runSmoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  try {
    const result = await execFileAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/candidate-preview-smoke.ps1"), ...args], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) as Record<string, unknown> };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      json: failure.stdout ? JSON.parse(failure.stdout) as Record<string, unknown> : {}
    };
  }
}

describeWindows("candidate preview GUI smoke", () => {
  it("D164: treats a responsive long-running GUI process as ready and cleans it up", async () => {
    const root = await scratch();
    const readyFile = path.join(root, "ready.txt");
    const command = path.join(root, "ready.cmd");
    await writeFile(command, `@echo off\r\necho ready>"${readyFile}"\r\ntimeout /t 60 /nobreak >nul\r\n`, "utf8");
    const result = await runSmoke([
      "-ExecutablePath", command,
      "-StateRoot", path.join(root, "state"),
      "-TimeoutSeconds", "5",
      "-ReadyFile", readyFile
    ]);

    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.readiness).toBe("ready-file");
    expect(result.json.stoppedPids).toEqual(expect.arrayContaining([result.json.pid]));
    await expect(readFile(readyFile, "utf8")).resolves.toContain("ready");
    const pidCheck = await execFileAsync("powershell", ["-NoProfile", "-Command", `$p=Get-Process -Id ${result.json.pid} -ErrorAction SilentlyContinue; if ($p) { $p | ConvertTo-Json -Compress }; exit 0`], { windowsHide: true });
    expect(pidCheck.stdout.trim()).toBe("");
  });

  it("D164: reports an early nonzero exit as a crash", async () => {
    const root = await scratch();
    const command = path.join(root, "crash.cmd");
    await writeFile(command, "@echo off\r\nexit /b 42\r\n", "utf8");
    const result = await runSmoke([
      "-ExecutablePath", command,
      "-StateRoot", path.join(root, "state"),
      "-TimeoutSeconds", "5"
    ]);

    expect(result.code).toBe(4);
    expect(result.json.ok).toBe(false);
    expect(result.json.outcome).toBe("crash");
    expect(result.json.exitCode).toBe(42);
  });

  it("D164: times out readiness and cleans up the launched process", async () => {
    const root = await scratch();
    const command = path.join(root, "hang.cmd");
    await writeFile(command, "@echo off\r\ntimeout /t 60 /nobreak >nul\r\n", "utf8");
    const result = await runSmoke([
      "-ExecutablePath", command,
      "-StateRoot", path.join(root, "state"),
      "-TimeoutSeconds", "2"
    ]);

    expect(result.code).toBe(5);
    expect(result.json.ok).toBe(false);
    expect(result.json.outcome).toBe("readiness-timeout");
    expect(result.json.stoppedPids).toEqual(expect.arrayContaining([result.json.pid]));
    const pidCheck = await execFileAsync("powershell", ["-NoProfile", "-Command", `$p=Get-Process -Id ${result.json.pid} -ErrorAction SilentlyContinue; if ($p) { $p | ConvertTo-Json -Compress }; exit 0`], { windowsHide: true });
    expect(pidCheck.stdout.trim()).toBe("");
  });

  it("D164: refuses a missing executable distinctly", async () => {
    const root = await scratch();
    const result = await runSmoke([
      "-ExecutablePath", path.join(root, "missing.exe"),
      "-StateRoot", path.join(root, "state"),
      "-TimeoutSeconds", "2"
    ]);

    expect(result.code).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.outcome).toBe("missing-executable");
  });
});
