import { execa } from "execa";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ToolContext, resolveInside } from "./fs.js";
import { ensurePermission, PermissionBridge } from "./permissions.js";
import { assertSafeBash } from "./protection.js";
import { sanitizePromptText } from "./sanitize.js";

export interface ShellResult {
  command: string;
  passed: boolean;
  output: string;
}

export interface BackgroundProcessInfo {
  id: string;
  command: string;
  pid?: number;
  status: "running" | "exited" | "stopped";
  startedAt: string;
  exitCode?: number | null;
}

export type BackgroundProcessAction = "list" | "read" | "stop";

export const DEFAULT_BASH_TIMEOUT_MS = 120000;
export const MAX_BASH_TIMEOUT_MS = 300000;
export const BASH_SETTLE_GRACE_MS = 5000;
const BASH_ABORT_SETTLE_GRACE_MS = 2000;
const INTERNAL_PROCESS_TIMEOUT_MS = 5000;

export function effectiveBashTimeout(timeoutMs = DEFAULT_BASH_TIMEOUT_MS): number {
  return Math.min(timeoutMs, MAX_BASH_TIMEOUT_MS);
}

export function tailOutput(output: string, maxChars = 2000): string {
  const safeOutput = sanitizePromptText(output);
  if (safeOutput.length <= maxChars) return safeOutput;
  return safeOutput.slice(safeOutput.length - maxChars);
}

interface DescendantTracker {
  seen: Set<number>;
  stop: () => void;
}

interface BackgroundProcess {
  info: BackgroundProcessInfo;
  subprocess: ReturnType<typeof execa>;
  tracker?: DescendantTracker;
  stdout: string;
  stderr: string;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();
let backgroundSequence = 0;
let backgroundSweepRegistered = false;
let backgroundBridge: {
  port: number;
  token: string;
  server: ReturnType<typeof createServer>;
  cwd?: string;
  permissionMode: ToolContext["permissionMode"];
  permissionBridge?: PermissionBridge;
} | undefined;

function appendBackgroundOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 1_000_000 ? next.slice(-1_000_000) : next;
}

function registerBackgroundSweep(): void {
  if (backgroundSweepRegistered) return;
  backgroundSweepRegistered = true;
  process.once("beforeExit", async () => {
    await cleanupBackgroundProcesses();
  });
  process.once("exit", () => {
    for (const entry of backgroundProcesses.values()) {
      killBackgroundProcessSync(entry);
    }
  });
}

type BoundedResult<T> = { status: "settled"; value: T } | { status: "rejected"; error: unknown } | { status: "deadline" };

function settleWithin<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = Promise.resolve(promise).then<BoundedResult<T>, BoundedResult<T>>(
    (value) => ({ status: "settled", value }),
    (error: unknown) => ({ status: "rejected", error })
  );
  const deadline = new Promise<BoundedResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "deadline" }), timeoutMs);
  });
  return Promise.race([observed, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function windowsProcessTable(): Promise<Array<{ pid: number; parentPid: number }>> {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  const result = await execa("powershell.exe", ["-NoProfile", "-Command", script], {
    reject: false,
    windowsHide: true,
    timeout: INTERNAL_PROCESS_TIMEOUT_MS
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const raw = JSON.parse(result.stdout) as Array<{ ProcessId: number; ParentProcessId: number }> | { ProcessId: number; ParentProcessId: number };
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((row) => ({ pid: row.ProcessId, parentPid: row.ParentProcessId }));
}

function descendantPids(rootPid: number, table: Array<{ pid: number; parentPid: number }>): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.parentPid) ?? [];
    list.push(row.pid);
    children.set(row.parentPid, list);
  }
  const found: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift() as number;
    found.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return found;
}

function startDescendantTracker(rootPid: number | undefined): DescendantTracker | undefined {
  if (process.platform !== "win32" || rootPid === undefined) return undefined;
  const seen = new Set<number>();
  let stopped = false;
  let polling = false;
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      for (const pid of descendantPids(rootPid, await windowsProcessTable())) seen.add(pid);
    } catch {
      // Best effort only; cleanup still attempts taskkill on the root pid.
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), 75);
  void poll();
  return {
    seen,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function killWindowsProcessTree(pid: number): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const result = await execa("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
    reject: false,
    windowsHide: true,
    timeout: INTERNAL_PROCESS_TIMEOUT_MS,
    stdout: "ignore",
    stderr: "ignore"
  });
  return result.exitCode === 0;
}

