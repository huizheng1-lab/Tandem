import { execa } from "execa";
import { ToolContext, resolveInside } from "./fs.js";
import { ensurePermission } from "./permissions.js";
import { assertSafeBash } from "./protection.js";

export interface ShellResult {
  command: string;
  passed: boolean;
  output: string;
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

export async function bashTool(ctx: ToolContext, command: string, timeoutMs = 120000): Promise<ShellResult> {
  resolveInside(ctx.cwd, ".");
  assertSafeBash(ctx.cwd, command);
  await ensurePermission(ctx.permissionMode, { action: "bash", target: command }, ctx.permissionBridge);
  let tracker: DescendantTracker | undefined;
  let rootPid: number | undefined;
  try {
    const subprocess = execa(command, { cwd: ctx.cwd, shell: true, timeout: timeoutMs, reject: false, all: true, cleanup: true, windowsHide: true });
    rootPid = subprocess.pid;
    tracker = startDescendantTracker(rootPid);
    const result = await subprocess;
    tracker?.stop();
    const killed = await cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []);
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    return {
      command,
      passed: result.exitCode === 0,
      output: tailOutput(`${result.all ?? ""}${cleanupNote}`)
    };
  } catch (error) {
    tracker?.stop();
    const killed = await cleanupWindowsProcessTree(rootPid, tracker?.seen ?? []);
    const cleanupNote = killed.length > 0 ? `\n[SYSTEM] Cleaned up ${killed.length} shell child process(es): ${killed.join(", ")}` : "";
    return { command, passed: false, output: tailOutput(`${String(error)}${cleanupNote}`) };
  }
}
