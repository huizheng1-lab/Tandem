import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readJsonFile } from "../json.js";

export const GoalSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(["active", "done"]),
  notes: z.array(z.string())
});
export type Goal = z.infer<typeof GoalSchema>;

const GoalsFileSchema = z.array(GoalSchema);

export function goalsPath(cwd = process.cwd()): string {
  return path.join(cwd, ".tandem", "goals.json");
}

export async function listGoals(cwd = process.cwd()): Promise<Goal[]> {
  const filePath = goalsPath(cwd);
  if (!existsSync(filePath)) return [];
  return GoalsFileSchema.parse(await readJsonFile(filePath));
}

async function saveGoals(goals: Goal[], cwd = process.cwd()): Promise<void> {
  const filePath = goalsPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(goals, null, 2)}\n`, "utf8");
}

export async function addGoal(text: string, cwd = process.cwd()): Promise<Goal> {
  const goals = await listGoals(cwd);
  const goal: Goal = {
    id: (goals.at(-1)?.id ?? 0) + 1,
    text,
    createdAt: new Date().toISOString(),
    status: "active",
    notes: []
  };
  goals.push(goal);
  await saveGoals(goals, cwd);
  return goal;
}

export async function completeGoal(id: number, cwd = process.cwd()): Promise<Goal> {
  const goals = await listGoals(cwd);
  const goal = goals.find((item) => item.id === id);
  if (!goal) throw new Error(`No goal ${id}. Run /goal list to see goals.`);
  goal.status = "done";
  await saveGoals(goals, cwd);
  return goal;
}

export async function clearGoals(cwd = process.cwd()): Promise<number> {
  const goals = await listGoals(cwd);
  const removed = goals.length;
  if (removed === 0) return 0;
  await saveGoals([], cwd);
  return removed;
}

export async function appendGoalNote(id: number, note: string, cwd = process.cwd()): Promise<void> {
  const goals = await listGoals(cwd);
  const goal = goals.find((item) => item.id === id);
  if (!goal) return;
  goal.notes.push(note);
  await saveGoals(goals, cwd);
}

export function formatStandingGoal(goal: Goal): string {
  const notes = goal.notes.slice(-2);
  if (notes.length === 0) return `Goal ${goal.id}: ${goal.text}`;
  return [`Goal ${goal.id}: ${goal.text}`, ...notes.map((note) => `  - ${note}`)].join("\n");
}

export function formatStandingGoals(goals: Goal[]): string[] {
  return goals.map(formatStandingGoal);
}
