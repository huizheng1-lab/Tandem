import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/fs.js";
import type { ToolActivityEvent } from "../src/tools/fs.js";
import { makeToolSet } from "../src/tools/index.js";
import { bashTool, effectiveBashTimeout, MAX_BASH_TIMEOUT_MS } from "../src/tools/shell.js";
import { isDestructiveCommand } from "../src/tools/permissions.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} is still alive`);
}

async function writeNestedProcessFixture(cwd: string): Promise<void> {
  await writeFile(
    path.join(cwd, "launcher.cjs"),
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["child.cjs"], { stdio: "ignore" });',
      'fs.writeFileSync("child.pid", String(child.pid));',
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(cwd, "child.cjs"),
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'fs.writeFileSync("grandchild.pid", String(grandchild.pid));',
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );
}

describe("tools", () => {
  it("writes, reads, and edits inside cwd", async () => {
    const cwd = await tempDir();
    const ctx = { cwd, permissionMode: "yolo" as const };
    await writeFileTool(ctx, "hello.txt", "hello\nworld");
    expect(await readFile(path.join(cwd, "hello.txt"), "utf8")).toContain("hello");
    await editFileTool(ctx, "hello.txt", "world", "tandem");
    expect(await readFileTool(ctx, "hello.txt")).toContain("2: tandem");
  });

  it("blocks path escapes and destructive commands", async () => {
    const cwd = await tempDir();
    await expect(writeFileTool({ cwd, permissionMode: "yolo" }, "../no.txt", "x")).rejects.toThrow(/escapes/);
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
  });

  it("emits tool activity start and end events with timing", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "hello.txt"), "hello", "utf8");
    const events: ToolActivityEvent[] = [];
    const tools = makeToolSet({ cwd, permissionMode: "yolo", onToolEvent: (event) => events.push(event) }, "worker") as unknown as {
      read_file: { execute(input: { path: string }): Promise<string> };
    };

    await expect(tools.read_file.execute({ path: "hello.txt" })).resolves.toContain("hello");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: "worker", tool: "read_file", target: "hello.txt", phase: "start" });
    expect(events[1]).toMatchObject({ role: "worker", tool: "read_file", target: "hello.txt", phase: "end", ok: true });
    expect(events[1]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("emits failed tool activity events and preserves the thrown error", async () => {
    const cwd = await tempDir();
    const events: ToolActivityEvent[] = [];
    const tools = makeToolSet({ cwd, permissionMode: "yolo", onToolEvent: (event) => events.push(event) }, "leader-readonly") as unknown as {
      read_file: { execute(input: { path: string }): Promise<string> };
    };

    await expect(tools.read_file.execute({ path: "missing.txt" })).rejects.toThrow(/ENOENT|no such file/i);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: "leader", tool: "read_file", target: "missing.txt", phase: "start" });
    expect(events[1]).toMatchObject({ role: "leader", tool: "read_file", target: "missing.txt", phase: "end", ok: false });
    expect(events[1]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("refuses write and bash when the project is Tandem itself", async () => {
    await expect(writeFileTool({ cwd: process.cwd(), permissionMode: "yolo" }, "self-write.txt", "nope")).rejects.toThrow(/Tandem will not modify its own installation/);
    await expect(bashTool({ cwd: process.cwd(), permissionMode: "yolo" }, "echo nope")).rejects.toThrow(/Tandem will not modify its own installation/);
  });

  it("refuses write when the project is inside Tandem and allows a sibling project", async () => {
    await expect(writeFileTool({ cwd: path.join(process.cwd(), "src"), permissionMode: "yolo" }, "self-write.txt", "nope")).rejects.toThrow(/Tandem will not modify its own installation/);
    const cwd = await tempDir();
    await expect(writeFileTool({ cwd, permissionMode: "yolo" }, "ok.txt", "ok")).resolves.toBe("Wrote ok.txt");
  });

  it("refuses bash commands aimed at the Tandem home directory", async () => {
    const cwd = await tempDir();
    await expect(bashTool({ cwd, permissionMode: "yolo" }, "echo nope > ~/.tandem/should-not-write")).rejects.toThrow(/Tandem will not modify its own installation/);
  });

  it("clamps model-provided bash timeouts to the hard cap", () => {
    expect(effectiveBashTimeout(MAX_BASH_TIMEOUT_MS + 1)).toBe(MAX_BASH_TIMEOUT_MS);
    expect(effectiveBashTimeout(500)).toBe(500);
  });

  it.runIf(process.platform === "win32")("cleans up shell child processes that outlive their parent", async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, "spawn-child.cjs"),
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
        "child.unref();",
        'fs.writeFileSync("child.pid", String(child.pid));',
        "setTimeout(() => process.exit(0), 1500);"
      ].join("\n"),
      "utf8"
    );

    const result = await bashTool({ cwd, permissionMode: "yolo" }, "node spawn-child.cjs", 8000);
    const childPid = Number(await readFile(path.join(cwd, "child.pid"), "utf8"));

    expect(result.output).toContain("Cleaned up");
    expect(Number.isInteger(childPid)).toBe(true);
    await expectProcessGone(childPid);
  }, 15000);

  it.runIf(process.platform === "win32")("kills shell child and grandchild processes on timeout", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);

    const result = await bashTool({ cwd, permissionMode: "yolo" }, "node launcher.cjs", 1500);
    const childPid = Number(await readFile(path.join(cwd, "child.pid"), "utf8"));
    const grandchildPid = Number(await readFile(path.join(cwd, "grandchild.pid"), "utf8"));

    expect(result.passed).toBe(false);
    expect(result.output).toContain("timed out");
    await expectProcessGone(childPid);
    await expectProcessGone(grandchildPid);
  }, 15000);

  it.runIf(process.platform === "win32")("aborts running shell commands and kills descendants promptly", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);
    const controller = new AbortController();
    const startedAt = Date.now();
    const run = bashTool({ cwd, permissionMode: "yolo", abortSignal: controller.signal }, "node launcher.cjs", 60000);
    const childPid = Number(await waitForFile(path.join(cwd, "child.pid")));
    const grandchildPid = Number(await waitForFile(path.join(cwd, "grandchild.pid")));

    controller.abort();
    const result = await run;

    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Command aborted");
    await expectProcessGone(childPid);
    await expectProcessGone(grandchildPid);
  }, 15000);
});
