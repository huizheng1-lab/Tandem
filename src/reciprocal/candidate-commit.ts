import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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

type ReciprocalArtifact = NonNullable<CompletionReport["reciprocalArtifact"]>;

interface WishlistItem {
  id: string;
  status: string;
  detail: string;
  metadata: Record<string, string>;
}

function metadata(value: string): Record<string, string> {
  return Object.fromEntries([...value.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g)].map((match) => [match[1], match[2]]));
}

function wishlistItem(board: string, id: string): WishlistItem | undefined {
  for (const line of board.split(/\r?\n/)) {
    const match = /^- \[(?: |x)\] (W\d{4}) \| P[0-3] \| .*? \| ([A-Z_]+)(?:\s+(.*))?$/.exec(line);
    if (!match || match[1] !== id) continue;
    const detail = match[3] ?? "";
    return { id: match[1], status: match[2], detail, metadata: metadata(detail) };
  }
  return undefined;
}

function shaPrefixEqual(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function artifactPath(cwd: string, value: string | undefined, fallback: string): string {
  return path.join(cwd, normalizeReportedPath(value ?? fallback));
}

function artifactEvidenceId(artifact: ReciprocalArtifact): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: artifact.kind,
      wishlistId: artifact.wishlistId,
      sourceSha: artifact.sourceSha,
      buildInfoPath: artifact.buildInfoPath,
      executablePath: artifact.executablePath,
      smoke: artifact.smoke
    }))
    .digest("hex")
    .slice(0, 16);
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
  if (!isRole(options.role) || options.report.status !== "complete") return options.report;
  const expectedBranch = roleBranch[options.role];
  const runner = options.commandRunner ?? defaultRunner;
  const branch = await currentBranchOrUndefined(runner, options.cwd);
  if (branch !== expectedBranch) return options.report;
  if (options.report.filesChanged.length === 0) {
    if (options.report.reciprocalArtifact) return completeReciprocalArtifact(options, options.report.reciprocalArtifact, runner);
    return options.report;
  }
  if (options.report.reciprocalArtifact) {
    throw new Error("Reciprocal artifact completion must not report source filesChanged.");
  }

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

async function completeReciprocalArtifact(
  options: ReciprocalCandidateCommitOptions,
  artifact: ReciprocalArtifact,
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>
): Promise<CompletionReport> {
  if (options.role !== "A") throw new Error("Artifact-only reciprocal completion is reserved for Executor A.");
  if (artifact.kind !== "candidate-preview") throw new Error(`Unsupported reciprocal artifact kind: ${artifact.kind}`);
  if (options.report.filesChanged.length !== 0) throw new Error("Artifact-only reciprocal completion requires zero source filesChanged.");
  if (!artifact.smoke.passed || artifact.smoke.exitCode !== 0) {
    throw new Error(`Candidate preview smoke did not pass: exitCode=${artifact.smoke.exitCode}`);
  }

  const statusLines = (await runRaw(runner, options.cwd, "git", ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (statusLines) throw new Error(`Artifact-only reciprocal completion requires a clean worktree: ${statusLines.replace(/\r?\n/g, "; ")}`);
  const head = await run(runner, options.cwd, "git", ["rev-parse", "HEAD"]);
  if (!shaPrefixEqual(head, artifact.sourceSha)) {
    throw new Error(`Candidate preview source SHA ${artifact.sourceSha} does not match producer HEAD ${head}.`);
  }

  const buildInfoPath = artifactPath(options.cwd, artifact.buildInfoPath, "release/win-unpacked/BUILD_INFO.json");
  const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8")) as { sourceSha?: unknown };
  if (typeof buildInfo.sourceSha !== "string" || !shaPrefixEqual(buildInfo.sourceSha, artifact.sourceSha)) {
    throw new Error(`Candidate preview BUILD_INFO sourceSha ${String(buildInfo.sourceSha)} does not match ${artifact.sourceSha}.`);
  }
  const executablePath = artifactPath(options.cwd, artifact.executablePath, "release/win-unpacked/Tandem.exe");
  const executable = await stat(executablePath);
  if (!executable.isFile()) throw new Error(`Candidate preview executable is missing: ${executablePath}`);

  const relayRoot = relayRootForWorktree(options.cwd);
  if (!relayRoot) throw new Error(`Reciprocal artifact cwd is not under a relay worktrees directory: ${options.cwd}`);
  const boardPath = path.join(relayRoot, "control", "SHARED_DIRECTION.md");
  const item = wishlistItem(await readFile(boardPath, "utf8"), artifact.wishlistId);
  if (!item) throw new Error(`Reciprocal artifact wishlist item was not found: ${artifact.wishlistId}`);
  if (item.status !== "QUEUED" && item.status !== "IN_PROGRESS") {
    throw new Error(`Reciprocal artifact wishlist item ${artifact.wishlistId} is ${item.status}; expected QUEUED or IN_PROGRESS.`);
  }
  if (item.status === "IN_PROGRESS" && item.metadata.role !== options.role) {
    throw new Error(`Reciprocal artifact wishlist item ${artifact.wishlistId} is owned by ${item.metadata.role}; expected ${options.role}.`);
  }
  const directionScript = path.join(options.cwd, "scripts", "reciprocal-direction.ps1");
  if (item.status === "QUEUED") {
    await run(runner, options.cwd, "powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      directionScript,
      "-Action",
      "Start",
      "-Id",
      artifact.wishlistId,
      "-Role",
      options.role
    ]);
  }
  await run(runner, options.cwd, "powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    directionScript,
    "-Action",
    "ArtifactComplete",
    "-Id",
    artifact.wishlistId,
    "-Role",
    options.role,
    "-Commit",
    head,
    "-ArtifactKind",
    artifact.kind,
    "-Evidence",
    artifactEvidenceId(artifact)
  ]);
  await run(runner, options.cwd, "powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(options.cwd, "scripts", "reciprocal-relay.ps1"),
    "-Action",
    "CompleteArtifact",
    "-Role",
    options.role,
    "-Summary",
    options.summary ?? options.report.summary
  ]);

  return {
    ...options.report,
    summary: `${options.report.summary}\n\nReciprocal artifact completed for human review: ${artifact.kind} ${head} (${artifact.wishlistId}).`,
    deviationsFromPlan: [...options.report.deviationsFromPlan, `Tandem app layer completed artifact-only reciprocal item ${artifact.wishlistId} without a source commit`]
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