async function cleanupWindowsProcessTree(rootPid: number | undefined, seenDescendants: Iterable<number>): Promise<number[]> {
  if (process.platform !== "win32" || rootPid === undefined) return [];
  const killed = new Set<number>();
  if (await killWindowsProcessTree(rootPid)) killed.add(rootPid);
  for (const pid of seenDescendants) {
    if (pid !== rootPid && (await killWindowsProcessTree(pid))) killed.add(pid);
  }
  return [...killed].sort((left, right) => left - right);
}

function backgroundId(): string {
  backgroundSequence += 1;
  return `bg-${Date.now().toString(36)}-${backgroundSequence.toString(36)}`;
}

async function startBackgroundProcess(ctx: ToolContext, command: string): Promise<ShellResult> {
  const subprocess = execa(command, {
    cwd: ctx.cwd,
    shell: true,
    detached: process.platform !== "win32",
    reject: false,
    all: true,
    cleanup: true,
    windowsHide: true
  });
  const id = backgroundId();
  const entry: BackgroundProcess = {
    info: { id, command, pid: subprocess.pid, status: "running", startedAt: new Date().toISOString() },
    subprocess,
    tracker: startDescendantTracker(subprocess.pid),
    stdout: "",
    stderr: ""
  };
  subprocess.stdout?.on("data", (chunk: Buffer | string) => {
    entry.stdout = appendBackgroundOutput(entry.stdout, chunk);
  });
  subprocess.stderr?.on("data", (chunk: Buffer | string) => {
    entry.stderr = appendBackgroundOutput(entry.stderr, chunk);
  });
  backgroundProcesses.set(id, entry);
  registerBackgroundSweep();
  void Promise.resolve(subprocess).then((result) => {
    entry.info.status = "exited";
    entry.info.exitCode = result.exitCode;
    entry.tracker?.stop();
  }, () => {
    entry.info.status = "exited";
    entry.info.exitCode = null;
    entry.tracker?.stop();
  });
  return {
    command,
    passed: true,
    output: `Started background process ${id} (pid ${subprocess.pid ?? "unknown"}).`
  };
}

function killBackgroundProcessSync(entry: BackgroundProcess): void {
  entry.tracker?.stop();
  const pid = entry.info.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const pids = new Set([pid, ...(entry.tracker?.seen ?? [])]);
    for (const candidate of pids) {
      spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(candidate)], {
        windowsHide: true,
        stdio: "ignore",
        timeout: INTERNAL_PROCESS_TIMEOUT_MS
      });
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function stopBackgroundProcess(entry: BackgroundProcess): Promise<void> {
  entry.info.status = "stopped";
  entry.tracker?.stop();
  const pid = entry.info.pid;
  if (process.platform === "win32") {
    // Kill the live root with /T first so taskkill can traverse descendants that
    // were not observed by the polling tracker yet.
    await cleanupWindowsProcessTree(pid, entry.tracker?.seen ?? []);
    try {
      entry.subprocess.kill("SIGKILL");
    } catch {
      // The root may already have exited.
    }
  } else if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        entry.subprocess.kill("SIGKILL");
      } catch {
        // The root may already have exited.
      }
    }
  }
  await cleanupWindowsProcessTree(pid, entry.tracker?.seen ?? []);
}

export function listBackgroundProcesses(): BackgroundProcessInfo[] {
  return [...backgroundProcesses.values()].map(({ info }) => ({ ...info }));
}

