import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/fs.js";
import type { ToolActivityEvent } from "../src/tools/fs.js";
import { makeToolSet } from "../src/tools/index.js";
import { backgroundProcessTool, BASH_SETTLE_GRACE_MS, backgroundBridgeEnvironment, bashTool, cleanupBackgroundProcesses, effectiveBashTimeout, listBackgroundProcesses, MAX_BASH_TIMEOUT_MS, startBackgroundProcessBridge, tailOutput } from "../src/tools/shell.js";
import { isDestructiveCommand } from "../src/tools/permissions.js";
import { searchFilesTool } from "../src/tools/search.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  fixtureDirs.add(dir);
  return dir;
}

const fixtureDirs = new Set<string>();
const fixturePids = new Map<number, string>();
const fixtureSurvivors: Array<{ context: string; label: string; pid: number }> = [];

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

async function expectProcessAlive(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Process ${pid} is not alive`);
}

async function waitForProcessGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 75));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} is still alive`);
}

function parseBackgroundId(output: string): string {
  const id = output.match(/Started background process (\S+)/)?.[1];
  if (!id) throw new Error(`Missing background id in output: ${output}`);
  return id;
}

async function readNumberFile(filePath: string, timeoutMs = 3000): Promise<number> {
  return Number((await waitForFile(filePath, timeoutMs)).trim());
}

function killPidIfAlive(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone or not owned by this process.
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killFixturePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { encoding: "utf8", windowsHide: true });
    return;
  }
  killPidIfAlive(pid);
}

function recordFixturePid(pid: number | undefined, label: string): void {
  if (Number.isInteger(pid) && pid! > 0 && pid !== process.pid) fixturePids.set(pid!, label);
}

async function recordFixturePidFile(cwd: string, filename: string, label: string, timeoutMs = 3000): Promise<number> {
  const pid = await readNumberFile(path.join(cwd, filename), timeoutMs);
  recordFixturePid(pid, label);
  return pid;
}

async function recordNestedFixturePids(cwd: string, timeoutMs = 3000): Promise<{ launcherPid: number; childPid: number; grandchildPid: number }> {
  const pids: { launcherPid: number; childPid: number; grandchildPid: number } = {
    launcherPid: 0,
    childPid: 0,
    grandchildPid: 0,
  };
  pids.launcherPid = await recordFixturePidFile(cwd, "launcher.pid", "launcher.cjs", timeoutMs);
  pids.childPid = await recordFixturePidFile(cwd, "child.pid", "child.cjs", timeoutMs);
  pids.grandchildPid = await recordFixturePidFile(cwd, "grandchild.pid", "grandchild", timeoutMs);
  return pids;
}

async function killRecordedFixtureProcesses(pids: Array<number | undefined>): Promise<void> {
  for (const pid of pids) {
    if (!Number.isInteger(pid)) continue;
    killFixturePid(pid!);
    await waitForProcessGone(pid!).catch(() => {});
  }
}

async function sweepRecordedFixtureProcesses(context: string): Promise<void> {
  for (const [pid, label] of fixturePids) {
    if (!isProcessAlive(pid)) {
      fixturePids.delete(pid);
      continue;
    }
    fixtureSurvivors.push({ context, label, pid });
    killFixturePid(pid);
    await waitForProcessGone(pid).catch(() => {});
    fixturePids.delete(pid);
  }
}

async function cleanupFixtureDir(cwd: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(cwd);
  } catch {
    return;
  }
  for (const entry of entries.filter((name) => name.endsWith(".pid"))) {
    try {
      const pid = Number((await readFile(path.join(cwd, entry), "utf8")).trim());
      killPidIfAlive(pid);
      if (Number.isInteger(pid)) await expectProcessGone(pid).catch(() => {});
    } catch {
      // Best-effort cleanup for test fixtures only.
    }
  }
  await rmWithRetry(cwd);
}

async function rmWithRetry(cwd: string, attempts = 5): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(cwd, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  throw lastError;
}

afterEach(async () => {
  await cleanupBackgroundProcesses();
  await sweepRecordedFixtureProcesses("afterEach");
  const dirs = [...fixtureDirs];
  fixtureDirs.clear();
  await Promise.all(dirs.map((dir) => cleanupFixtureDir(dir)));
});

