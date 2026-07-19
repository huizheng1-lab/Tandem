import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CompletionReport } from "../orchestrator/artifacts.js";

const execFileAsync = promisify(execFile);

export interface ReciprocalCandidateCommitOptions {
  cwd: string;
  role?: string;
  report: CompletionReport;
  summary?: string;
  commandRunner?: (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

const roleBranch: Record<"A" | "B", string> = {
  A: "codex/reciprocal-b",
  B: "codex/reciprocal-a"
};

const rolePeerBranch: Record<"A" | "B", string> = {
  A: "codex/reciprocal-a",
  B: "codex/reciprocal-b"
};

function isRole(value: string | undefined): value is "A" | "B" {
  return value === "A" || value === "B";
}

function normalizeReportedPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!normalized || path.isAbsolute(value) || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Unsafe reciprocal candidate path: ${value}`);
  }
  return normalized;
}

function assertAllowedCandidatePath(value: string): void {
  const lower = value.toLowerCase();
  const first = lower.split("/")[0] ?? "";
  const basename = lower.split("/").at(-1) ?? lower;
  if (
    first === ".tandem" ||
    lower === "tandem.md" ||
    basename === ".env" ||
    lower.endsWith(".env") ||
    lower.includes("secret") ||
    lower.includes("credential") ||
    first === "node_modules" ||
    first === "release" ||
    first === "dist" ||
    first === "out" ||
    first === "coverage"
  ) {
    throw new Error(`Reciprocal candidate refuses forbidden path: ${value}`);
  }
}

function statusPath(line: string): string | undefined {
  const raw = line.startsWith("?? ") ? line.slice(3) : line.slice(3);
  const pathPart = raw.includes(" -> ") ? raw.split(" -> ").at(-1) : raw;
  return pathPart?.replace(/\\/g, "/").trim();
}

function commitMessage(report: CompletionReport): string {
  const firstLine = report.summary.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() || "reciprocal candidate";
  const text = firstLine.startsWith("relay:") ? firstLine : `relay: ${firstLine}`;
  return text.length <= 120 ? text : text.slice(0, 117).trimEnd() + "...";
}

function relayRootForWorktree(cwd: string): string | undefined {
  const normalized = path.resolve(cwd);
  if (path.basename(path.dirname(normalized)).toLowerCase() !== "worktrees") return undefined;
  return path.dirname(path.dirname(normalized));
}

function activeWishlistId(board: string, role: "A" | "B"): string | undefined {
  for (const line of board.split(/\r?\n/)) {
    const match = /^- \[ \] (W\d{4}) \| .* \| IN_PROGRESS\b/.exec(line);
    if (match && new RegExp(`\\brole=${role}\\b`).test(line)) return match[1];
  }
  return undefined;
}

async function defaultRunner(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

async function run(runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>, cwd: string, file: string, args: string[]): Promise<string> {
  const result = await runner(file, args, cwd);
  return result.stdout.trim();
}

async function runRaw(runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>, cwd: string, file: string, args: string[]): Promise<string> {
  const result = await runner(file, args, cwd);
  return result.stdout;
}

function isNotGitRepositoryError(error: unknown): boolean {
  const text = String(error instanceof Error ? `${error.message}\n${(error as Error & { stderr?: unknown }).stderr ?? ""}` : error);
  return /fatal:\s*not a git repository|not a git repository/i.test(text);
}

async function currentBranchOrUndefined(
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>,
  cwd: string
): Promise<string | undefined> {
  try {
    return await run(runner, cwd, "git", ["branch", "--show-current"]);
  } catch (error) {
    if (isNotGitRepositoryError(error)) return undefined;
    throw error;
  }
}

export async function commitReciprocalCandidate(options: ReciprocalCandidateCommitOptions): Promise<CompletionReport> {
  if (!isRole(options.role) || options.report.status !== "complete" || options.report.filesChanged.length === 0) return options.report;
  const expectedBranch = roleBranch[options.role];
  const runner = options.commandRunner ?? defaultRunner;
  const branch = await currentBranchOrUndefined(runner, options.cwd);
  if (branch !== expectedBranch) return options.report;

  const files = [...new Set(options.report.filesChanged.map(normalizeReportedPath))];
  for (const file of files) assertAllowedCandidatePath(file);

  const statusLines = (await runRaw(runner, options.cwd, "git", ["status", "--porcelain", "--untracked-files=all"]))
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length === 0) return options.report;

  const allowed = new Set(files);
  const dirty = statusLines.map(statusPath).filter((value): value is string => Boolean(value));
  const unexpected = dirty.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Reciprocal candidate has unreported dirty paths: ${unexpected.join(", ")}`);
  }
  const missing = files.filter((file) => !dirty.includes(file));
  if (missing.length > 0) {
    throw new Error(`Reciprocal candidate reported unchanged paths: ${missing.join(", ")}`);
  }

  await run(runner, options.cwd, "git", ["add", "--", ...files]);
  await run(runner, options.cwd, "git", ["commit", "-m", commitMessage(options.report)]);
  const commit = await run(runner, options.cwd, "git", ["rev-parse", "HEAD"]);

  const relayRoot = relayRootForWorktree(options.cwd);
  if (!relayRoot) throw new Error(`Reciprocal candidate cwd is not under a relay worktrees directory: ${options.cwd}`);
  const boardPath = path.join(relayRoot, "control", "SHARED_DIRECTION.md");
  const id = activeWishlistId(await readFile(boardPath, "utf8"), options.role);
  if (id) {
    await run(runner, options.cwd, "powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(options.cwd, "scripts", "reciprocal-direction.ps1"),
      "-Action",
      "Candidate",
      "-Id",
      id,
      "-Commit",
      commit
    ]);
  }
  await run(runner, options.cwd, "powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(options.cwd, "scripts", "reciprocal-relay.ps1"),
    "-Action",
    "Complete",
    "-Role",
    options.role,
    "-Summary",
    options.summary ?? options.report.summary
  ]);

  let continuationNote = "";
  try {
    const continuationOutput = await runRaw(runner, options.cwd, "powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(options.cwd, "scripts", "continue-reciprocal-automation.ps1"),
      "-Workspace",
      options.cwd,
      "-MaxTransitions",
      "3"
    ]);
    continuationNote = `\nImmediate reciprocal continuation attempted: ${continuationOutput.trim()}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    continuationNote = `\nImmediate reciprocal continuation unavailable; scheduled tick fallback remains active: ${message}`;
  }

  return {
    ...options.report,
    summary: `${options.report.summary}\n\nReciprocal relay candidate committed by Tandem app layer: ${commit}${continuationNote}`,
    deviationsFromPlan: [...options.report.deviationsFromPlan, `Tandem app layer created reciprocal relay commit ${commit}`]
  };
}

export async function prepareReciprocalWorktree(options: Omit<ReciprocalCandidateCommitOptions, "report">): Promise<void> {
  if (!isRole(options.role)) return;
  const runner = options.commandRunner ?? defaultRunner;
  const branch = await currentBranchOrUndefined(runner, options.cwd);
  if (branch !== roleBranch[options.role]) return;
  const status = await runRaw(runner, options.cwd, "git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim()) return;
  await run(runner, options.cwd, "git", ["merge", "--ff-only", rolePeerBranch[options.role]]);
}
