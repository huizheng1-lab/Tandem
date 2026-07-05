import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function workingTreeDiff(cwd: string): Promise<string> {
  if (await isGitRepo(cwd)) {
    const diff = await execa("git", ["diff", "--", "."], { cwd, reject: false });
    const status = await execa("git", ["status", "--porcelain"], { cwd, reject: false });
    const untracked = status.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .slice(0, 50);
    const untrackedBlocks = await Promise.all(
      untracked.map(async (file) => {
        const fullPath = path.join(cwd, file);
        if (!existsSync(fullPath)) return "";
        try {
          const content = await readFile(fullPath, "utf8");
          return `\n--- untracked ${file}\n${content.slice(0, 4000)}`;
        } catch {
          return `\n--- untracked ${file}\n(binary or unreadable)`;
        }
      })
    );
    return [diff.stdout, ...untrackedBlocks].filter(Boolean).join("\n");
  }
  return "No git repository detected; diff unavailable outside session snapshots.";
}
