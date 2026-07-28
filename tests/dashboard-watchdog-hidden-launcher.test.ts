import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("D208 dashboard watchdog hidden launcher", () => {
  it("registers the watchdog task through wscript instead of direct powershell", async () => {
    const source = await readFile(path.resolve("dashboard-source/reciprocal-control-panel/register-dashboard-watchdog-task.ps1"), "utf8");
    expect(source).not.toContain('New-ScheduledTaskAction -Execute "powershell.exe"');
    expect(source).toContain("dashboard-hidden-launcher.vbs");
    expect(source).toContain("System32\\wscript.exe");
    expect(source).toContain("Get-Command powershell.exe");
    expect(source).toContain("-RepetitionInterval");
  });

  windowsIt("runs the wrapped watchdog command hidden and preserves exit codes in wait mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-hidden-launcher-"));
    const launcher = path.resolve("dashboard-source/reciprocal-control-panel/dashboard-hidden-launcher.vbs");
    const log = path.join(root, "launcher.log");
    const okScript = path.join(root, "ok.ps1");
    const failScript = path.join(root, "fail.ps1");
    await writeFile(okScript, `Set-Content -LiteralPath "${log}" -Value "ok"; exit 0\n`, "utf8");
    await writeFile(failScript, `Add-Content -LiteralPath "${log}" -Value "fail"; exit 7\n`, "utf8");

    const ok = await execa("wscript.exe", [launcher, "--wait", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", okScript], { reject: false });
    expect(ok.exitCode).toBe(0);
    expect(await readFile(log, "utf8")).toContain("ok");

    const failed = await execa("wscript.exe", [launcher, "--wait", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", failScript], { reject: false });
    expect(failed.exitCode).toBe(7);
    expect(await readFile(log, "utf8")).toContain("fail");
  });

  windowsIt("defaults to detached hidden launch for repeating watchdog ticks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-hidden-detached-"));
    const launcher = path.resolve("dashboard-source/reciprocal-control-panel/dashboard-hidden-launcher.vbs");
    const marker = path.join(root, "detached.done");
    const script = path.join(root, "detached.ps1");
    await writeFile(script, `Start-Sleep -Milliseconds 700; Set-Content -LiteralPath "${marker}" -Value "done"\n`, "utf8");

    const started = Date.now();
    const run = await execa("wscript.exe", [launcher, "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { reject: false });
    expect(run.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(650);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        expect(await readFile(marker, "utf8")).toContain("done");
        await rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("Detached launcher command did not complete");
  });
});
