import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createDiffTracker } from "../src/orchestrator/diff.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-diff-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("non-git diff tracker", () => {
  it("captures edits and touched new files outside git repos", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "existing.txt"), "before\n", "utf8");
    await writeFile(path.join(cwd, "deleted.txt"), "gone\n", "utf8");
    const tracker = createDiffTracker(cwd);
    await tracker.beforeBuild();
    await writeFile(path.join(cwd, "existing.txt"), "after\n", "utf8");
    tracker.recordTouchedPath("new.txt");
    await writeFile(path.join(cwd, "new.txt"), "created\n", "utf8");
    tracker.recordTouchedPath("deleted.txt");
    await rm(path.join(cwd, "deleted.txt"));

    const diff = await tracker.diff();
    expect(diff).toContain("existing.txt");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    expect(diff).toContain("new.txt");
    expect(diff).toContain("+created");
    expect(diff).toContain("deleted.txt");
  });

  it("captures files created without touched-path hints outside git repos", async () => {
    const cwd = await tempDir();
    const tracker = createDiffTracker(cwd);
    await tracker.beforeBuild();

    await writeFile(path.join(cwd, "todo.mjs"), "export const todo = [];\n", "utf8");

    const diff = await tracker.diff();
    expect(diff).toContain("todo.mjs");
    expect(diff).toContain("+export const todo = [];");
  });

  it("uses a binary placeholder for touched binary files outside git repos", async () => {
    const cwd = await tempDir();
    const tracker = createDiffTracker(cwd);
    await tracker.beforeBuild();

    await writeFile(path.join(cwd, "audio.wav"), Buffer.from([82, 73, 70, 70, 0, 1, 2, 3]));
    tracker.recordTouchedPath("audio.wav");

    const diff = await tracker.diff();
    expect(diff).toContain("audio.wav");
    expect(diff).toContain("[binary file, 8 bytes]");
    expect(diff).not.toContain("\0");
  });

  it("captures files created in gitignored subdirectories inside git repos", async () => {
    const cwd = await tempDir();
    await execa("git", ["init"], { cwd });
    await writeFile(path.join(cwd, ".gitignore"), "demo-todo/\n", "utf8");
    const tracker = createDiffTracker(cwd);
    await tracker.beforeBuild();

    await mkdir(path.join(cwd, "demo-todo"), { recursive: true });
    await writeFile(path.join(cwd, "demo-todo", "todo.mjs"), "export const todos = [];\n", "utf8");

    const diff = await tracker.diff();
    expect(diff).toContain("demo-todo/todo.mjs");
    expect(diff).toContain("+export const todos = [];");
  });

  it("uses a binary placeholder for untracked binary files inside git repos", async () => {
    const cwd = await tempDir();
    await execa("git", ["init"], { cwd });

    await writeFile(path.join(cwd, "voice.wav"), Buffer.from([82, 73, 70, 70, 0, 10, 20, 30]));

    const tracker = createDiffTracker(cwd);
    const diff = await tracker.diff();

    expect(diff).toContain("--- untracked voice.wav");
    expect(diff).toContain("[binary file, 8 bytes]");
    expect(diff).not.toContain("\0");
  });
});