export async function backgroundProcessTool(action: BackgroundProcessAction, id?: string): Promise<string> {
  if (action === "list") return JSON.stringify(listBackgroundProcesses());
  if (!id) throw new Error(`A background process id is required for ${action}.`);
  const entry = backgroundProcesses.get(id);
  if (!entry) throw new Error(`Unknown background process id: ${id}`);
  if (action === "read") {
    const output = sanitizePromptText(`${entry.stdout}${entry.stderr}`);
    entry.stdout = "";
    entry.stderr = "";
    return output;
  }
  await stopBackgroundProcess(entry);
  backgroundProcesses.delete(id);
  return `Stopped background process ${id}.`;
}

export async function startBackgroundProcessBridge(
  cwd?: string,
  permissionMode: ToolContext["permissionMode"] = "yolo",
  permissionBridge?: PermissionBridge
): Promise<{ port: number; token: string }> {
  if (backgroundBridge) {
    // CLI calls are sequential within a Tandem session. Refresh the request
    // context on each call so a bridge first opened by a yolo turn cannot
    // accidentally weaken a later ask-mode turn.
    backgroundBridge.cwd = cwd ?? backgroundBridge.cwd;
    backgroundBridge.permissionMode = permissionMode;
    backgroundBridge.permissionBridge = permissionBridge;
    return { port: backgroundBridge.port, token: backgroundBridge.token };
  }
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/background" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body) as { action: BackgroundProcessAction; id?: string; command?: string; cwd?: string };
        const result = input.action === "start"
          ? await bashTool({
            cwd: backgroundBridge?.cwd ?? input.cwd ?? process.cwd(),
            permissionMode: backgroundBridge?.permissionMode ?? "yolo",
            permissionBridge: backgroundBridge?.permissionBridge
          }, input.command ?? "", DEFAULT_BASH_TIMEOUT_MS, true)
          : await backgroundProcessTool(input.action, input.id);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine background bridge port.");
  backgroundBridge = { port: address.port, token, server, cwd, permissionMode, permissionBridge };
  registerBackgroundSweep();
  return { port: address.port, token };
}

export function backgroundBridgeEnvironment(env: NodeJS.ProcessEnv, bridge: { port: number; token: string }): NodeJS.ProcessEnv {
  return {
    ...env,
    TANDEM_BACKGROUND_PORT: String(bridge.port),
    TANDEM_BACKGROUND_TOKEN: bridge.token,
    TANDEM_BACKGROUND_COMMAND: "tandem /background"
  };
}

export const CLI_BACKGROUND_INSTRUCTIONS = `
Tandem-managed long-lived processes are available even in this CLI-backed turn. To start one, base64-encode the shell command and run:
  tandem /background start <base64-command>
It returns a process id. In later calls use \\"tandem /background list\\", \\"tandem /background read <id>\\", and \\"tandem /background stop <id>\\". Use this for local servers or jobs that must outlive one command call; do not use shell-only &, Start-Process, or detached-process workarounds. The process is automatically swept when the Tandem session/app exits.`;

export async function cleanupBackgroundProcesses(): Promise<void> {
  await Promise.all([...backgroundProcesses.keys()].map((id) => backgroundProcessTool("stop", id).catch(() => undefined)));
  if (backgroundBridge) {
    await new Promise<void>((resolve) => backgroundBridge?.server.close(() => resolve()));
    backgroundBridge = undefined;
  }
}

