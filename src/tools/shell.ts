import { execa } from "execa";
import { ToolContext, resolveInside } from "./fs.js";
import { ensurePermission } from "./permissions.js";
import { assertSafeBash } from "./protection.js";

export interface ShellResult {
  command: string;
  passed: boolean;
  output: string;
}

export const DEFAULT_BASH_TIMEOUT_MS = 120000;
export const MAX_BASH_TIMEOUT_MS = 300000;

export function effectiveBashTimeout(timeoutMs = DEFAULT_BASH_TIMEOUT_MS): number {
  return Math.min(timeoutMs, MAX_BASH_TIMEOUT_MS);
}

export function tailOutput(output: string, maxChars = 2000): string {
  if (output.length <= maxChars) return output;
  return output.slice(output.length - maxChars);
}

interface DescendantTracker {
  seen: Set<number>;
  stop: () => void;
}

async function windowsProcessTable(): Promise<Array<{ pid: number; parentPid: number }>> {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  const result = await execa("powershell.exe", ["-NoProfile", "-Command", script], { reject: false, windowsHide: true });
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
  const result = await execa("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { reject: false, windowsHide: true, all: true });
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
  try {
    if (ctx.abortSignal?.aborted) throw new Error("Command aborted.");
    const effectiveTimeout = effectiveBashTimeout(timeoutMs);
    const subprocess = execa(command, { cwd: ctx.cwd, shell: true, timeout: effectiveTimeout, reject: false, all: true, cleanup: true, windowsHide: true });
    rootPid = subprocess.pid;
    tracker = startDescendantTracker(rootPid);
    timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        void cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []).finally(() => subprocess.kill("SIGTERM"));
      } else {
        subprocess.kill("SIGTERM");
      }
    }, effectiveTimeout);
    const abortListener = () => {
      aborted = true;
      if (process.platform === "win32") {
        void cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []).finally(() => subprocess.kill("SIGTERM"));
      } else {
        subprocess.kill("SIGTERM");
      }
    };
    ctx.abortSignal?.addEventListener("abort", abortListener, { once: true });
    removeAbortListener = () => ctx.abortSignal?.removeEventListener("abort", abortListener);
    const result = await subprocess;
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
    tracker?.stop();
    const killed = await cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []);
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    const abortNote = aborted ? "Command aborted.\n" : "";
    const timeoutNote = timedOut ? `Command timed out after ${effectiveTimeout}ms.\n` : "";
    return {
      command,
      passed: !aborted && !timedOut && result.exitCode === 0,
      output: tailOutput(`${abortNote}${timeoutNote}${result.all ?? ""}${cleanupNote}`)
    };
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
    if (ctx.abortSignal?.aborted) aborted = true;
    tracker?.stop();
    const killed = await cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []);
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    const prefix = aborted ? "Command aborted." : timedOut ? `Command timed out after ${effectiveBashTimeout(timeoutMs)}ms.` : String(error);
    return { command, passed: false, output: tailOutput(`${prefix}${cleanupNote}`) };
  }
}
