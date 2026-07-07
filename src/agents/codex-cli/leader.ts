import { z } from "zod";
import type { TandemConfig } from "../../config/schema.js";
import type { PlanResult } from "../../orchestrator/machine.js";
import { BuildPlanSchema, CompletionReportSchema, ReviewVerdictSchema, validateBuildPlan, type BuildPlan, type CompletionReport, type ReviewFeedback } from "../../orchestrator/artifacts.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger } from "../../session/cost.js";
import type { AttachmentRef } from "../../session/attachments.js";
import { formatAttachmentBlock } from "../../session/attachments.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { assertSafeProjectDir } from "../../tools/protection.js";
import { hostPlatformPrompt } from "../platform.js";
import { leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt } from "../leader.js";
import { runCodexExec } from "./exec.js";

const PlanOrAnswerSchema = z
  .object({
    kind: z.enum(["question", "implementation"]),
    answer: z.string().optional(),
    plan: BuildPlanSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.kind === "question" && !value.answer) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "question results require answer" });
    if (value.kind === "implementation" && !value.plan) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plan"], message: "implementation results require plan" });
    if (value.kind === "question" && value.plan) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plan"], message: "question results must not include plan" });
    if (value.kind === "implementation" && value.answer) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "implementation results must not include answer" });
  });

export interface CodexLeaderOptions {
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entry: ModelEntry;
  ledger: CostLedger;
  abortSignal?: AbortSignal;
  onLeaderText?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
  projectInstructions?: () => string | Promise<string>;
  onTriage?: (kind: "question" | "implementation") => void | Promise<void>;
  confirmCodexWrite?: (role: "leader" | "worker", message: string) => Promise<boolean>;
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function projectInstructions(options: Pick<CodexLeaderOptions, "projectInstructions">): Promise<string> {
  return (await options.projectInstructions?.())?.trim() || "Project instructions:\nnone";
}

async function codexLeaderExec(options: CodexLeaderOptions, input: { schema: "plan-or-answer" | "review-verdict" | "takeover"; prompt: string; readOnly?: boolean }): Promise<unknown> {
  assertSafeProjectDir(options.cwd);
  if (!input.readOnly && options.config.permissionMode === "ask") {
    const approved = await options.confirmCodexWrite?.("leader", "Run this leader takeover via Codex CLI with write access? Codex cannot prompt per-command in headless exec mode.");
    if (approved === false) throw new Error("Codex CLI leader write round was not approved.");
  }
  return runCodexExec({
    cwd: options.cwd,
    prompt: input.prompt,
    schema: input.schema,
    readOnly: input.readOnly,
    permissionMode: options.config.permissionMode,
    env: options.env,
    codexCliPath: options.config.codexCliPath,
    modelName: options.entry.modelName,
    abortSignal: options.abortSignal,
    role: "leader",
    entry: options.entry,
    ledger: options.ledger,
    onText: options.onLeaderText,
    onToolEvent: options.onToolEvent
  });
}

export async function codexLeaderPlan(
  options: CodexLeaderOptions,
  input: { request: string; goals: string[]; history?: string; attachments?: AttachmentRef[] }
): Promise<PlanResult> {
  const attachmentBlock = input.attachments && input.attachments.length > 0 ? `\n\n${formatAttachmentBlock(input.attachments)}` : "";
  // Codex CLI has its own session model and does not receive the AI-SDK leaderThread array.
  // Always include the compact Tandem conversation digest here; the D31 thread-dedupe rule is
  // intentionally not applied for Codex-backed leaders.
  const prompt = `${leaderPlannerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}

FIRST, classify the request:
(a) QUESTION/INSPECTION - answering, explaining, reading/summarizing files, images, PDFs, or status queries. Do the inspection yourself with read-only tools and ANSWER DIRECTLY.
(b) IMPLEMENTATION - requires creating/modifying files or running state-changing commands. Produce a BuildPlan.
When the user explicitly asks for a direct answer, it is ALWAYS (a). Mixed requests are implementation.

Return JSON matching the provided schema. For question, set kind="question" and answer only. For implementation, set kind="implementation" and plan only.
The plan verification field must contain exact runnable shell commands only, one command per entry.

Conversation so far:
${input.history?.trim() || "none"}

Standing goals:
${input.goals.length > 0 ? input.goals.join("\n") : "none"}

Request:
${input.request}${attachmentBlock}`;
  const result = PlanOrAnswerSchema.parse(await codexLeaderExec(options, { schema: "plan-or-answer", prompt, readOnly: true }));
  await options.onTriage?.(result.kind);
  if (result.kind === "question") return { kind: "answer", answer: result.answer ?? "" };
  return { kind: "plan", plan: validateBuildPlan(result.plan) };
}

export async function codexLeaderReview(options: CodexLeaderOptions, input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string }) {
  const prompt = `${leaderReviewerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}
You may rerun only the plan verification commands if needed. Return only the ReviewVerdict JSON.

Review round ${input.round}.
BuildPlan:
${jsonBlock(input.plan)}

CompletionReport:
${jsonBlock(input.report)}

Diff:
${input.diff || "(empty diff)"}`;
  return ReviewVerdictSchema.parse(await codexLeaderExec(options, { schema: "review-verdict", prompt, readOnly: true }));
}

export async function codexLeaderTakeover(options: CodexLeaderOptions, input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewFeedback[] }) {
  const prompt = `${leaderTakeoverPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}
Run every verification command, then return takeover JSON with a CompletionReport and userSummary.

BuildPlan:
${jsonBlock(input.plan)}

Previous reports:
${jsonBlock(input.reports)}

Feedback history:
${jsonBlock(input.feedback)}`;
  const takeover = z.object({ report: CompletionReportSchema, userSummary: z.string() }).parse(await codexLeaderExec(options, { schema: "takeover", prompt }));
  return takeover;
}
