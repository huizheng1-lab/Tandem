import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
