import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/fs.js";
import { bashTool } from "../src/tools/shell.js";
import { isDestructiveCommand } from "../src/tools/permissions.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
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
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});
