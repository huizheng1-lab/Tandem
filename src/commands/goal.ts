import { addGoal, clearGoals, completeGoal, listGoals } from "../session/goals.js";
import type { Goal } from "../session/goals.js";

export type GoalOutcome =
  | { kind: "handled"; message: string }
  | { kind: "run"; text: string };

/**
 * Resolves the /goal <args> invocation.
 * Returns either a terminal {kind:"handled"} outcome (caller should surface the message and stop)
 * or a {kind:"run"} outcome (caller should record the goal AND run the text through the same
 * pipeline a normal typed message uses).
 */
export async function handleGoal(args: string[], cwd = process.cwd()): Promise<GoalOutcome> {
  const sub = args[0];
  if (sub === "add") {
    const text = args.slice(1).join(" ").trim();
    if (!text) return { kind: "handled", message: "Usage: /goal add <text>" };
    const goal = await addGoal(text, cwd);
    return { kind: "handled", message: `Added goal ${goal.id}: ${goal.text}` };
  }
  if (sub === "done") {
    const id = Number(args[1]);
    if (!Number.isInteger(id)) return { kind: "handled", message: "Usage: /goal done <n>" };
    const goal = await completeGoal(id, cwd);
    return { kind: "handled", message: `Completed goal ${goal.id}: ${goal.text}` };
  }
  // Lone "list" token: list. Anything else starting with "list" is free-form text.
  if (args.length === 1 && sub === "list") {
    return { kind: "handled", message: await renderList(cwd) };
  }
  // Lone "clear" token: clear all. Anything else starting with "clear" is free-form text.
  if (args.length === 1 && sub === "clear") {
    const removed = await clearGoals(cwd);
    return { kind: "handled", message: `Cleared ${removed} goal(s).` };
  }
  // Otherwise: free-form text. Caller will record (the run outcome alone is enough; the caller is
  // expected to call addGoal themselves before running so the record semantics match /goal add).
  const text = args.join(" ").trim();
  if (!text) return { kind: "handled", message: await renderList(cwd) };
  return { kind: "run", text };
}

export { addGoal, completeGoal, listGoals, type Goal };

async function renderList(cwd: string): Promise<string> {
  const goals = await listGoals(cwd);
  if (goals.length === 0) return "No goals yet. Add one with /goal add <text>.";
  return goals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n");
}
