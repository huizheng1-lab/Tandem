import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendProjectMemoryNote, formatProjectInstructions, readProjectInstructions } from "../src/session/project-memory.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-project-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("project memory", () => {
  it("reads the first project instructions file", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "AGENTS.md"), "Use single quotes.\n", "utf8");
    await writeFile(path.join(cwd, "CLAUDE.md"), "Use double quotes.\n", "utf8");

    const instructions = await readProjectInstructions(cwd);

    expect(instructions).toMatchObject({ fileName: "AGENTS.md", chars: 19, truncated: false });
    expect(formatProjectInstructions(instructions)).toContain("Project instructions (AGENTS.md):\nUse single quotes.");
  });

  it("prefers TANDEM.md and caps long instructions", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "TANDEM.md"), "x".repeat(100), "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "ignored", "utf8");

    const instructions = await readProjectInstructions(cwd, 40);

    expect(instructions?.fileName).toBe("TANDEM.md");
    expect(instructions?.truncated).toBe(true);
    expect(instructions?.content).toContain("[project instructions truncated]");
  });

  it("appends one-line notes under a TANDEM.md Notes section", async () => {
    const cwd = await tempDir();

    await expect(appendProjectMemoryNote(cwd, "Always use single quotes in JS here")).resolves.toContain("Remembered");
    await expect(appendProjectMemoryNote(cwd, "Always use single quotes in JS here")).resolves.toContain("Already remembered");

    const content = await readFile(path.join(cwd, "TANDEM.md"), "utf8");
    expect(content).toContain("## Notes\n- Always use single quotes in JS here");
    expect(content.match(/Always use single quotes/g)).toHaveLength(1);
  });

  it("creates a Notes section without disturbing later sections", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "TANDEM.md"), "# Project\n\n## Notes\n- Existing\n\n## Build\nKeep this section.\n", "utf8");

    await appendProjectMemoryNote(cwd, "New note");

    const content = await readFile(path.join(cwd, "TANDEM.md"), "utf8");
    expect(content).toContain("## Notes\n- Existing\n- New note\n## Build");
  });
});
