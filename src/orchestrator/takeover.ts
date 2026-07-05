import { BuildPlan, CompletionReport } from "./artifacts.js";

export function takeoverPrompt(plan: BuildPlan, reports: CompletionReport[]): string {
  return [
    "You are the leader taking over implementation.",
    `Plan: ${plan.title}`,
    `Objective: ${plan.objective}`,
    `Previous reports: ${reports.map((report) => report.summary).join(" | ") || "none"}`,
    "Finish the job, run every verification command, and report what changed."
  ].join("\n");
}
