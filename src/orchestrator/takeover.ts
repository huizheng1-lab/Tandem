import { AUTHORITATIVE_ONLY_SKIPPED_MARKER, AUTHORITATIVE_ONLY_PREFIX, BuildPlan, CompletionReport } from "./artifacts.js";

export function takeoverPrompt(plan: BuildPlan, reports: CompletionReport[]): string {
  return [
    "You are the leader taking over implementation.",
    `Plan: ${plan.title}`,
    `Objective: ${plan.objective}`,
    `Previous reports: ${reports.map((report) => report.summary).join(" | ") || "none"}`,
    `Finish the job, run every verification command except entries beginning with \`${AUTHORITATIVE_ONLY_PREFIX}\`, and report what changed. For those entries, echo the original command with passed=false and output containing \`${AUTHORITATIVE_ONLY_SKIPPED_MARKER}\`.`
  ].join("\n");
}
