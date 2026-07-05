import { addGoal, completeGoal, listGoals } from "../session/goals.js";

export async function handleGoal(args: string[], cwd = process.cwd()): Promise<string> {
  const sub = args[0];
  if (sub === "add") {
    const text = args.slice(1).join(" ").trim();
    if (!text) return "Usage: /goal add <text>";
    const goal = await addGoal(text, cwd);
    return `Added goal ${goal.id}: ${goal.text}`;
  }
  if (sub === "done") {
    const id = Number(args[1]);
    if (!Number.isInteger(id)) return "Usage: /goal done <n>";
    const goal = await completeGoal(id, cwd);
    return `Completed goal ${goal.id}: ${goal.text}`;
  }
  const goals = await listGoals(cwd);
  if (goals.length === 0) return "No goals yet. Add one with /goal add <text>.";
  return goals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n");
}
