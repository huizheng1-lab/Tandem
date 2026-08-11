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

export type GoalMessageIntent = "explicit-continuation" | "goal-match" | "low-signal";

const CONTINUATION_MESSAGE = /^(?:continue|resume|keep going|carry on|proceed)(?:\s+with\s+(?:this|the)\s+(?:work|task|build))?[.!]*$/i;
const MATCH_WORDS = /[a-z0-9]+/gi;
const MATCH_STOP_WORDS = new Set(["a", "an", "and", "do", "for", "from", "i", "in", "it", "me", "of", "on", "the", "to", "with", "you"]);

function meaningfulWords(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().match(MATCH_WORDS) ?? []).filter((word) => !MATCH_STOP_WORDS.has(word)));
}

/**
 * Classifies the user's message before the live pipeline starts. Explicit continuation
 * wording is safe to acknowledge briefly; otherwise a goal match is still intentional,
 * while low-signal messages require a visible resumption notice.
 */
export function classifyGoalMessageIntent(message: string, activeGoals: Goal[]): GoalMessageIntent {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (CONTINUATION_MESSAGE.test(normalized)) return "explicit-continuation";
  const messageWords = meaningfulWords(normalized);
  if (messageWords.size === 0) return "low-signal";
  const matchesGoal = activeGoals.some((goal) => {
    if (normalized.toLocaleLowerCase() === goal.text.replace(/\s+/g, " ").trim().toLocaleLowerCase()) return true;
    const goalWords = meaningfulWords(goal.text);
    if (goalWords.size === 0) return false;
    let matched = 0;
    for (const word of messageWords) if (goalWords.has(word)) matched += 1;
    return matched >= 2;
  });
  return matchesGoal ? "goal-match" : "low-signal";
}

/**
 * This notice deliberately uses Goal.text verbatim. It is emitted by the interactive
 * submit boundary, immediately before runPipeline, so users see the commitment and
 * scope before leader triage or worker rounds begin.
 */
export function formatGoalResumptionNotice(activeGoals: Goal[]): string {
  const count = activeGoals.length;
  const goals = activeGoals.map((goal) => `- Goal ${goal.id}: ${goal.text}`).join("\n");
  return `This message does not clearly request continuation. Before I start, the ${count === 1 ? "active project goal" : "active project goals"} I would resume ${count === 1 ? "is" : "are"}:\n${goals}\nThis may begin a multi-step build or background job with substantial expected duration. Redirect or cancel now if that is not what you want.`;
}
