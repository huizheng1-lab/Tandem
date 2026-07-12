import { z } from "zod";
import type { TandemConfig } from "../../config/schema.js";
import type { PlanResult } from "../../orchestrator/machine.js";
import { BuildPlanSchema, CompletionReportSchema, ReviewVerdictSchema, validateBuildPlan, type BuildPlan, type CompletionReport, type ReviewFeedback } from "../../orchestrator/artifacts.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger } from "../../session/cost.js";
import type { AttachmentRef } from "../../session/attachments.js";
import { formatAttachmentBlock } from "../../session/attachments.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { hostPlatformPrompt } from "../platform.js";
import { leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt } from "../leader.js";
import { runClaudeExec } from "./exec.js";

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

export interface ClaudeLeaderOptions {
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

async function projectInstructions(options: Pick<ClaudeLeaderOptions, "projectInstructions">): Promise<string> {
  return (await options.projectInstructions?.())?.trim() || "Project instructions:\nnone";
}

function optionalSection(title: string, value: string | undefined): string {
  const text = value?.trim();
  return text ? `\n\n${title}:\n${text}` : "";
}

function retryFeedbackLine(previousAttemptError: string | undefined): string {
  const text = previousAttemptError?.trim();
  return text ? `\n\nYour previous submission was rejected: ${text}. Fix that specific problem and resubmit.` : "";
}

async function claudeLeaderExec(options: ClaudeLeaderOptions, input: { schema: "plan-or-answer" | "review-verdict" | "takeover"; prompt: string; systemPrompt: string; readOnly?: boolean }): Promise<unknown> {
  if (!input.readOnly && options.config.permissionMode === "ask") {
    const approved = await options.confirmCodexWrite?.("leader", "Run this leader takeover via Claude Code CLI with write access? Claude Code cannot prompt per-command in headless print mode.");
    if (approved === false) throw new Error("Claude Code CLI leader write round was not approved.");
  }
  return runClaudeExec({
    cwd: options.cwd,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    schema: input.schema,
    readOnly: input.readOnly,
    permissionMode: options.config.permissionMode,
    env: options.env,
    claudeCliPath: options.config.claudeCliPath,
    modelName: options.entry.modelName,
    abortSignal: options.abortSignal,
    role: "leader",
    entry: options.entry,
    ledger: options.ledger,
    onText: options.onLeaderText,
    onToolEvent: options.onToolEvent,
    maxBudgetUsd: options.config.claudeMaxBudgetUsdPerCall
  });
}

// D66-1: state the absolute project root explicitly in the system prompt so the leader
// has something concrete to prefix paths with. Prevents the bare-relative-path bug class
// (a real Claude-Code-CLI failure mode observed repeatedly in live sessions).
function absoluteCwdLine(cwd: string): string {
  return `\n\nAbsolute project root (cwd): ${cwd}\nEvery file read or write MUST be prefixed with this path exactly. Bare relative paths are not allowed - the CLI subprocess will resolve them against the wrong directory.`;
}

export async function buildClaudeLeaderPlanPrompts(
  options: Pick<ClaudeLeaderOptions, "env" | "projectInstructions" | "cwd">,
  input: { request: string; goals: string[]; history?: string; attachments?: AttachmentRef[]; previousAttemptError?: string }
): Promise<{ systemPrompt: string; prompt: string }> {
  const attachmentBlock = input.attachments && input.attachments.length > 0 ? `\n\n${formatAttachmentBlock(input.attachments)}` : "";
  const goals = input.goals.length > 0 ? input.goals.join("\n") : "";
  return {
    systemPrompt: `${leaderPlannerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}${absoluteCwdLine(options.cwd)}

FIRST, classify the request:
(a) QUESTION/INSPECTION - answering, explaining, reading/summarizing files, images, PDFs, or status queries. Do the inspection yourself with read-only tools and ANSWER DIRECTLY.
(b) IMPLEMENTATION - requires creating/modifying files or running state-changing commands. Produce a BuildPlan.
When the user explicitly asks for a direct answer, it is ALWAYS (a). Mixed requests are implementation.

Return JSON matching the provided schema. For question, set kind="question" and answer only. For implementation, set kind="implementation" and plan only.
The plan verification field must contain exact runnable shell commands only, one command per entry.`,
    prompt: `Request: ${input.request}${attachmentBlock}${optionalSection("Conversation so far", input.history)}${optionalSection("Standing goals", goals)}${retryFeedbackLine(input.previousAttemptError)}`
  };
}

export async function claudeLeaderPlan(
  options: ClaudeLeaderOptions,
  input: { request: string; goals: string[]; history?: string; attachments?: AttachmentRef[]; previousAttemptError?: string }
): Promise<PlanResult> {
  const prompts = await buildClaudeLeaderPlanPrompts(options, input);
  const result = PlanOrAnswerSchema.parse(await claudeLeaderExec(options, { schema: "plan-or-answer", prompt: prompts.prompt, systemPrompt: prompts.systemPrompt, readOnly: true }));
  await options.onTriage?.(result.kind);
  if (result.kind === "question") return { kind: "answer", answer: result.answer ?? "" };
  return { kind: "plan", plan: await validateBuildPlan(result.plan) };
}

export async function buildClaudeLeaderReviewPrompts(
  options: Pick<ClaudeLeaderOptions, "env" | "projectInstructions" | "cwd">,
  input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string; previousAttemptError?: string }
): Promise<{ systemPrompt: string; prompt: string }> {
  return {
    systemPrompt: `${leaderReviewerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}${absoluteCwdLine(options.cwd)}
You may rerun only the plan verification commands if needed. Return only the ReviewVerdict JSON.`,
    prompt: `Review round ${input.round}.
BuildPlan:
${jsonBlock(input.plan)}

CompletionReport:
${jsonBlock(input.report)}

Diff:
${input.diff || "(empty diff)"}${retryFeedbackLine(input.previousAttemptError)}`
  };
}

export async function buildClaudeLeaderTakeoverPrompts(
  options: Pick<ClaudeLeaderOptions, "env" | "projectInstructions" | "cwd">,
  input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewFeedback[]; previousAttemptError?: string }
): Promise<{ systemPrompt: string; prompt: string }> {
  return {
    systemPrompt: `${leaderTakeoverPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}${absoluteCwdLine(options.cwd)}
Run every verification command, then return takeover JSON with a CompletionReport and userSummary.`,
    prompt: `BuildPlan:
${jsonBlock(input.plan)}

Previous reports:
${jsonBlock(input.reports)}

Feedback history:
${jsonBlock(input.feedback)}${retryFeedbackLine(input.previousAttemptError)}`
  };
}

export async function claudeLeaderReview(options: ClaudeLeaderOptions, input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string; previousAttemptError?: string }) {
  const prompts = await buildClaudeLeaderReviewPrompts(options, input);
  return ReviewVerdictSchema.parse(await claudeLeaderExec(options, { schema: "review-verdict", prompt: prompts.prompt, systemPrompt: prompts.systemPrompt, readOnly: true }));
}

export async function claudeLeaderTakeover(options: ClaudeLeaderOptions, input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewFeedback[]; previousAttemptError?: string }) {
  const prompts = await buildClaudeLeaderTakeoverPrompts(options, input);
  const takeover = z.object({ report: CompletionReportSchema, userSummary: z.string() }).parse(await claudeLeaderExec(options, { schema: "takeover", prompt: prompts.prompt, systemPrompt: prompts.systemPrompt }));
  return takeover;
}
