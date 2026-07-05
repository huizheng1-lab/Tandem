import { z } from "zod";

export const BuildPlanSchema = z.object({
  title: z.string(),
  objective: z.string(),
  constraints: z.array(z.string()),
  tasks: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      files: z.array(z.string()).optional()
    })
  ),
  acceptanceCriteria: z.array(z.string()),
  verification: z.array(z.string())
});
export type BuildPlan = z.infer<typeof BuildPlanSchema>;

export const CompletionReportSchema = z.object({
  status: z.enum(["complete", "blocked"]),
  summary: z.string(),
  taskResults: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["done", "partial", "skipped"]),
      notes: z.string().optional()
    })
  ),
  filesChanged: z.array(z.string()),
  verificationResults: z.array(
    z.object({
      command: z.string(),
      passed: z.boolean(),
      output: z.string()
    })
  ),
  deviationsFromPlan: z.array(z.string())
});
export type CompletionReport = z.infer<typeof CompletionReportSchema>;

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "takeover"]),
  scores: z.object({
    correctness: z.number().min(1).max(5),
    planAdherence: z.number().min(1).max(5),
    codeQuality: z.number().min(1).max(5)
  }),
  feedback: z.array(
    z.object({
      issue: z.string(),
      location: z.string().optional(),
      requiredChange: z.string()
    })
  ),
  userSummary: z.string()
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewFeedback = ReviewVerdict["feedback"];

export function enforceVerification(plan: BuildPlan, report: CompletionReport): void {
  const resultByCommand = new Map(report.verificationResults.map((result) => [result.command, result]));
  const missing = plan.verification.filter((command) => !resultByCommand.has(command));
  if (missing.length > 0) throw new Error(`Completion report omitted verification commands: ${missing.join(", ")}`);
  const failed = plan.verification.filter((command) => resultByCommand.get(command)?.passed !== true);
  if (failed.length > 0 && report.status === "complete") {
    throw new Error(`Completion report marked complete with failing verification: ${failed.join(", ")}`);
  }
}

export function validateCompletionReport(plan: BuildPlan, value: unknown): CompletionReport {
  const report = CompletionReportSchema.parse(value);
  enforceVerification(plan, report);
  return report;
}
