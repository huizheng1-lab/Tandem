import { mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { tandemStateDir } from "../src/paths.js";

async function stopProcess(processHandle: ReturnType<typeof spawn> | undefined) {
  if (!processHandle?.pid) return;
  try {
    processHandle.kill("SIGKILL");
  } catch {
  }
  await new Promise<void>((resolve) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 5000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("Tandem home test isolation", () => {
  it("resolves default Tandem state under the suite TANDEM_HOME", () => {
    expect(process.env.TANDEM_HOME).toBeTruthy();
    expect(tandemStateDir()).toBe(path.resolve(process.env.TANDEM_HOME!));
    expect(tandemStateDir()).not.toBe(path.join(homedir(), ".tandem"));
  });

  it("does not fail when an external process writes to the real Tandem home", async () => {
    const realHome = path.join(homedir(), ".tandem");
    const marker = path.join(realHome, `d223-external-writer-${process.pid}.txt`);
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(realHome, { recursive: true });
      writer = spawn(process.execPath, [
        "-e",
        "const fs=require('fs'); const p=process.argv[1]; setInterval(() => fs.appendFileSync(p, 'external\\n'), 25);",
        marker,
      ], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(tandemStateDir()).toBe(path.resolve(process.env.TANDEM_HOME!));
      expect(existsSync(marker)).toBe(true);
    } finally {
      await stopProcess(writer);
      await unlink(marker).catch(() => {});
    }
  });

  it("fails fast if code under test resolves the real Tandem home", async () => {
    const result = await execa(process.execPath, [
      "--import",
      "tsx",
      "-e",
      "delete process.env.TANDEM_HOME; process.env.TANDEM_TEST_REAL_HOME_GUARD='1'; const { tandemStateDir } = await import('./src/paths.ts'); tandemStateDir();",
    ], { cwd: path.resolve("."), reject: false });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Test attempted to resolve the real Tandem home");
  });
});
