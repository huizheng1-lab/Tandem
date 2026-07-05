import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { execa } from "execa";
import fg from "fast-glob";

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function gitDiff(cwd: string): Promise<string> {
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

export async function workingTreeDiff(cwd: string): Promise<string> {
  if (await isGitRepo(cwd)) {
    return gitDiff(cwd);
  }
  return "No git repository detected; diff unavailable outside session snapshots.";
}

type SnapshotValue = string | null;

export class DiffTracker {
  private readonly touchedFiles = new Set<string>();
  private snapshot = new Map<string, SnapshotValue>();

  constructor(
    private readonly cwd: string,
    private readonly fileCap = 500,
    private readonly maxFileBytes = 256 * 1024
  ) {}

  recordTouchedPath(filePath: string): void {
    const relativePath = this.toRelativePath(filePath);
    if (relativePath) this.touchedFiles.add(relativePath);
  }

  async beforeBuild(): Promise<void> {
    if (await isGitRepo(this.cwd)) return;
    this.snapshot = await this.takeSnapshot();
  }

  async diff(): Promise<string> {
    if (await isGitRepo(this.cwd)) return gitDiff(this.cwd);
    const after = await this.takeSnapshot();
    const files = new Set([...this.snapshot.keys(), ...after.keys(), ...this.touchedFiles]);
    const patches: string[] = [];
    for (const file of [...files].sort()) {
      const beforeText = this.snapshot.get(file) ?? null;
      const afterText = after.get(file) ?? null;
      if (beforeText === afterText) continue;
      patches.push(
        createTwoFilesPatch(
          `a/${file}`,
          `b/${file}`,
          beforeText ?? "",
          afterText ?? "",
          beforeText === null ? "missing" : "before",
          afterText === null ? "missing" : "after"
        )
      );
    }
    return patches.join("\n") || "(no file changes detected)";
  }

  private async takeSnapshot(): Promise<Map<string, SnapshotValue>> {
    const files = await fg("**/*", {
      cwd: this.cwd,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ["node_modules/**", ".git/**", ".tandem/**"]
    });
    const scanned = files.map((file) => this.toRelativePath(file)).filter((file): file is string => Boolean(file));
    scanned.sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth === 0 ? left.localeCompare(right) : depth;
    });
    const selected = new Set([...scanned.slice(0, this.fileCap), ...this.touchedFiles]);
    const snapshot = new Map<string, SnapshotValue>();
    for (const file of selected) {
      snapshot.set(file, await this.readSnapshotFile(file));
    }
    return snapshot;
  }

  private toRelativePath(filePath: string): string | undefined {
    const relative = path.isAbsolute(filePath) ? path.relative(this.cwd, filePath) : filePath;
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  }

  private async readSnapshotFile(file: string): Promise<SnapshotValue> {
    const fullPath = path.join(this.cwd, file);
    if (!existsSync(fullPath)) return null;
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) return null;
      if (info.size > this.maxFileBytes) {
        return `[snapshot omitted: ${info.size} bytes exceeds ${this.maxFileBytes} byte limit]`;
      }
      return await readFile(fullPath, "utf8");
    } catch {
      return null;
    }
  }
}

export function createDiffTracker(cwd: string): DiffTracker {
  return new DiffTracker(cwd);
}