afterAll(async () => {
  await sweepRecordedFixtureProcesses("afterAll");
  if (fixtureSurvivors.length > 0) {
    const details = fixtureSurvivors
      .map(({ context, label, pid }) => `${context}: ${label} pid ${pid}`)
      .join("; ");
    throw new Error(`Nested process fixture survivors were reaped after tests: ${details}`);
  }
});

async function writeNestedProcessFixture(cwd: string): Promise<void> {
  await writeFile(
    path.join(cwd, "launcher.cjs"),
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'fs.writeFileSync("launcher.pid", String(process.pid));',
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
  it("returns bounded, typed glob results with the searched root and explicit no-match status", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "needle.txt"), "needle", "utf8");
    const found = await searchFilesTool({ root: cwd, patterns: ["**/*.txt"] });
    expect(found).toMatchObject({ status: "matched", roots: [path.resolve(cwd)], patterns: ["**/*.txt"] });
    expect(found.matches[0]?.path).toBe(path.join(cwd, "needle.txt"));
    const empty = await searchFilesTool({ root: cwd, patterns: ["**/*.json"] });
    expect(empty).toMatchObject({ status: "no-match", roots: [path.resolve(cwd)], matches: [] });
  });

  it("exposes the search tools to both leader and worker tool sets", () => {
    const ctx = { cwd: process.cwd(), permissionMode: "yolo" as const };
    for (const role of ["leader-readonly", "worker"] as const) {
      const tools = makeToolSet(ctx, role);
      expect(tools).toHaveProperty("glob");
      expect(tools).toHaveProperty("grep");
    }
  });

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

  it("sanitizes prompt-unsafe control characters from captured shell output", async () => {
    expect(tailOutput("a\0b\x1Bc\nok\tkept")).toBe("abc\nok\tkept");

    const cwd = await tempDir();
    const result = await bashTool({ cwd, permissionMode: "yolo" }, "node -e \"process.stdout.write(Buffer.from([97,0,98]))\"");

    expect(result.passed).toBe(true);
    expect(result.output).toBe("ab");
    expect(result.output).not.toContain("\0");
  });

  it("sanitizes prompt-unsafe control characters from read_file output", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "binary-ish.txt"), "one\0two\x1B\nthree", "utf8");

    await expect(readFileTool({ cwd }, "binary-ish.txt")).resolves.toBe("1: onetwo\n2: three");
  });

  describe("isDestructiveCommand regression set (D56)", () => {
    // D56-1: the original bug - the bare-word `\bformat\b/i` matched the very common
    // ffprobe/ffmpeg idiom `-show_entries format=duration`, hard-blocking it as "destructive"
    // even with full permissions (the gate runs BEFORE the yolo bypass).
    it("does NOT flag the exact bug-report ffprobe command", () => {
      expect(
        isDestructiveCommand(
          'ffprobe -v error -print_format json -show_format "...tandem-explainer-en.mp4"'
        )
      ).toBe(false);
    });

    it("does NOT flag common ffprobe invocations for the format/duration idiom", () => {
      const cmds = [
        'ffprobe -v error -print_format json -show_format "input.mp4"',
        'ffprobe -v error -show_streams "input.mp4"',
        'ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height "input.mp4"',
        'ffprobe -v quiet -of csv=p=0 -show_entries format=duration "input.mp4"',
        'ffprobe -show_entries format=duration -of default=noprint_wrappers=1 file.mkv'
      ];
      for (const cmd of cmds) expect(isDestructiveCommand(cmd), cmd).toBe(false);
    });

    it("does NOT flag common ffmpeg invocations", () => {
      const cmds = [
        "ffmpeg -i in.mp4 -vf scale=1280:720 out.mp4",
        'ffmpeg -i "input with spaces.mov" -c:v libx264 -crf 18 -preset slow output.mp4',
        "ffmpeg -formats",
        "ffmpeg -codecs | grep -E 'encoders'",
        "ffplay input.mp4",
        "ffprobe -v error -print_format json file.mkv"
      ];
      for (const cmd of cmds) expect(isDestructiveCommand(cmd), cmd).toBe(false);
    });

    it("does NOT flag `format=...` flag-style usage anywhere (other patterns audited)", () => {
      // The D55 allowlist doesn't apply here - this test guards every pattern in
      // destructivePatterns against flag-style false positives.
      const cmds = [
        "ffprobe -show_entries format=duration",
        "somebinary --format json",
        "convert input.png -format png output.png",
        "magick -format '%w' input.png"
      ];
      for (const cmd of cmds) expect(isDestructiveCommand(cmd), cmd).toBe(false);
    });

    it("STILL flags real disk-format commands (positive regression guards)", () => {
      const cmds = [
        "format C:",
        "format c:",
        "format /FS:NTFS C:",
        "format C: /FS:exFAT /Q",
        "format D: /FS:FAT32 /V:STICK",
        "format a:"
      ];
      for (const cmd of cmds) expect(isDestructiveCommand(cmd), cmd).toBe(true);
    });

    it("STILL flags rm -rf root variants and other unchanged patterns", () => {
      expect(isDestructiveCommand("rm -rf /")).toBe(true);
      expect(isDestructiveCommand("rm -rf ~")).toBe(true);
      // The /usr/local/bin variant still matches because the regex matches the leading `rm -rf /`.
      // This is a known over-match in the destructivePatterns set (out of scope for D56-1).
      expect(isDestructiveCommand("rm -rf /usr/local/bin")).toBe(true);
      // Truncated rm -rf (e.g. only `rm -rf file.txt` without a leading root) does not match.
      expect(isDestructiveCommand("rm -rf build/")).toBe(false);
      expect(isDestructiveCommand("del /f C:\\Windows\\System32\\foo.dll")).toBe(true);
      // Fork bomb
      expect(isDestructiveCommand(":(){ :|:& };:")).toBe(true);
    });
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

  it("registers remember for leader and worker roles", async () => {
    const cwd = await tempDir();
    const remembered: Array<{ text: string; by: "leader" | "worker" }> = [];
    const ctx = {
      cwd,
      permissionMode: "yolo" as const,
      rememberNote: async (text: string, by: "leader" | "worker") => {
        remembered.push({ text, by });
        return `Remembered: ${text}`;
      }
    };
    const leaderTools = makeToolSet(ctx, "leader-readonly") as unknown as { remember: { execute(input: { text: string }): Promise<string> } };
    const workerTools = makeToolSet(ctx, "worker") as unknown as { remember: { execute(input: { text: string }): Promise<string> } };

    await expect(leaderTools.remember.execute({ text: "Use single quotes" })).resolves.toContain("Remembered");
    await expect(workerTools.remember.execute({ text: "Run npm test" })).resolves.toContain("Remembered");

    expect(remembered).toEqual([
      { text: "Use single quotes", by: "leader" },
      { text: "Run npm test", by: "worker" }
    ]);
  });

  it("rejects oversized remember notes", async () => {
    const cwd = await tempDir();
    const tools = makeToolSet({ cwd, permissionMode: "yolo", rememberNote: async () => "ok" }, "worker") as unknown as {
      remember: { execute(input: { text: string }): Promise<string> };
    };

    await expect(tools.remember.execute({ text: "x".repeat(301) })).rejects.toThrow(/300 characters or fewer/);
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

  it("keeps background shell processes alive after the originating call while foreground calls settle", async () => {
    const cwd = await tempDir();
    const ctx = { cwd, permissionMode: "yolo" as const };
    await writeFile(
      path.join(cwd, "pid-wait.cjs"),
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.argv[2], String(process.pid));',
        "setTimeout(() => process.exit(0), Number(process.argv[3] || 1200));"
      ].join("\n"),
      "utf8"
    );

    const background = await bashTool(ctx, "node pid-wait.cjs bg.pid 2500", 120000, true);
    const id = parseBackgroundId(background.output);
    const bgPid = await readNumberFile(path.join(cwd, "bg.pid"));
    try {
      await expectProcessAlive(bgPid);
      expect(listBackgroundProcesses().some((entry) => entry.id === id && entry.status === "running")).toBe(true);
    } finally {
      await backgroundProcessTool("stop", id).catch(() => "");
    }
    await waitForProcessGone(bgPid);

    const foreground = await bashTool(ctx, "node pid-wait.cjs fg.pid 50", 5000);
    const fgPid = await readNumberFile(path.join(cwd, "fg.pid"));
    expect(foreground.passed).toBe(true);
    await expectProcessGone(fgPid);
  }, 15000);

  it("reads background output produced after start and drains consecutive reads", async () => {
    const cwd = await tempDir();
    const ctx = { cwd, permissionMode: "yolo" as const };
    const result = await bashTool(ctx, "node -e \"setTimeout(()=>console.log('late-output'),150); setTimeout(()=>{},1500)\"", 120000, true);
    const id = parseBackgroundId(result.output);
    try {
      const deadline = Date.now() + 3000;
      let output = "";
      while (Date.now() < deadline) {
        output = await backgroundProcessTool("read", id);
        if (output.includes("late-output")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(output).toContain("late-output");
      expect(await backgroundProcessTool("read", id)).not.toContain("late-output");
    } finally {
      await backgroundProcessTool("stop", id).catch(() => "");
    }
  }, 10000);

  it.runIf(process.platform === "win32")("stops a background process and its descendants", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);
    let id = "";
    let rootPid: number | undefined;
    let launcherPid: number | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const result = await bashTool({ cwd, permissionMode: "yolo" }, "node launcher.cjs", 120000, true);
      id = parseBackgroundId(result.output);
      rootPid = listBackgroundProcesses().find((entry) => entry.id === id)?.pid;
      recordFixturePid(rootPid, "background launcher root");
      ({ launcherPid, childPid, grandchildPid } = await recordNestedFixturePids(cwd));

      await backgroundProcessTool("stop", id);

      if (rootPid) await waitForProcessGone(rootPid);
      await expectProcessGone(childPid);
      await expectProcessGone(grandchildPid);
      expect(listBackgroundProcesses().some((entry) => entry.id === id)).toBe(false);
    } finally {
      if (id) await backgroundProcessTool("stop", id).catch(() => "");
      await killRecordedFixtureProcesses([rootPid, launcherPid, childPid, grandchildPid]);
    }
  }, 15000);

  it.runIf(process.platform === "win32")("cleanupBackgroundProcesses sweeps unstopped background process trees", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);
    let rootPid: number | undefined;
    let launcherPid: number | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const result = await bashTool({ cwd, permissionMode: "yolo" }, "node launcher.cjs", 120000, true);
      const id = parseBackgroundId(result.output);
      rootPid = listBackgroundProcesses().find((entry) => entry.id === id)?.pid;
      recordFixturePid(rootPid, "background cleanup root");
      ({ launcherPid, childPid, grandchildPid } = await recordNestedFixturePids(cwd));

      await cleanupBackgroundProcesses();

      if (rootPid) await waitForProcessGone(rootPid);
      await expectProcessGone(childPid);
      await expectProcessGone(grandchildPid);
      expect(listBackgroundProcesses()).toEqual([]);
    } finally {
      await cleanupBackgroundProcesses();
      await killRecordedFixtureProcesses([rootPid, launcherPid, childPid, grandchildPid]);
    }
  }, 15000);

  it.runIf(process.platform === "win32")("does not leave background orphans after the owning Node process exits", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);
    const runner = path.join(cwd, "owner-exits.mts");
    const shellModule = pathToFileURL(path.resolve(process.cwd(), "src", "tools", "shell.ts")).href;
    await writeFile(
      runner,
      [
        `import { bashTool, listBackgroundProcesses } from "${shellModule}";`,
        'import { writeFileSync } from "node:fs";',
        "async function main() {",
        '  const cwd = process.argv[2];',
        '  const result = await bashTool({ cwd, permissionMode: "yolo" }, "node launcher.cjs", 120000, true);',
        '  const id = result.output.match(/Started background process (\\S+)/)?.[1] || "";',
        '  const pid = listBackgroundProcesses().find((entry) => entry.id === id)?.pid;',
        '  writeFileSync(`${cwd}/owner-bg.json`, JSON.stringify({ id, pid }));',
        "}",
        "main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });"
      ].join("\n"),
      "utf8"
    );

    let pid: number | undefined;
    let launcherPid: number | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const owner = spawn(process.execPath, ["--import", "tsx", runner, cwd], { cwd: process.cwd(), windowsHide: true });
      recordFixturePid(owner.pid, "owner-exits runner");
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        owner.stderr.on("data", (chunk) => { stderr += chunk; });
        owner.on("error", reject);
        owner.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`owner exited ${code}: ${stderr}`)));
      });
      ({ pid } = JSON.parse(await readFile(path.join(cwd, "owner-bg.json"), "utf8")) as { id: string; pid?: number });
      recordFixturePid(pid, "owner background root");
      ({ launcherPid, childPid, grandchildPid } = await recordNestedFixturePids(cwd, 5000));

      if (pid) await waitForProcessGone(pid);
      await expectProcessGone(childPid);
      await expectProcessGone(grandchildPid);
    } finally {
      await killRecordedFixtureProcesses([pid, launcherPid, childPid, grandchildPid]);
    }
  }, 20000);

  it("lists real background status transitions for exited and stopped commands", async () => {
    const cwd = await tempDir();
    const ctx = { cwd, permissionMode: "yolo" as const };
    const short = await bashTool(ctx, "node -e \"setTimeout(()=>process.exit(7),50)\"", 120000, true);
    const shortId = parseBackgroundId(short.output);
    const stop = await bashTool(ctx, "node -e \"setTimeout(()=>{},3000)\"", 120000, true);
    const stopId = parseBackgroundId(stop.output);
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const exited = listBackgroundProcesses().find((entry) => entry.id === shortId);
        if (exited?.status === "exited") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(listBackgroundProcesses().find((entry) => entry.id === shortId)).toMatchObject({ status: "exited", exitCode: 7 });
      await backgroundProcessTool("stop", stopId);
      expect(listBackgroundProcesses().some((entry) => entry.id === stopId)).toBe(false);
    } finally {
      await backgroundProcessTool("stop", shortId).catch(() => "");
      await backgroundProcessTool("stop", stopId).catch(() => "");
    }
  }, 10000);

  it("keeps destructive and self-protection gates in force for background bash", async () => {
    const cwd = await tempDir();
    await expect(bashTool({ cwd, permissionMode: "yolo" }, "rm -rf /", 120000, true)).rejects.toThrow(/Blocked destructive command/);
    await expect(bashTool({ cwd: process.cwd(), permissionMode: "yolo" }, "echo nope", 120000, true)).rejects.toThrow(/Tandem will not modify its own installation/);
    expect(listBackgroundProcesses()).toEqual([]);
  });

  it("reports background read and stop id errors", async () => {
    await expect(backgroundProcessTool("read")).rejects.toThrow(/A background process id is required/);
    await expect(backgroundProcessTool("stop")).rejects.toThrow(/A background process id is required/);
    await expect(backgroundProcessTool("read", "missing-bg-id")).rejects.toThrow(/Unknown background process id/);
    await expect(backgroundProcessTool("stop", "missing-bg-id")).rejects.toThrow(/Unknown background process id/);
  });

  it("exposes the same registry to a CLI bridge across separate command calls", async () => {
    const cwd = await tempDir();
    const bridge = await startBackgroundProcessBridge();
    const env = backgroundBridgeEnvironment(process.env, bridge);
    const request = async (action: "start" | "read" | "stop", id?: string, command?: string) => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/background`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action, id, command, cwd })
      });
      const body = await response.json() as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error);
      return body.result;
    };
    const result = String(await request("start", undefined, "node -e \"setTimeout(()=>console.log('cli-bridge-output'),120); setTimeout(()=>{},1500)\""));
    const id = String(result.match(/Started background process (\S+)/)?.[1]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect.poll(async () => String(await request("read", id))).toContain("cli-bridge-output");
      await request("stop", id);
      expect(listBackgroundProcesses().some((entry) => entry.id === id)).toBe(false);
      expect(env.TANDEM_BACKGROUND_PORT).toBe(String(bridge.port));
    } finally {
      await cleanupBackgroundProcesses();
    }
  });

  it("applies the active Tandem permission bridge before a CLI background start", async () => {
    // Must run outside the Tandem repo itself: assertSafeBash rejects self-modification
    // before ensurePermission is ever consulted, which would mask the permission check.
    const cwd = await tempDir();
    const bridge = await startBackgroundProcessBridge(undefined, "ask", {
      approve: async () => false
    });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/background`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "start", command: "node -e \"setInterval(()=>{},1000)\"", cwd })
    });
    const body = await response.json() as { error?: string };
    expect(response.ok).toBe(false);
    expect(body.error).toMatch(/Permission denied|required/i);
    expect(listBackgroundProcesses()).toEqual([]);
  });

  it("reports an immediate CLI background-start failure with the command and bridge error", async () => {
    const cwd = await tempDir();
    const bridge = await startBackgroundProcessBridge();
    const response = await fetch(`http://127.0.0.1:${bridge.port}/background`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "start", command: "node -e \"console.error('launcher exploded'); process.exit(17)\"", cwd })
    });
    const body = await response.json() as { error?: string };
    expect(response.ok).toBe(false);
    expect(body.error).toMatch(/Tandem background-start failure/);
    expect(body.error).toMatch(/node -e/);
    expect(body.error).toMatch(/CLI bridge \/background/);
    expect(body.error).toMatch(/launcher exploded/);
    await cleanupBackgroundProcesses();
  });

  it("keeps the admitted CLI authorization context for an in-flight start", async () => {
    const cwd = await tempDir();
    let approveRequest: (() => void) | undefined;
    let approvalSeen: (() => void) | undefined;
    const approvalObserved = new Promise<void>((resolve) => { approvalSeen = resolve; });
    const bridge = await startBackgroundProcessBridge(undefined, "ask", {
      approve: async () => {
        approvalSeen?.();
        await new Promise<void>((resolve) => { approveRequest = resolve; });
        return true;
      }
    });
    try {
      const request = fetch(`http://127.0.0.1:${bridge.port}/background`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "start", command: "node -e \"setTimeout(()=>{},3000)\"", cwd })
      });
      await approvalObserved;

      // Refreshing the shared bridge for a read-only CLI turn must not mutate
      // the authorization decision already in progress for the writable turn.
      await startBackgroundProcessBridge(cwd, "ask", undefined, true);
      approveRequest?.();
      const response = await request;
      const body = await response.json() as { ok?: boolean; result?: string; error?: string };
      expect(response.ok).toBe(true);
      expect(body.ok).toBe(true);
      const id = body.result?.match(/Started background process (\S+)/)?.[1];
      expect(id).toBeTruthy();
      await backgroundProcessTool("stop", id);
    } finally {
      approveRequest?.();
      await cleanupBackgroundProcesses();
    }
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

    let launcherPid: number | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const result = await bashTool({ cwd, permissionMode: "yolo" }, "node launcher.cjs", 1500);
      ({ launcherPid, childPid, grandchildPid } = await recordNestedFixturePids(cwd));

      expect(result.passed).toBe(false);
      expect(result.output).toContain("timed out");
      await expectProcessGone(launcherPid);
      await expectProcessGone(childPid);
      await expectProcessGone(grandchildPid);
    } finally {
      await killRecordedFixtureProcesses([launcherPid, childPid, grandchildPid]);
    }
  }, 15000);

  it.runIf(process.platform === "win32")("returns by the hard deadline when a detached descendant holds the output pipe open", async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, "pipe-parent.cjs"),
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
        'fs.writeFileSync("child.pid", String(child.pid));',
        "child.unref();",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );
    const toolTimeoutMs = 500;
    const startedAt = Date.now();

    let childPid: number | undefined;
    try {
      const result = await bashTool({ cwd, permissionMode: "yolo" }, "node pipe-parent.cjs", toolTimeoutMs);
      const elapsedMs = Date.now() - startedAt;
      childPid = await recordFixturePidFile(cwd, "child.pid", "pipe-parent child");

      expect(result.passed).toBe(false);
      expect(result.output).toContain(`Command timed out after ${toolTimeoutMs}ms`);
      expect(elapsedMs).toBeGreaterThanOrEqual(toolTimeoutMs);
      expect(elapsedMs).toBeLessThan(toolTimeoutMs + BASH_SETTLE_GRACE_MS + 2000);
    } finally {
      await killRecordedFixtureProcesses([childPid]);
    }
  }, 10000);

  it.runIf(process.platform === "win32")("aborts running shell commands and kills descendants promptly", async () => {
    const cwd = await tempDir();
    await writeNestedProcessFixture(cwd);
    const controller = new AbortController();
    const startedAt = Date.now();
    let launcherPid: number | undefined;
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    const run = bashTool({ cwd, permissionMode: "yolo", abortSignal: controller.signal }, "node launcher.cjs", 60000);
    try {
      ({ launcherPid, childPid, grandchildPid } = await recordNestedFixturePids(cwd));

      controller.abort();
      const result = await run;

      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(result.passed).toBe(false);
      expect(result.output).toContain("Command aborted");
      await expectProcessGone(launcherPid);
      await expectProcessGone(childPid);
      await expectProcessGone(grandchildPid);
    } finally {
      controller.abort();
      await run.catch(() => undefined);
      await killRecordedFixtureProcesses([launcherPid, childPid, grandchildPid]);
    }
  }, 15000);
});