export async function bashTool(ctx: ToolContext, command: string, timeoutMs = DEFAULT_BASH_TIMEOUT_MS, runInBackground = false): Promise<ShellResult> {
  resolveInside(ctx.cwd, ".");
  assertSafeBash(ctx.cwd, command);
  await ensurePermission(ctx.permissionMode, { action: "bash", target: command }, ctx.permissionBridge);
  if (runInBackground) return startBackgroundProcess(ctx, command);
  let tracker: DescendantTracker | undefined;
  let rootPid: number | undefined;
  let aborted = false;
  let timedOut = false;
  let removeAbortListener: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationDeadlineAt: number | undefined;
  try {
    if (ctx.abortSignal?.aborted) throw new Error("Command aborted.");
    const effectiveTimeout = effectiveBashTimeout(timeoutMs);
    const subprocess = execa(command, { cwd: ctx.cwd, shell: true, timeout: effectiveTimeout, reject: false, all: true, cleanup: true, windowsHide: true });
    rootPid = subprocess.pid;
    tracker = startDescendantTracker(rootPid);
    let forceSettle: (() => void) | undefined;
    const forcedSettlement = new Promise<{ status: "forced" }>((resolve) => {
      forceSettle = () => resolve({ status: "forced" });
    });
    const beginTermination = (reason: "timeout" | "abort") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      try {
        subprocess.kill("SIGTERM");
      } catch {
        // The process may already be gone while an inherited output pipe remains open.
      }
      if (process.platform === "win32") {
        void cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []).catch(() => []);
      }
      const settleGraceMs = reason === "abort" ? BASH_ABORT_SETTLE_GRACE_MS : BASH_SETTLE_GRACE_MS;
      terminationDeadlineAt ??= Date.now() + settleGraceMs;
      forceSettleTimer ??= setTimeout(() => forceSettle?.(), settleGraceMs);
    };
    timeout = setTimeout(() => beginTermination("timeout"), effectiveTimeout);
    const abortListener = () => {
      beginTermination("abort");
    };
    ctx.abortSignal?.addEventListener("abort", abortListener, { once: true });
    removeAbortListener = () => ctx.abortSignal?.removeEventListener("abort", abortListener);
    const subprocessSettlement = Promise.resolve(subprocess).then(
      (result) => ({ status: "settled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const settlement = await Promise.race([subprocessSettlement, forcedSettlement]);
    if (timeout) clearTimeout(timeout);
    if (forceSettleTimer) clearTimeout(forceSettleTimer);
    removeAbortListener();
    tracker?.stop();
    if (settlement.status === "forced") {
      try {
        subprocess.kill("SIGKILL");
      } catch {
        // Best effort: the root process often exited before its inherited pipe closed.
      }
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
      subprocess.all?.destroy();
      if (process.platform === "win32") {
        void cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []).catch(() => []);
      }
      const prefix = aborted ? "Command aborted." : `Command timed out after ${effectiveTimeout}ms.`;
      return { command, passed: false, output: tailOutput(prefix) };
    }
    if (settlement.status === "rejected") throw settlement.error;
    const cleanupBudgetMs = terminationDeadlineAt === undefined
      ? BASH_SETTLE_GRACE_MS
      : Math.max(0, terminationDeadlineAt - Date.now());
    const cleanup = await settleWithin(cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []), cleanupBudgetMs);
    const killed = cleanup.status === "settled" ? cleanup.value : [];
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    const cleanupDeadlineNote = cleanup.status === "deadline" ? `\n[SYSTEM] Shell child cleanup exceeded ${BASH_SETTLE_GRACE_MS}ms; continuing.` : "";
    const abortNote = aborted ? "Command aborted.\n" : "";
    const timeoutNote = timedOut ? `Command timed out after ${effectiveTimeout}ms.\n` : "";
    return {
      command,
      passed: !aborted && !timedOut && settlement.result.exitCode === 0,
      output: tailOutput(`${abortNote}${timeoutNote}${settlement.result.all ?? ""}${cleanupNote}${cleanupDeadlineNote}`)
    };
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (forceSettleTimer) clearTimeout(forceSettleTimer);
    removeAbortListener?.();
    if (ctx.abortSignal?.aborted) aborted = true;
    tracker?.stop();
    const cleanupBudgetMs = terminationDeadlineAt === undefined
      ? BASH_SETTLE_GRACE_MS
      : Math.max(0, terminationDeadlineAt - Date.now());
    const cleanup = await settleWithin(cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []), cleanupBudgetMs);
    const killed = cleanup.status === "settled" ? cleanup.value : [];
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    const cleanupDeadlineNote = cleanup.status === "deadline" ? `\n[SYSTEM] Shell child cleanup exceeded ${BASH_SETTLE_GRACE_MS}ms; continuing.` : "";
    const prefix = aborted ? "Command aborted." : timedOut ? `Command timed out after ${effectiveBashTimeout(timeoutMs)}ms.` : String(error);
    return { command, passed: false, output: tailOutput(`${prefix}${cleanupNote}${cleanupDeadlineNote}`) };
  }
}
