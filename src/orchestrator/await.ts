import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { keepBackgroundProcessAlive, listBackgroundProcesses } from "../tools/shell.js";

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

function processState(processId: string, pid?: number): "running" | "exited" | "stopped" | undefined {
  const registered = listBackgroundProcesses().find((entry) => entry.id === processId);
  if (registered) return registered.status;
  if (pid === undefined) return undefined;
  try { process.kill(pid, 0); return "running"; } catch { return "exited"; }
}

export async function registerBackgroundAwait(input: {
  cwd: string;
  processId: string;
  timeoutMs: number;
  id?: string;
  round?: number;
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
    round: input.round
  };
  await save(input.cwd, record);
  return record;
}

/** Re-prime a parked round. This is deliberately side-effect free until a terminal event is observed. */
export async function resumeBackgroundAwait(cwd: string, id: string): Promise<DurableAwaitRecord> {
  const record = await readDurableAwait(cwd, id);
  if (record.status !== "suspended") return record;
  const state = processState(record.processId, record.pid);
  const timedOut = Date.now() >= Date.parse(record.deadlineAt);
  const status: DurableAwaitStatus = timedOut ? "timed_out" : state === "exited" ? "completed" : state === "stopped" ? "failed" : "suspended";
  if (status === "suspended") return record;
  const resumed = { ...record, status, resumedAt: new Date().toISOString() };
  await save(cwd, resumed);
  return resumed;
}

export const DURABLE_AWAIT_DESCRIPTION = "Suspend this round until a named background process exits or the deadline expires. Waiting consumes no tool calls, tokens, wall-clock budget, or review rounds; resume restores the checkpoint, plan, tasks, and evidence.";
