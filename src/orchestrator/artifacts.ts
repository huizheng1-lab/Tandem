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

const runnableCommandStarters = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "py",
  "pytest",
  "go",
  "cargo",
  "make",
  "powershell",
  "pwsh",
  "cmd",
  "type",
  "findstr",
  "git",
  "tsc",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "dotnet",
  "mvn",
  "gradle"
]);

const windowsPosixAlternatives: Record<string, string> = {
  cat: "use `type <file>` or PowerShell `Get-Content <file>`",
  grep: "use `findstr` or PowerShell `Select-String`",
  ls: "use `dir` or PowerShell `Get-ChildItem`",
  touch: "use PowerShell `New-Item` or `Set-Content`",
  rm: "use `del`/`rmdir` or PowerShell `Remove-Item`",
  sed: "use `node -e` or PowerShell text processing",
  awk: "use `node -e` or PowerShell text processing",
  head: "use PowerShell `Select-Object -First`",
  tail: "use PowerShell `Select-Object -Last`",
  chmod: "avoid chmod on Windows; use a platform-appropriate command"
};

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

export const ReviewVerdictSchema = z
  .object({
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
  })
  .superRefine((value, ctx) => {
    if (value.verdict !== "approve") return;
    const lowScore = Object.entries(value.scores).find(([, score]) => score <= 2);
    if (!lowScore) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scores", lowScore[0]],
      message: "approve verdict requires scores above 2; low scores indicate revise or takeover"
    });
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewFeedback = ReviewVerdict["feedback"];

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function commandToken(segment: string): string {
  const match = segment.trim().match(/^["']?([^\s"'`]+)["']?/);
  return match?.[1]?.toLowerCase() ?? "";
}

function verificationSegments(command: string): string[] {
  return command.split(/\|\||&&|[|;]/g).map((part) => part.trim()).filter(Boolean);
}

function hasCommandShape(entry: string): boolean {
  const trimmed = entry.trim();
  const first = commandToken(trimmed);
  if (!first) return false;
  if (runnableCommandStarters.has(first)) return true;
  if (/^(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(trimmed)) return true;
  if (/^[\w.-]+\.(?:cmd|bat|ps1|mjs|cjs|js|ts|py|sh|exe)\b/i.test(trimmed)) return true;
  return false;
}

function validateVerificationEntry(entry: string, platform: NodeJS.Platform): string[] {
  const errors: string[] = [];
  const normalized = normalizeCommand(entry);
  if (!normalized) return ["verification entry is empty"];
  if (platform === "win32") {
    const posixTools = [...new Set(verificationSegments(normalized)
      .map(commandToken)
      .filter((token) => token in windowsPosixAlternatives))];
    for (const posix of posixTools) {
      errors.push(`verification command "${entry}" uses POSIX-only tool \`${posix}\` on Windows; ${windowsPosixAlternatives[posix]}.`);
    }
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasPathFlagOrShellChars = /[./\\:-]|--?|[|&><]/.test(normalized);
  if (!hasCommandShape(normalized) || (wordCount > 6 && !hasPathFlagOrShellChars)) {
    errors.push(`verification entry "${entry}" does not look like a runnable shell command; move manual checks to acceptanceCriteria and use commands such as \`npm test\`, \`node test.mjs\`, or \`type launch.bat\`.`);
  }
  return errors;
}

export function validateBuildPlan(value: unknown, platform: NodeJS.Platform = process.platform): BuildPlan {
  const plan = BuildPlanSchema.parse(value);
  if (plan.tasks.length === 0) throw new Error("no implementation tasks - answer directly instead");
  const errors = plan.verification.flatMap((entry) => validateVerificationEntry(entry, platform));
  if (errors.length > 0) throw new Error(`Invalid BuildPlan verification:\n${errors.join("\n")}`);
  return plan;
}

function matchResult(planEntry: string, results: CompletionReport["verificationResults"]) {
  const entry = normalizeCommand(planEntry);
  return results.find((result) => {
    const command = normalizeCommand(result.command);
    return command.length > 0 && command === entry;
  });
}

export function enforceVerification(plan: BuildPlan, report: CompletionReport): void {
  const missing = plan.verification.filter((entry) => !matchResult(entry, report.verificationResults));
  if (missing.length > 0) throw new Error(`Completion report omitted verification commands: ${missing.join(", ")}`);
  const failed = plan.verification.filter((entry) => matchResult(entry, report.verificationResults)?.passed !== true);
  if (failed.length > 0 && report.status === "complete") {
    throw new Error(`Completion report marked complete with failing verification: ${failed.join(", ")}`);
  }
}

export function validateCompletionReport(plan: BuildPlan, value: unknown): CompletionReport {
  const report = CompletionReportSchema.parse(value);
  enforceVerification(plan, report);
  return report;
}
