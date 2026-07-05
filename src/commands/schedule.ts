import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ScheduleSchema = z.object({ id: z.string(), cron: z.string(), prompt: z.string(), createdAt: z.string(), lastRunAt: z.string().optional() });
export type Schedule = z.infer<typeof ScheduleSchema>;
const SchedulesSchema = z.array(ScheduleSchema);

export function schedulesPath(cwd = process.cwd()): string {
  return path.join(cwd, ".tandem", "schedules.json");
}

export async function listSchedules(cwd = process.cwd()): Promise<Schedule[]> {
  const filePath = schedulesPath(cwd);
  if (!existsSync(filePath)) return [];
  return SchedulesSchema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

async function saveSchedules(schedules: Schedule[], cwd = process.cwd()): Promise<void> {
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
