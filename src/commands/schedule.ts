import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import cron from "node-cron";
import { readJsonFile } from "../json.js";

export const ScheduleSchema = z.object({ id: z.string(), cron: z.string(), prompt: z.string(), createdAt: z.string(), lastRunAt: z.string().optional() });
export type Schedule = z.infer<typeof ScheduleSchema>;
const SchedulesSchema = z.array(ScheduleSchema);

export class ScheduleLoadError extends Error {
  readonly code = "SCHEDULE_LOAD_FAILED";

  constructor(readonly filePath: string, readonly cause: z.ZodError) {
    super(`Malformed schedules.json at ${filePath}: expected an array of schedule entries. ${cause.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    this.name = "ScheduleLoadError";
  }
}

export interface ScheduleLoadStatus {
  ok: boolean;
  path: string;
  count?: number;
  error?: string;
}

export function schedulesPath(cwd = process.cwd()): string {
  return path.join(cwd, ".tandem", "schedules.json");
}

export async function listSchedules(cwd = process.cwd()): Promise<Schedule[]> {
  const filePath = schedulesPath(cwd);
  if (!existsSync(filePath)) return [];
  const parsed = SchedulesSchema.safeParse(await readJsonFile(filePath));
  if (!parsed.success) throw new ScheduleLoadError(filePath, parsed.error);
  return parsed.data;
}

export async function saveSchedules(schedules: Schedule[], cwd = process.cwd()): Promise<void> {
  const filePath = schedulesPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(schedules, null, 2)}\n`, "utf8");
}

export async function addSchedule(cron: string, prompt: string, cwd = process.cwd()): Promise<Schedule> {
  const schedules = await listSchedules(cwd);
  const schedule = { id: randomUUID().slice(0, 8), cron, prompt, createdAt: new Date().toISOString() };
  schedules.push(schedule);
  await saveSchedules(schedules, cwd);
  return schedule;
}

export async function removeSchedule(id: string, cwd = process.cwd()): Promise<void> {
  const schedules = (await listSchedules(cwd)).filter((schedule) => schedule.id !== id);
  await saveSchedules(schedules, cwd);
}

export async function markScheduleRun(id: string, cwd = process.cwd(), at = new Date()): Promise<void> {
  const schedules = await listSchedules(cwd);
  const schedule = schedules.find((item) => item.id === id);
  if (!schedule) return;
  schedule.lastRunAt = at.toISOString();
  await saveSchedules(schedules, cwd);
}

function cronFields(expression: string): string[] | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5) return ["0", ...fields];
  if (fields.length === 6) return fields;
  return undefined;
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      return Number.isInteger(step) && step > 0 && value % step === 0;
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end;
    }
    return Number(part) === value;
  });
}

function matchesCron(fields: string[], date: Date): boolean {
  return (
    fieldMatches(fields[0] ?? "", date.getSeconds()) &&
    fieldMatches(fields[1] ?? "", date.getMinutes()) &&
    fieldMatches(fields[2] ?? "", date.getHours()) &&
    fieldMatches(fields[3] ?? "", date.getDate()) &&
    fieldMatches(fields[4] ?? "", date.getMonth() + 1) &&
    fieldMatches(fields[5] ?? "", date.getDay())
  );
}

export function previousScheduledTime(cronExpression: string, now = new Date(), lookbackMs = 7 * 24 * 60 * 60 * 1000): Date | undefined {
  if (!cron.validate(cronExpression)) return undefined;
  const fields = cronFields(cronExpression);
  if (!fields) return undefined;
  const stepMs = fields[0] === "0" ? 60_000 : 1000;
  const cursor = new Date(Math.floor(now.getTime() / stepMs) * stepMs);
  if (cursor.getTime() >= now.getTime()) cursor.setTime(cursor.getTime() - stepMs);
  const stopAt = now.getTime() - lookbackMs;
  while (cursor.getTime() >= stopAt) {
    if (matchesCron(fields, cursor)) return new Date(cursor);
    cursor.setTime(cursor.getTime() - stepMs);
  }
  return undefined;
}

export function missedSchedule(cronExpression: string, lastRunAt: string | undefined, now = new Date()): boolean {
  const previous = previousScheduledTime(cronExpression, now);
  if (!previous) return false;
  if (!lastRunAt) return previous.getTime() > 0;
  const lastRun = new Date(lastRunAt);
  if (Number.isNaN(lastRun.getTime())) return true;
  return previous.getTime() > lastRun.getTime();
}
