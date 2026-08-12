import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { keepBackgroundProcessAlive, listBackgroundProcesses, releaseBackgroundProcess } from "../tools/shell.js";

export type DurableAwaitStatus = "suspended" | "completed" | "failed" | "timed_out";

export interface DurableAwaitRecord {
  id: string;
  condition: "background_process";
  processId: string;
  pid?: number;
  deadlineAt: string;
  status: DurableAwaitStatus;
  createdAt: string;
  resumedAt?: string;
  round?: number;
  checkpoint?: { plan?: unknown; tasks?: unknown; evidence?: unknown };
}

export class DurableAwaitSuspendedError extends Error {
  readonly record: DurableAwaitRecord;
  constructor(record: DurableAwaitRecord) {
    super(`Round suspended on background process ${record.processId} until ${record.deadlineAt}.`);
    this.name = "DurableAwaitSuspendedError";
    this.record = record;
  }
}

/**
 * The AI SDK may serialize a tool execution failure before it reaches the
 * stream consumer. Keep the control-flow marker recognizable after that
 * conversion, without treating arbitrary tool failures as suspensions.
 */
export function isDurableAwaitSuspendedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) {
      if (typeof value === "string") return value.includes("Round suspended on background process ");
      return false;
    }
    seen.add(value);
    if (value instanceof DurableAwaitSuspendedError) return true;
    const candidate = value as { name?: unknown; message?: unknown; cause?: unknown; error?: unknown; errors?: unknown };
    if (candidate.name === "DurableAwaitSuspendedError") return true;
    if (typeof candidate.message === "string" && candidate.message.includes("Round suspended on background process ")) return true;
    if (visit(candidate.cause, depth + 1) || visit(candidate.error, depth + 1)) return true;
    return Array.isArray(candidate.errors) && candidate.errors.some((item) => visit(item, depth + 1));
  };
  return visit(error, 0);
}

function awaitDir(cwd: string): string {
  return path.join(cwd, ".tandem", "awaits");
}

function awaitPath(cwd: string, id: string): string {
  return path.join(awaitDir(cwd), `${id}.json`);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("Await id contains invalid characters.");
  return value;
}

async function save(cwd: string, record: DurableAwaitRecord): Promise<void> {
  await mkdir(awaitDir(cwd), { recursive: true });
  await writeFile(awaitPath(cwd, safeId(record.id)), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readDurableAwait(cwd: string, id: string): Promise<DurableAwaitRecord> {
  return JSON.parse(await readFile(awaitPath(cwd, safeId(id)), "utf8")) as DurableAwaitRecord;
}

export async function listDurableAwaits(cwd: string): Promise<DurableAwaitRecord[]> {
  let names: string[];
  try { names = await readdir(awaitDir(cwd)); } catch { return []; }
  return Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readDurableAwait(cwd, name.slice(0, -5))));
}

function processState(processId: string, pid?: number): "running" | "exited" | "failed" | "stopped" | undefined {
  const registered = listBackgroundProcesses().find((entry) => entry.id === processId);
  if (registered) {
    if (registered.status === "stopped") return "stopped";
    if (registered.status === "exited") return registered.exitCode === 0 ? "exited" : "failed";
    return "running";
  }
  if (pid === undefined) return undefined;
  try { process.kill(pid, 0); return "running"; } catch { return "exited"; }
}

export async function registerBackgroundAwait(input: {
  cwd: string;
  processId: string;
  timeoutMs: number;
  id?: string;
  round?: number;
  checkpoint?: DurableAwaitRecord["checkpoint"];
}): Promise<DurableAwaitRecord> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("Await timeout must be positive.");
  const id = safeId(input.id ?? `await-${Date.now().toString(36)}`);
  const process = listBackgroundProcesses().find((entry) => entry.id === input.processId);
  if (!process) throw new Error(`Unknown background process id: ${input.processId}`);
  keepBackgroundProcessAlive(input.processId);
  const record: DurableAwaitRecord = {
    id,
    condition: "background_process",
    processId: input.processId,
    pid: process.pid,
    deadlineAt: new Date(Date.now() + input.timeoutMs).toISOString(),
    status: "suspended",
    createdAt: new Date().toISOString(),
    round: input.round,
    checkpoint: input.checkpoint
  };
  await save(input.cwd, record);
  return record;
}

export async function suspendOnBackgroundAwait(input: Parameters<typeof registerBackgroundAwait>[0]): Promise<never> {
  throw new DurableAwaitSuspendedError(await registerBackgroundAwait(input));
}

/** Re-prime a parked round. This is deliberately side-effect free until a terminal event is observed. */
export async function resumeBackgroundAwait(cwd: string, id: string): Promise<DurableAwaitRecord> {
  const record = await readDurableAwait(cwd, id);
  if (record.status !== "suspended") return record;
  const state = processState(record.processId, record.pid);
  // A deadline is only a wakeup hint. A registered job that is still alive owns
  // the checkpoint, so an early/late observer wakeup must remain resumable and
  // must not release the process or turn the round terminal.
  const timedOut = Date.now() >= Date.parse(record.deadlineAt);
  const status: DurableAwaitStatus = state === "running"
    ? "suspended"
    : state === "exited"
      // A deadline is the durable contract's terminal boundary. If the
      // observer wakes after that boundary, report timeout even when the
      // process has already disappeared (including after an app restart).
      ? timedOut
        ? "timed_out"
        : "completed"
      : state === "failed" || state === "stopped"
        ? "failed"
        : timedOut
          ? "timed_out"
          : "suspended";
  if (status === "suspended") return record;
  releaseBackgroundProcess(record.processId);
  const resumed = { ...record, status, resumedAt: new Date().toISOString() };
  await save(cwd, resumed);
  return resumed;
}

/** Observe a persisted await without consuming an agent turn. */
export async function waitForDurableAwait(
  cwd: string,
  id: string,
  options: { pollMs?: number; signal?: AbortSignal } = {}
): Promise<DurableAwaitRecord> {
  const pollMs = Math.max(25, options.pollMs ?? 1000);
  while (true) {
    const record = await resumeBackgroundAwait(cwd, id);
    if (record.status !== "suspended") return record;
    if (options.signal?.aborted) throw new Error("Durable await observer aborted.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("Durable await observer aborted."));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      if (options.signal) setTimeout(cleanup, pollMs);
    });
  }
}

export const DURABLE_AWAIT_DESCRIPTION = "Suspend this round until a named background process exits or the deadline expires. Waiting consumes no tool calls, tokens, wall-clock budget, or review rounds; resume restores the checkpoint, plan, tasks, and evidence.";
