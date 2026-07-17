import { execa } from "execa";
import { ToolContext, resolveInside } from "./fs.js";
import { ensurePermission } from "./permissions.js";
import { assertSafeBash } from "./protection.js";
import { sanitizePromptText } from "./sanitize.js";

export interface ShellResult {
  command: string;
  passed: boolean;
  output: string;
}

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

export async function bashTool(ctx: ToolContext, command: string, timeoutMs = DEFAULT_BASH_TIMEOUT_MS): Promise<ShellResult> {
  resolveInside(ctx.cwd, ".");
  assertSafeBash(ctx.cwd, command);
  await ensurePermission(ctx.permissionMode, { action: "bash", target: command }, ctx.permissionBridge);
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
