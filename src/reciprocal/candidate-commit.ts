import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CompletionReport } from "../orchestrator/artifacts.js";

const execFileAsync = promisify(execFile);

export interface ReciprocalCandidateCommitOptions {
  cwd: string;
  role?: string;
  report: CompletionReport;
  summary?: string;
  artifactRoot?: string;
  commandRunner?: (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  artifactSmokeRunner?: (executablePath: string, cwd: string, context: ArtifactSmokeContext) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
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

interface ArtifactSmokeContext {
  stateRoot: string;
  scriptPath: string;
  timeoutSeconds: number;
}

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

async function planCandidateArguments(cwd: string, item: WishlistItem): Promise<string[]> {
  if (item.metadata.epic !== "true" || item.metadata.phase !== "PLAN") return [];
  const planPath = item.metadata.plan?.replace(/\\/g, "/");
  if (!planPath || !/^process\/reciprocal\/epics\/W\d{4}-plan\.md$/.test(planPath)) {
    throw new Error(`Epic ${item.id} has an invalid plan path.`);
  }
  const plan = await readFile(path.join(cwd, ...planPath.split("/")), "utf8");
  const lines = plan.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === "## Ordered Steps");
  const sectionEnd = sectionStart < 0 ? sectionStart : lines.findIndex((line, index) => index > sectionStart && /^##\s/.test(line));
  const section = sectionStart < 0 ? "" : lines.slice(sectionStart + 1, sectionEnd < 0 ? undefined : sectionEnd).join("\n");
  const stepNumbers = [...section.matchAll(/^- \[ \] Step (\d+):\s+.+$/gm)].map((match) => Number(match[1]));
  if (stepNumbers.length === 0 || stepNumbers.some((value, index) => value !== index + 1)) {
    throw new Error(`Epic ${item.id} plan must contain contiguous unchecked Ordered Steps starting at Step 1.`);
  }
  return ["-Steps", String(stepNumbers.length), "-Plan", planPath];
}

function shaPrefixEqual(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function canonicalArtifactRoot(relayRoot: string, configuredRoot: string | undefined): string {
  return path.resolve(
    configuredRoot ??
      process.env.TANDEM_RECIPROCAL_ARTIFACT_ROOT ??
      process.env.TANDEM_SOURCE_REPO ??
      path.join(path.dirname(relayRoot), "HZ code")
  );
}

function assertUnderRoot(value: string, root: string): string {
  const resolved = path.resolve(value);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact evidence path escapes trusted release directory: ${resolved}`);
  }
  return resolved;
}

function artifactEvidenceId(values: { kind: string; wishlistId: string; sourceSha: string; smokeOutput: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 16);
}

interface RelayStatus {
  phase?: string | null;
  pausedFromPhase?: string | null;
  pauseOrigin?: string | null;
  pauseReasonCode?: string | null;
  activeRole?: string | null;
  baseCommit?: string | null;
  stableCommit?: string | null;
  candidateCommit?: string | null;
  rollbackCommit?: string | null;
  lastCompletedCommit?: string | null;
  lastSummary?: string | null;
}

interface PendingFinalization {
  schemaVersion: 1;
  role: "A" | "B";
  cwd: string;
  wishlistId: string;
  files: string[];
  report: CompletionReport;
  summary: string;
  stage: "reported" | "committed" | "board-recorded";
  commit?: string;
  createdAt: string;
  updatedAt: string;
}

function pendingFinalizationPath(relayRoot: string, role: "A" | "B"): string {
  return path.join(relayRoot, "state", `finalization-${role.toLowerCase()}.json`);
}

async function readPendingFinalization(relayRoot: string, role: "A" | "B"): Promise<PendingFinalization | undefined> {
  try {
    const value = JSON.parse(await readFile(pendingFinalizationPath(relayRoot, role), "utf8")) as PendingFinalization;
    if (value.schemaVersion !== 1 || value.role !== role || !Array.isArray(value.files) || !value.report) {
      throw new Error(`Invalid reciprocal finalization record for role ${role}.`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePendingFinalization(relayRoot: string, value: PendingFinalization): Promise<void> {
  const target = pendingFinalizationPath(relayRoot, value.role);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function clearPendingFinalization(relayRoot: string, role: "A" | "B"): Promise<void> {
  await unlink(pendingFinalizationPath(relayRoot, role)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function canCloseArtifactRelay(state: RelayStatus, head: string): boolean {
  const working = state.phase === "working" || (state.phase === "paused" && state.pausedFromPhase === "working");
  return Boolean(
    working &&
      state.activeRole === "A" &&
      state.baseCommit &&
      state.baseCommit === state.stableCommit &&
      state.baseCommit === head &&
      !state.candidateCommit &&
      !state.rollbackCommit
  );
}

function alreadyClosedArtifactRelay(state: RelayStatus, head: string): boolean {
  return Boolean(state.phase === "idle" && !state.activeRole && state.lastCompletedCommit === head);
}

async function readRelayStatus(
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>,
  cwd: string
): Promise<RelayStatus> {
  return JSON.parse(
    await run(runner, cwd, "powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(cwd, "scripts", "reciprocal-relay.ps1"),
      "-Action",
      "Status"
    ])
  ) as RelayStatus;
}

async function defaultRunner(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

async function defaultArtifactSmokeRunner(executablePath: string, cwd: string, context: ArtifactSmokeContext): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        context.scriptPath,
        "-ExecutablePath",
        executablePath,
        "-StateRoot",
        context.stateRoot,
        "-TimeoutSeconds",
        String(context.timeoutSeconds)
      ],
      { cwd, windowsHide: true, timeout: (context.timeoutSeconds + 10) * 1000, maxBuffer: 1024 * 1024 }
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean; signal?: unknown };
    if (failure.killed) {
      throw new Error(`Candidate preview smoke timed out: ${failure.message}`);
    }
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : failure.message
    };
  }
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

function samePaths(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isRecoverableMachinePause(state: RelayStatus): boolean {
  if (state.pauseOrigin === "machine" && state.pauseReasonCode === "repeated-genuine-blocker") return true;
  return Boolean(
    !state.pauseOrigin &&
      !state.pauseReasonCode &&
      state.lastSummary &&
      /^Auto-paused turn \d+: executor [AB] received \d+ consecutive RESUME claims without completing\./.test(state.lastSummary)
  );
}

async function runRelay(
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>,
  cwd: string,
  args: string[]
): Promise<string> {
  return run(runner, cwd, "powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(cwd, "scripts", "reciprocal-relay.ps1"),
    ...args
  ]);
}

async function runDirection(
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>,
  cwd: string,
  args: string[]
): Promise<string> {
  return run(runner, cwd, "powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(cwd, "scripts", "reciprocal-direction.ps1"),
    ...args
  ]);
}

async function ensurePendingCommit(
  pending: PendingFinalization,
  relayRoot: string,
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>
): Promise<PendingFinalization> {
  const statusLines = (await runRaw(runner, pending.cwd, "git", ["status", "--porcelain", "--untracked-files=all"]))
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length > 0) {
    const dirty = statusLines.map(statusPath).filter((value): value is string => Boolean(value));
    const unexpected = dirty.filter((file) => !pending.files.includes(file));
    if (unexpected.length > 0) throw new Error(`Reciprocal candidate has unreported dirty paths: ${unexpected.join(", ")}`);
    const missing = pending.files.filter((file) => !dirty.includes(file));
    if (missing.length > 0) throw new Error(`Reciprocal candidate reported unchanged paths: ${missing.join(", ")}`);
    if (pending.commit) throw new Error(`Reciprocal finalization ${pending.commit} has new dirty paths and cannot be replayed safely.`);
    await run(runner, pending.cwd, "git", ["add", "--", ...pending.files]);
    await run(runner, pending.cwd, "git", ["commit", "-m", commitMessage(pending.report)]);
    pending.commit = await run(runner, pending.cwd, "git", ["rev-parse", "HEAD"]);
    pending.stage = "committed";
    await writePendingFinalization(relayRoot, pending);
    return pending;
  }

  const head = await run(runner, pending.cwd, "git", ["rev-parse", "HEAD"]);
  if (pending.commit) {
    if (head !== pending.commit) throw new Error(`Pending reciprocal finalization expected HEAD ${pending.commit}, but found ${head}.`);
    return pending;
  }

  const state = await readRelayStatus(runner, pending.cwd);
  if (!state.stableCommit) throw new Error("Pending reciprocal finalization cannot recover without a stable relay commit.");
  const commits = (await runRaw(runner, pending.cwd, "git", ["rev-list", `${state.stableCommit}..${head}`]))
    .split(/\r?\n/)
    .filter(Boolean);
  if (commits.length < 1) {
    throw new Error(`Pending reciprocal finalization found no app-layer commit above stable ${state.stableCommit}.`);
  }
  const changed = (await runRaw(runner, pending.cwd, "git", ["diff", "--name-only", state.stableCommit, head, "--"]))
    .split(/\r?\n/)
    .map((value) => value.replace(/\\/g, "/").trim())
    .filter(Boolean);
  if (!samePaths(changed, pending.files)) {
    throw new Error("Pending reciprocal finalization found commits that do not exactly match the reported files.");
  }
  if (commits.length === 1) {
    const parent = await run(runner, pending.cwd, "git", ["rev-parse", `${head}^`]);
    if (parent !== state.stableCommit) throw new Error("Pending reciprocal finalization commit is not a direct child of the stable base.");
  } else {
    const merges = (await runRaw(runner, pending.cwd, "git", ["rev-list", "--merges", `${state.stableCommit}..${head}`])).trim();
    const subjects = (await runRaw(runner, pending.cwd, "git", ["log", "--format=%s", `${state.stableCommit}..${head}`]))
      .split(/\r?\n/)
      .filter(Boolean);
    const touched = (await runRaw(runner, pending.cwd, "git", ["log", "--format=", "--name-only", `${state.stableCommit}..${head}`, "--"]))
      .split(/\r?\n/)
      .map((value) => value.replace(/\\/g, "/").trim())
      .filter(Boolean);
    if (merges || subjects.length !== commits.length || subjects.some((subject) => !subject.startsWith("relay:")) || touched.some((file) => !pending.files.includes(file))) {
      throw new Error("Pending reciprocal finalization refuses a multi-commit range unless every commit is linear, app-layer-authored, and limited to the reported files.");
    }
  }
  pending.commit = head;
  pending.stage = "committed";
  await writePendingFinalization(relayRoot, pending);
  return pending;
}

async function finalizePendingCandidate(
  pending: PendingFinalization,
  relayRoot: string,
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>
): Promise<CompletionReport> {
  pending = await ensurePendingCommit(pending, relayRoot, runner);
  const commit = pending.commit as string;
  let state = await readRelayStatus(runner, pending.cwd);

  if (state.candidateCommit === commit && state.phase === "passive-testing") {
    await clearPendingFinalization(relayRoot, pending.role);
    return {
      ...pending.report,
      summary: `${pending.report.summary}\n\nReciprocal relay candidate finalization was already complete: ${commit}`,
      deviationsFromPlan: [...pending.report.deviationsFromPlan, `Tandem app layer recovered already-completed reciprocal relay commit ${commit}`]
    };
  }

  if (
    state.phase === "paused" &&
    state.pausedFromPhase === "working" &&
    isRecoverableMachinePause(state) &&
    state.activeRole === pending.role
  ) {
    await runRelay(runner, pending.cwd, [
      "-Action",
      "Resume",
      "-Summary",
      `App-layer recovery is finalizing durable candidate ${commit}; no new agent turn is required.`
    ]);
    state = await readRelayStatus(runner, pending.cwd);
  }

  if (state.phase !== "working" || state.activeRole !== pending.role) {
    throw new Error(`Pending reciprocal finalization requires its working owner; phase=${state.phase ?? "unknown"}, owner=${state.activeRole ?? "none"}.`);
  }

  const boardPath = path.join(relayRoot, "control", "WISHLIST.md");
  const item = wishlistItem(await readFile(boardPath, "utf8"), pending.wishlistId);
  if (!item) throw new Error(`Pending reciprocal wishlist item was not found: ${pending.wishlistId}`);
  if (item.status === "IN_PROGRESS") {
    const planArgs = await planCandidateArguments(pending.cwd, item);
    await runDirection(runner, pending.cwd, ["-Action", "Candidate", "-Id", pending.wishlistId, "-Commit", commit, ...planArgs]);
    pending.stage = "board-recorded";
    await writePendingFinalization(relayRoot, pending);
  } else if (item.status !== "CANDIDATE" || !item.metadata.commit || !shaPrefixEqual(item.metadata.commit, commit)) {
    throw new Error(`Pending reciprocal wishlist item ${pending.wishlistId} is ${item.status} with incompatible candidate metadata.`);
  }

  await runRelay(runner, pending.cwd, [
    "-Action",
    "Complete",
    "-Role",
    pending.role,
    "-Summary",
    pending.summary
  ]);
  await clearPendingFinalization(relayRoot, pending.role);

  let continuationNote = "";
  try {
    const continuationOutput = await runRaw(runner, pending.cwd, "powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(pending.cwd, "scripts", "continue-reciprocal-automation.ps1"),
      "-Workspace",
      pending.cwd,
      "-MaxTransitions",
      "3"
    ]);
    continuationNote = `\nImmediate reciprocal continuation attempted: ${continuationOutput.trim()}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    continuationNote = `\nImmediate reciprocal continuation unavailable; scheduled tick fallback remains active: ${message}`;
  }

  return {
    ...pending.report,
    summary: `${pending.report.summary}\n\nReciprocal relay candidate committed by Tandem app layer: ${commit}${continuationNote}`,
    deviationsFromPlan: [...pending.report.deviationsFromPlan, `Tandem app layer created reciprocal relay commit ${commit}`]
  };
}

export async function recoverReciprocalFinalization(
  options: Omit<ReciprocalCandidateCommitOptions, "report">
): Promise<CompletionReport | undefined> {
  if (!isRole(options.role)) return undefined;
  const runner = options.commandRunner ?? defaultRunner;
  const branch = await currentBranchOrUndefined(runner, options.cwd);
  if (branch !== roleBranch[options.role]) return undefined;
  const relayRoot = relayRootForWorktree(options.cwd);
  if (!relayRoot) return undefined;
  const pending = await readPendingFinalization(relayRoot, options.role);
  if (!pending) return undefined;
  if (path.resolve(pending.cwd).toLowerCase() !== path.resolve(options.cwd).toLowerCase()) {
    throw new Error(`Pending reciprocal finalization belongs to ${pending.cwd}, not ${options.cwd}.`);
  }
  return finalizePendingCandidate(pending, relayRoot, runner);
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

  const relayRoot = relayRootForWorktree(options.cwd);
  if (!relayRoot) throw new Error(`Reciprocal candidate cwd is not under a relay worktrees directory: ${options.cwd}`);
  const boardPath = path.join(relayRoot, "control", "WISHLIST.md");
  const id = activeWishlistId(await readFile(boardPath, "utf8"), options.role);
  if (!id) throw new Error(`Reciprocal candidate has no active wishlist item owned by role ${options.role}.`);
  const existing = await readPendingFinalization(relayRoot, options.role);
  if (existing) {
    if (!samePaths(existing.files, files)) throw new Error("A different reciprocal app-layer finalization is already pending.");
    return finalizePendingCandidate(existing, relayRoot, runner);
  }
  const now = new Date().toISOString();
  const pending: PendingFinalization = {
    schemaVersion: 1,
    role: options.role,
    cwd: path.resolve(options.cwd),
    wishlistId: id,
    files,
    report: options.report,
    summary: options.summary ?? options.report.summary,
    stage: "reported",
    createdAt: now,
    updatedAt: now
  };
  await writePendingFinalization(relayRoot, pending);
  return finalizePendingCandidate(pending, relayRoot, runner);
}

async function completeReciprocalArtifact(
  options: ReciprocalCandidateCommitOptions,
  artifact: ReciprocalArtifact,
  runner: NonNullable<ReciprocalCandidateCommitOptions["commandRunner"]>
): Promise<CompletionReport> {
  if (options.role !== "A") throw new Error("Artifact-only reciprocal completion is reserved for Executor A.");
  if (artifact.kind !== "candidate-preview") throw new Error(`Unsupported reciprocal artifact kind: ${artifact.kind}`);
  if (options.report.filesChanged.length !== 0) throw new Error("Artifact-only reciprocal completion requires zero source filesChanged.");

  const statusLines = (await runRaw(runner, options.cwd, "git", ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (statusLines) throw new Error(`Artifact-only reciprocal completion requires a clean worktree: ${statusLines.replace(/\r?\n/g, "; ")}`);
  const head = await run(runner, options.cwd, "git", ["rev-parse", "HEAD"]);

  const relayRoot = relayRootForWorktree(options.cwd);
  if (!relayRoot) throw new Error(`Reciprocal artifact cwd is not under a relay worktrees directory: ${options.cwd}`);
  const boardPath = path.join(relayRoot, "control", "WISHLIST.md");
  const item = wishlistItem(await readFile(boardPath, "utf8"), artifact.wishlistId);
  if (!item) throw new Error(`Reciprocal artifact wishlist item was not found: ${artifact.wishlistId}`);
  let relayStatus: RelayStatus | undefined;
  if (item.status === "DONE") {
    if (item.metadata.artifact === artifact.kind && item.metadata.source && (!artifact.sourceSha || shaPrefixEqual(item.metadata.source, artifact.sourceSha))) {
      relayStatus = await readRelayStatus(runner, options.cwd);
      if (!alreadyClosedArtifactRelay(relayStatus, head)) {
        if (canCloseArtifactRelay(relayStatus, head)) {
          throw new Error(`Legacy reciprocal artifact recovery required: ${artifact.wishlistId} is DONE but relay phase is ${relayStatus.phase}; run reciprocal-relay CompleteArtifact for role A before treating it as terminal.`);
        }
        throw new Error(`Reciprocal artifact item ${artifact.wishlistId} is DONE but relay is not closed: phase=${relayStatus.phase ?? "unknown"} activeRole=${relayStatus.activeRole ?? "none"}.`);
      }
      return {
        ...options.report,
        summary: `${options.report.summary}\n\nReciprocal artifact item ${artifact.wishlistId} was already terminal for source ${item.metadata.source}.`,
        deviationsFromPlan: [...options.report.deviationsFromPlan, `Tandem app layer observed already-completed reciprocal artifact item ${artifact.wishlistId}`]
      };
    }
    throw new Error(`Reciprocal artifact wishlist item ${artifact.wishlistId} is already DONE with incompatible metadata.`);
  }
  if (item.status !== "QUEUED" && item.status !== "IN_PROGRESS") {
    throw new Error(`Reciprocal artifact wishlist item ${artifact.wishlistId} is ${item.status}; expected QUEUED or IN_PROGRESS.`);
  }
  if (item.metadata.artifact !== artifact.kind) {
    throw new Error(`Wishlist item ${artifact.wishlistId} is not declared for artifact kind ${artifact.kind}.`);
  }
  const artifactSource = item.metadata.source;
  if (!artifactSource || !/^[0-9a-f]{7,40}$/i.test(artifactSource)) {
    throw new Error(`Wishlist item ${artifact.wishlistId} is missing trusted artifact source metadata.`);
  }
  if (artifact.sourceSha && !shaPrefixEqual(artifactSource, artifact.sourceSha)) {
    throw new Error(`Report artifact source ${artifact.sourceSha} does not match trusted wishlist source ${artifactSource}.`);
  }
  if (item.status === "IN_PROGRESS" && item.metadata.role !== options.role) {
    throw new Error(`Reciprocal artifact wishlist item ${artifact.wishlistId} is owned by ${item.metadata.role}; expected ${options.role}.`);
  }

  relayStatus ??= await readRelayStatus(runner, options.cwd);
  const relayCanClose = canCloseArtifactRelay(relayStatus, head);
  const relayAlreadyClosed = alreadyClosedArtifactRelay(relayStatus, head);
  if (!relayCanClose && !relayAlreadyClosed) {
    throw new Error(`Artifact relay is not in a safe no-commit close state: phase=${relayStatus.phase ?? "unknown"} activeRole=${relayStatus.activeRole ?? "none"}.`);
  }
  if (relayAlreadyClosed && item.status === "QUEUED") {
    throw new Error(`Artifact relay is already idle but wishlist item ${artifact.wishlistId} was never started.`);
  }

  const artifactRoot = canonicalArtifactRoot(relayRoot, options.artifactRoot);
  const releaseDir = path.join(artifactRoot, "release", "win-unpacked");
  const buildInfoPath = assertUnderRoot(path.join(releaseDir, "BUILD_INFO.json"), releaseDir);
  const executablePath = assertUnderRoot(path.join(releaseDir, "Tandem.exe"), releaseDir);
  const buildInfo = JSON.parse((await readFile(buildInfoPath, "utf8")).replace(/^\uFEFF/, "")) as { sourceSha?: unknown };
  if (typeof buildInfo.sourceSha !== "string" || !shaPrefixEqual(buildInfo.sourceSha, artifactSource)) {
    throw new Error(`Candidate preview BUILD_INFO sourceSha ${String(buildInfo.sourceSha)} does not match trusted source ${artifactSource}.`);
  }
  const executable = await stat(executablePath);
  if (!executable.isFile()) throw new Error(`Candidate preview executable is missing: ${executablePath}`);
  const smokeRunner = options.artifactSmokeRunner ?? defaultArtifactSmokeRunner;
  const smokeContext = {
    stateRoot: path.join(relayRoot, "state", "candidate-preview-smoke"),
    scriptPath: path.join(options.cwd, "scripts", "candidate-preview-smoke.ps1"),
    timeoutSeconds: Number(process.env.TANDEM_CANDIDATE_PREVIEW_SMOKE_TIMEOUT_SECONDS || 20)
  };
  const smoke = await smokeRunner(executablePath, releaseDir, smokeContext);
  if (smoke.exitCode !== 0) {
    throw new Error(`Candidate preview smoke failed with exit code ${smoke.exitCode}: ${(smoke.stderr || smoke.stdout).trim()}`);
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
  if (relayCanClose) {
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
    artifactSource,
    "-ArtifactKind",
    artifact.kind,
    "-Evidence",
    artifactEvidenceId({ kind: artifact.kind, wishlistId: artifact.wishlistId, sourceSha: artifactSource, smokeOutput: `${smoke.stdout}\n${smoke.stderr}` })
  ]);

  return {
    ...options.report,
    summary: `${options.report.summary}\n\nReciprocal artifact completed for human review: ${artifact.kind} ${artifactSource} (${artifact.wishlistId}); relay producer stayed at ${head}.`,
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
