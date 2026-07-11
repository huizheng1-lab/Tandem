import { generateObject, generateText, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TandemConfig } from "../config/schema.js";
import { makeModel } from "../providers/client.js";
import { ModelEntry } from "../providers/registry.js";
import { PermissionBridge } from "../tools/permissions.js";
import { makeToolSet } from "../tools/index.js";
import type { ToolActivityEvent, ToolContext } from "../tools/fs.js";
import { CostLedger, CostRole } from "../session/cost.js";
import { AgentFns, PlanResult } from "../orchestrator/machine.js";
import { BuildPlan, BuildPlanSchema, CompletionReport, CompletionReportSchema, ReviewFeedback, ReviewVerdictSchema, validateBuildPlan } from "../orchestrator/artifacts.js";
import { Goal } from "../session/goals.js";
import { buildUserContentWithAttachments } from "../session/attachments.js";
import type { ContentPart } from "../session/attachments.js";
import { estimatePromptSize, runAgentArtifact, runAgentText } from "./runner.js";
import type { RunnerMessage } from "./runner.js";
import { leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt } from "./leader.js";
import { workerPrompt } from "./worker.js";
import { hostPlatformPrompt } from "./platform.js";
import { stripEmbeddedHistoryDigest } from "../session/leader-thread.js";
import { runCodexWorkerBuild } from "./codex-cli/worker.js";
import { codexLeaderPlan, codexLeaderReview, codexLeaderTakeover } from "./codex-cli/leader.js";
import { runClaudeWorkerBuild } from "./claude-code-cli/worker.js";
import { claudeLeaderPlan, claudeLeaderReview, claudeLeaderTakeover } from "./claude-code-cli/leader.js";

export interface LiveAgentOptions {
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: CostLedger;
  permissionBridge?: PermissionBridge;
  recordTouchedPath?: (filePath: string) => void;
  abortSignal?: AbortSignal;
  onLeaderText?: (text: string) => void;
  onWorkerText?: (text: string) => void;
  onLeaderThinking?: (text: string) => void;
  onWorkerThinking?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
  projectInstructions?: () => string | Promise<string>;
  rememberNote?: (text: string, by: "leader" | "worker") => Promise<string>;
  leaderThread?: RunnerMessage[];
  onLeaderCompaction?: (event: { summary: string; compactedTurns: number }) => void | Promise<void>;
  onTriage?: (kind: TriageKind) => void | Promise<void>;
  confirmCodexWrite?: (role: "leader" | "worker", message: string) => Promise<boolean>;
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mergeTools(...sets: ToolSet[]): ToolSet {
  return Object.assign({}, ...sets);
}

export const WORKER_CONTEXT_CHAR_BUDGET = 16000;
export const TAKEOVER_MIN_STEPS = 90;
const FEEDBACK_FIELD_CHAR_LIMIT = 700;
const REPORT_FIELD_CHAR_LIMIT = 700;

function truncateText(value: string | undefined, max = REPORT_FIELD_CHAR_LIMIT): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function compactFeedback(feedback: ReviewFeedback): ReviewFeedback {
  return feedback.map((item) => ({
    issue: truncateText(item.issue, FEEDBACK_FIELD_CHAR_LIMIT) ?? "",
    location: truncateText(item.location, 240),
    requiredChange: truncateText(item.requiredChange, FEEDBACK_FIELD_CHAR_LIMIT) ?? ""
  }));
}

export function summarizePreviousReport(report: CompletionReport | undefined) {
  if (!report) return null;
  return {
    status: report.status,
    summary: truncateText(report.summary),
    taskResults: report.taskResults.map((task) => ({ id: task.id, status: task.status, notes: truncateText(task.notes, 300) })),
    failedVerifications: report.verificationResults
      .filter((result) => !result.passed)
      .map((result) => ({ command: result.command, passed: result.passed, output: truncateText(result.output) })),
    deviationsFromPlan: report.deviationsFromPlan.map((deviation) => truncateText(deviation, 400) ?? "")
  };
}

// D54: extended with streamId/tasks/verification so the worker knows which slice of the plan to
// focus on and which subset of verification commands to run. Old shape (without these) still
// works - defaults to the implicit default stream, full plan tasks, and full plan.verification.
export function buildWorkerContext(
  input: {
    round: number;
    plan: BuildPlan;
    feedback: ReviewFeedback;
    previousReport?: CompletionReport;
    streamId?: string;
    tasks?: BuildPlan["tasks"];
    verification?: string[];
  },
  budget = WORKER_CONTEXT_CHAR_BUDGET
): string {
  const compact = {
    feedback: compactFeedback(input.feedback),
    previousReport: summarizePreviousReport(input.previousReport),
    stream: input.streamId
      ? {
          id: input.streamId,
          tasks: input.tasks ?? input.plan.tasks,
          verification: input.verification ?? input.plan.verification
        }
      : null
  };
  const streamBlock = compact.stream
    ? `\n\nThis worker invocation is responsible for stream "${compact.stream.id}". The full plan is shown for context; focus on the tasks in this stream and run only this stream's verification commands (verbatim).\n\nStream "${compact.stream.id}" tasks:\n${jsonBlock(compact.stream.tasks)}\n\nStream "${compact.stream.id}" verification:\n${jsonBlock(compact.stream.verification)}`
    : "";
  let content = `BuildPlan:\n${jsonBlock(input.plan)}\n\nRound ${input.round}\n\nReview feedback:\n${jsonBlock(compact.feedback)}\n\nPrevious report summary:\n${jsonBlock(compact.previousReport)}${streamBlock}`;
  if (content.length > budget) {
    const suffix = "\n[context truncated; full prior artifacts remain in the session log]";
    content = `${content.slice(0, Math.max(0, budget - suffix.length))}${suffix}`;
  }
  return content;
}

function artifactThreadMessage(name: string, value: unknown, fallbackText: string): string {
  const text = fallbackText.trim();
  const artifact = value === undefined ? "" : `Submitted ${name}:\n${jsonBlock(value)}`;
  return [text, artifact].filter(Boolean).join("\n\n") || `Submitted ${name}.`;
}

function contentAsText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "[attached image content]";
      return `[attached file content: ${part.filename ?? part.mediaType}]`;
    })
    .join("\n");
}

function threadAsText(messages: RunnerMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${contentAsText(message.content)}`).join("\n\n");
}

export function workerMediaWarning(attachments: { path: string; mediaType?: string }[], workerEntry: ModelEntry): string {
  const unsupported = attachments
    .filter((attachment) => {
      if (attachment.mediaType?.startsWith("image/")) return !workerEntry.media?.images;
      if (attachment.mediaType === "application/pdf") return !workerEntry.media?.pdf;
      return false;
    })
    .map((attachment) => attachment.path);
  if (unsupported.length === 0) return "";
  return `\nMedia routing: the worker model (${workerEntry.id}) cannot view these attached media files: ${unsupported.join(", ")}. Inspect them yourself during planning. If implementation is needed, the BuildPlan may only contain tasks executable without the worker seeing the media, and the plan must include your visual/PDF findings clearly enough for the worker to act without guessing.`;
}

// Provider-specific options that mark a system message as cacheable so repeated leader calls
// (plan/question/review/takeover) within the same session reuse the static prefix tokens instead of
// re-billing them. Anthropic needs an explicit cache breakpoint; other providers either cache
// implicitly (Gemini) or are out of scope for this round (OpenAI-compatible worker).
export function leaderSystemProviderOptions(entry: ModelEntry): ProviderOptions | undefined {
  if (entry.provider !== "anthropic") return undefined;
  return {
    anthropic: {
      cacheControl: { type: "ephemeral" }
    }
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function openAiPromptCacheProviderOptions(entry: ModelEntry, cwd: string, role: "leader" | "worker"): ProviderOptions | undefined {
  if (entry.provider !== "openai") return undefined;
  return {
    openai: {
      promptCacheKey: `tandem:${role}:v1:${shortHash([entry.id, entry.modelName, cwd].join("\n"))}`
    }
  };
}

export function buildLeaderRequestMessage(input: { request: string; goals: string[]; history?: string; includeHistoryDigest: boolean; validationFeedback?: string }): string {
  const history = input.includeHistoryDigest && input.history?.trim() ? `Compact session-log history:\n${input.history.trim()}\n\n` : "";
  return `${history}Request:\n${input.request}\n\nStanding goals (context only - do not redirect unrelated requests toward these):\n${input.goals.length > 0 ? input.goals.join("\n") : "none"}${input.validationFeedback ?? ""}`;
}

const TriageSchema = z.object({ kind: z.enum(["question", "implementation"]) });
export type TriageKind = z.infer<typeof TriageSchema>["kind"];

export type TriageObjectGenerator = (options: {
  model: LanguageModel;
  schema: typeof TriageSchema;
  abortSignal?: AbortSignal;
  prompt: string;
}) => Promise<{ object: z.infer<typeof TriageSchema>; usage?: unknown }>;

type StructuredGenerationError = Error & {
  text?: unknown;
  usage?: unknown;
  cause?: unknown;
  response?: unknown;
};

function oneLineContext(text: string | undefined, max = 320): string {
  const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) return "none";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

export function buildTriagePrompt(input: { request: string; history?: string; leaderThread?: RunnerMessage[] }): string {
  const threadContext = input.leaderThread && input.leaderThread.length > 0 ? threadAsText(input.leaderThread.slice(-4)) : "";
  return `Classify this Tandem request.
Return {"kind":"question"} or {"kind":"implementation"}.

Rules:
- implementation ONLY if fulfilling the request requires creating/modifying files or running state-changing commands.
- Answering, explaining, reading/summarizing files, images, or PDFs is question.
- Mixed requests are implementation.
- Explicit user "answer directly" is always question.

One-line context: ${oneLineContext(input.history || threadContext)}

Request:
${input.request}`;
}

export async function classifyPlanRequest(options: {
  request: string;
  history?: string;
  leaderThread?: RunnerMessage[];
  resolution: { model: LanguageModel; entry: ModelEntry };
  ledger: CostLedger;
  abortSignal?: AbortSignal;
  generator?: TriageObjectGenerator;
}): Promise<TriageKind> {
  const generator =
    options.generator ??
    ((input) =>
      generateObject({
        model: input.model,
        schema: input.schema,
        abortSignal: input.abortSignal,
        prompt: input.prompt
      }));
  try {
    const { object, usage } = await generator({
      model: options.resolution.model,
      schema: TriageSchema,
      abortSignal: options.abortSignal,
      prompt: buildTriagePrompt({ request: options.request, history: options.history, leaderThread: options.leaderThread })
    });
    recordFallbackUsage("leader", options.ledger, options.resolution.entry, usage);
    return object.kind;
  } catch (error) {
    const generationError = error as StructuredGenerationError;
    recordFallbackUsage("leader", options.ledger, options.resolution.entry, generationError.usage);
    const text = textFromStructuredGenerationError(error);
    const parsed = parseTriageFromText(text);
    if (parsed) return parsed;
    if (text.trim()) {
      try {
        const extracted = await extractFromProse({
          resolution: options.resolution,
          ledger: options.ledger,
          role: "leader",
          schema: TriageSchema,
          artifactName: "Triage",
          text,
          abortSignal: options.abortSignal,
          originalError: generationError
        });
        return extracted.kind;
      } catch {
        return "implementation";
      }
    }
    return "implementation";
  }
}

export function leaderToolsForTriage(input: { kind: TriageKind; toolContext: ToolContext; media?: ModelEntry["media"]; submitTools?: ToolSet }): ToolSet {
  const context = { ...input.toolContext, media: input.media, rememberNote: input.kind === "question" ? undefined : input.toolContext.rememberNote };
  const readonlyTools = makeToolSet(context, "leader-readonly");
  return input.kind === "question" ? readonlyTools : mergeTools(readonlyTools, input.submitTools ?? {});
}

export type ProseObjectGenerator<T> = (options: {
  model: LanguageModel;
  schema: z.ZodType<T>;
  abortSignal?: AbortSignal;
  prompt: string;
}) => Promise<{ object: T; usage?: unknown }>;

export type ProseTextGenerator = (options: {
  model: LanguageModel;
  abortSignal?: AbortSignal;
  prompt: string;
}) => Promise<{ text: string; usage?: unknown }>;

export interface ExtractFromProseOptions<T> {
  resolution: { model: LanguageModel; entry: ModelEntry };
  ledger: CostLedger;
  role: CostRole;
  schema: z.ZodType<T>;
  artifactName: string;
  text: string;
  abortSignal?: AbortSignal;
  originalError: Error;
  generator?: ProseObjectGenerator<T>;
  textGenerator?: ProseTextGenerator;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fallbackError(originalError: Error, cause: unknown): Error {
  return new Error(`${originalError.message} Fallback extraction also failed: ${String(cause)}`, { cause });
}

function recordFallbackUsage(role: CostRole, ledger: CostLedger, entry: ModelEntry, usage: unknown): void {
  const raw = usage as { inputTokens?: unknown; outputTokens?: unknown; promptTokens?: unknown; completionTokens?: unknown } | undefined;
  ledger.add(role, entry, usageNumber(raw?.inputTokens ?? raw?.promptTokens), usageNumber(raw?.outputTokens ?? raw?.completionTokens));
}

function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text.trim();
}

function textFromStructuredGenerationError(error: unknown): string {
  const candidates: unknown[] = [];
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  candidates.push(record?.text);

  const cause = record?.cause && typeof record.cause === "object" ? (record.cause as Record<string, unknown>) : undefined;
  candidates.push(cause?.text);

  const response = record?.response && typeof record.response === "object" ? (record.response as Record<string, unknown>) : undefined;
  const body = response?.body && typeof response.body === "object" ? (response.body as Record<string, unknown>) : undefined;
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  for (const choice of choices) {
    const choiceRecord = choice && typeof choice === "object" ? (choice as Record<string, unknown>) : undefined;
    const message = choiceRecord?.message && typeof choiceRecord.message === "object" ? (choiceRecord.message as Record<string, unknown>) : undefined;
    candidates.push(message?.content);
  }

  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim() ?? "";
}

function parseTriageFromText(text: string): TriageKind | undefined {
  try {
    return TriageSchema.parse(JSON.parse(extractJsonText(text))).kind;
  } catch {
    return undefined;
  }
}

// Some models (observed: Gemini 2.5 Pro) reliably do the work but fail to call their submit_*
// tool even when tool choice is forced. Recover by extracting the artifact from the prose the
// model already wrote, via schema-constrained generation with no tools involved.
export async function extractFromProse<T>(options: ExtractFromProseOptions<T>): Promise<T> {
  if (!options.text.trim()) throw options.originalError;
  const objectGenerator: ProseObjectGenerator<T> =
    options.generator ??
    ((input) =>
      generateObject({
        model: input.model,
        schema: input.schema,
        abortSignal: input.abortSignal,
        prompt: input.prompt
      }));
  const textGenerator: ProseTextGenerator =
    options.textGenerator ??
    ((input) =>
      generateText({
        model: input.model,
        abortSignal: input.abortSignal,
        prompt: input.prompt
      }));
  const scoreGuidance =
    options.artifactName === "ReviewVerdict"
      ? "\nFor ReviewVerdict, scores must be consistent with the verdict: approve means the work met the bar and should not use 1 or 2 scores; 1 means severe failure."
      : "";
  const basePrompt = `The following text is a completed ${options.artifactName} written as prose. Convert it faithfully into the structured object. Do not invent facts that are not in the text.${scoreGuidance}\n\n${options.text}`;
  try {
    const { object, usage } = await objectGenerator({
      model: options.resolution.model,
      schema: options.schema,
      abortSignal: options.abortSignal,
      prompt: basePrompt
    });
    recordFallbackUsage(options.role, options.ledger, options.resolution.entry, usage);
    return object;
  } catch (objectCause) {
    try {
      const { text, usage } = await textGenerator({
        model: options.resolution.model,
        abortSignal: options.abortSignal,
        prompt: `${basePrompt}\n\nReturn only valid JSON for ${options.artifactName}. No markdown, no prose, no code fences.`
      });
      recordFallbackUsage(options.role, options.ledger, options.resolution.entry, usage);
      return options.schema.parse(JSON.parse(extractJsonText(text)));
    } catch (textCause) {
      throw fallbackError(options.originalError, `generateObject failed: ${String(objectCause)}; JSON-text fallback failed: ${String(textCause)}`);
    }
  }
}

export async function createLiveAgents(options: LiveAgentOptions): Promise<AgentFns> {
  const leader = await makeModel(options.config.leader, options.config, options.env);
  const worker = await makeModel(options.config.worker, options.config, options.env);
  const hostPrompt = hostPlatformPrompt(process.platform, options.env);
  const toolContext = {
    cwd: options.cwd,
    permissionMode: options.config.permissionMode,
    permissionBridge: options.permissionBridge,
    recordTouchedPath: options.recordTouchedPath,
    rememberNote: options.rememberNote,
    abortSignal: options.abortSignal,
    onToolEvent: options.onToolEvent
  };
  const projectInstructions = async () => (await options.projectInstructions?.())?.trim() || "Project instructions:\nnone";
  const memoryInstruction = "Honor Project instructions. Use remember only for durable project facts such as conventions, constraints, decisions, or unresolved issues. Never use remember for Q&A trivia or one-off answers; direct answers rarely warrant notes.";
  const leaderThread: RunnerMessage[] = [...(options.leaderThread ?? [])].map((message) =>
    message.role === "user" && typeof message.content === "string" ? { ...message, content: stripEmbeddedHistoryDigest(message.content) } : message
  );
  const compactLeaderThread = async (system: string): Promise<void> => {
    const budgetChars = Math.max(1, options.config.leaderContextBudgetTokens) * 4;
    if (estimatePromptSize(system, leaderThread).chars <= budgetChars || leaderThread.length <= 12) return;
    const recent = leaderThread.slice(-12);
    const older = leaderThread.slice(0, -12);
    const { text } = await runAgentText({
      model: leader.model,
      modelEntry: leader.entry,
      costRole: "leader",
      ledger: options.ledger,
      system: `${leaderPlannerPrompt}\nSummarize the prior Tandem leader conversation for continuing future turns. Preserve user requests, files or artifacts named, decisions, unresolved issues, and accepted plans/reviews. Be concise.`,
      providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
      messages: [{ role: "user", content: threadAsText(older) }],
      maxSteps: Math.min(8, options.config.maxStepsPerAgentTurn),
      abortSignal: options.abortSignal
    });
    leaderThread.splice(0, leaderThread.length, { role: "assistant", content: `Conversation summary so far:\n${text.trim() || "(summary unavailable)"}` }, ...recent);
    await options.onLeaderCompaction?.({ summary: text.trim(), compactedTurns: older.length });
  };

  return {
    plan: async ({ request, goals, history, attachments = [] }): Promise<PlanResult> => {
      if (leader.entry.provider === "codex-cli") {
        return codexLeaderPlan(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            onTriage: options.onTriage,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { request, goals, history, attachments }
        );
      }
      if (leader.entry.provider === "claude-code-cli") {
        return claudeLeaderPlan(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            onTriage: options.onTriage,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { request, goals, history, attachments }
        );
      }
      const triageKind =
        options.config.triage === "always-plan"
          ? "implementation"
          : await classifyPlanRequest({
              request,
              history,
              leaderThread,
              resolution: leader,
              ledger: options.ledger,
              abortSignal: options.abortSignal
            });
      await options.onTriage?.(triageKind);
      const triage = `FIRST, classify the request:
(a) QUESTION/INSPECTION - answering, explaining, reading/summarizing files, images, PDFs, or status queries. Do the inspection yourself with read-only tools and ANSWER DIRECTLY. Do NOT call submit_build_plan. Do NOT write notes.
(b) IMPLEMENTATION - requires creating/modifying files or running state-changing commands. Submit a BuildPlan.
When the user explicitly asks for a direct answer, it is ALWAYS (a). A BuildPlan exists only when implementation work is required.`;
      const includeHistoryDigest = leaderThread.length === 0;
      const baseUserText = buildLeaderRequestMessage({ request, goals, history, includeHistoryDigest });
      if (triageKind === "question") {
        const system = `${leaderPlannerPrompt}
${hostPrompt}
${await projectInstructions()}
${memoryInstruction}
Honor Project instructions. Use read-only tools when useful. Answer directly and concisely.
You cannot create or modify files, run shell commands, submit a BuildPlan, or write memory notes in this branch.
Treat the new request in the context of this continuing session conversation; pronouns, references like "that file", and follow-ups may refer to earlier turns.
Users may reference standing goals by number (for example, "goal 1"); resolve those references against the Standing goals list before asking for clarification.
Standing goals are context only; do not redirect unrelated requests toward them.`;
        await compactLeaderThread(system);
        leaderThread.push({
          role: "user",
          content: await buildUserContentWithAttachments(options.cwd, baseUserText, attachments, leader.entry)
        });
        const result = await runAgentText({
          model: leader.model,
          modelEntry: leader.entry,
          costRole: "leader",
          ledger: options.ledger,
          system,
          providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
          systemProviderOptions: leaderSystemProviderOptions(leader.entry),
          messages: leaderThread,
          tools: leaderToolsForTriage({ kind: "question", toolContext, media: leader.entry.media }),
          maxSteps: options.config.maxStepsPerAgentTurn,
          abortSignal: options.abortSignal,
          onText: options.onLeaderText,
          onThinking: options.onLeaderThinking
        });
        const answer = result.text.trim();
        leaderThread.push({ role: "assistant", content: answer });
        return { kind: "answer", answer };
      }
      let validationFeedback = "";
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let submittedPlan: BuildPlan | undefined;
        const submitTools = {
          submit_build_plan: tool({
            description: "Submit the build plan and end planning.",
            inputSchema: BuildPlanSchema,
            execute: (input) => {
              submittedPlan = input;
              return { ok: true };
            }
          })
        };
        const system = `${leaderPlannerPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\n${triage}${workerMediaWarning(attachments, worker.entry)}\nTreat the new request in the context of this continuing session conversation; pronouns, references like "that file", and follow-ups may refer to earlier turns.\nUsers may reference standing goals by number (for example, "goal 1"); resolve those references against the Standing goals list before asking for clarification.\nStanding goals are context only; do not redirect unrelated requests toward them.\nThe "verification" field must contain exact runnable shell commands only (e.g. "node test.mjs"), one command per entry - never prose or manual instructions. Put manual checks in acceptanceCriteria instead. Verification commands MUST be runnable verbatim on the host platform.`;
        await compactLeaderThread(system);
        const userText = validationFeedback ? buildLeaderRequestMessage({ request, goals, history, includeHistoryDigest, validationFeedback }) : baseUserText;
        leaderThread.push({
          role: "user",
          content: await buildUserContentWithAttachments(options.cwd, userText, attachments, leader.entry)
        });
        const result = await runAgentArtifact({
          model: leader.model,
          modelEntry: leader.entry,
          costRole: "leader",
          ledger: options.ledger,
          system,
          providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
          systemProviderOptions: leaderSystemProviderOptions(leader.entry),
          messages: leaderThread,
          tools: leaderToolsForTriage({ kind: "implementation", toolContext, media: leader.entry.media, submitTools }),
          maxSteps: options.config.maxStepsPerAgentTurn,
          stopToolName: "submit_build_plan",
          abortSignal: options.abortSignal,
          onText: options.onLeaderText,
          onThinking: options.onLeaderThinking,
          artifactName: "BuildPlan",
          getArtifact: () => submittedPlan
        });
        if (!result.artifact) {
          const answer = result.text.trim();
          leaderThread.push({ role: "assistant", content: answer });
          return { kind: "answer", answer };
        }
        try {
          const plan = await validateBuildPlan(result.artifact);
          leaderThread.push({ role: "assistant", content: artifactThreadMessage("BuildPlan", plan, result.text) });
          return { kind: "plan", plan };
        } catch (error) {
          lastError = error;
          validationFeedback = `\n\nPrevious submitted BuildPlan was rejected before execution:\n${String(error)}\nSubmit a corrected BuildPlan. Move manual checks to acceptanceCriteria and make every verification entry a host-runnable command.`;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    build: async ({ plan, streamId, tasks, verification, round, feedback, previousReport }) => {
      if (worker.entry.provider === "codex-cli") {
        return runCodexWorkerBuild(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: worker.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onWorkerText: options.onWorkerText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, streamId, tasks, verification, round, feedback, previousReport }
        );
      }
      if (worker.entry.provider === "claude-code-cli") {
        return runClaudeWorkerBuild(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: worker.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onWorkerText: options.onWorkerText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, streamId, tasks, verification, round, feedback, previousReport }
        );
      }
      let report: z.infer<typeof CompletionReportSchema> | undefined;
      const submitTools = {
        submit_completion_report: tool({
          description: "Submit the worker completion report and end building.",
          inputSchema: CompletionReportSchema,
          execute: (input) => {
            report = input;
            return { ok: true };
          }
        })
      };
      const result = await runAgentArtifact({
        model: worker.model,
        modelEntry: worker.entry,
        costRole: "worker",
        ledger: options.ledger,
        system: `${workerPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nIf read_file says you CANNOT view a file's visual content, never guess, infer, or claim to know what it shows. If the task depends on that content and the plan lacks sufficient leader-provided findings, submit a blocked CompletionReport.\nYou must run every verification command before submit_completion_report. In verificationResults[].command, repeat the BuildPlan verification command string verbatim. If you adapt a command for the host platform, still use the plan's original command as command and describe the adapted command plus real output in output.`,
        providerOptions: openAiPromptCacheProviderOptions(worker.entry, options.cwd, "worker"),
        messages: [
          {
            role: "user",
            content: buildWorkerContext({ round, plan, feedback, previousReport, streamId, tasks, verification })
          }
        ],
        tools: mergeTools(makeToolSet({ ...toolContext, media: worker.entry.media }, "worker"), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_completion_report",
        abortSignal: options.abortSignal,
        onText: options.onWorkerText,
        onThinking: options.onWorkerThinking,
        artifactName: "CompletionReport",
        getArtifact: () => report
      });
      if (!result.artifact) throw new Error("Worker finished without submit_completion_report. Retry with an explicit report.");
      return result.artifact;
    },

    review: async ({ plan, report, round, diff }) => {
      if (leader.entry.provider === "codex-cli") {
        return codexLeaderReview(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, report, round, diff }
        );
      }
      if (leader.entry.provider === "claude-code-cli") {
        return claudeLeaderReview(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, report, round, diff }
        );
      }
      let verdict: z.infer<typeof ReviewVerdictSchema> | undefined;
      const submitTools = {
        submit_review: tool({
          description: "Submit the review verdict and end reviewing.",
          inputSchema: ReviewVerdictSchema,
          execute: (input) => {
            verdict = input;
            return { ok: true };
          }
        })
      };
      const system = `${leaderReviewerPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nYou may rerun only the plan verification commands. Prose verdicts are discarded; the turn is only complete after submit_review has been called.`;
      await compactLeaderThread(system);
      leaderThread.push({
        role: "user",
        content: `Review round ${round}. Worker output is summarized here; worker tool results and streams are intentionally not part of the leader thread.\nBuildPlan:\n${jsonBlock(plan)}\n\nCompletionReport:\n${jsonBlock(report)}\n\nDiff:\n${diff || "(empty diff)"}`
      });
      const result = await runAgentArtifact({
        model: leader.model,
        modelEntry: leader.entry,
        costRole: "leader",
        ledger: options.ledger,
        system,
        providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
        systemProviderOptions: leaderSystemProviderOptions(leader.entry),
        messages: leaderThread,
        tools: mergeTools(makeToolSet({ ...toolContext, media: leader.entry.media }, "reviewer", plan.verification), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_review",
        abortSignal: options.abortSignal,
        onText: options.onLeaderText,
        onThinking: options.onLeaderThinking,
        artifactName: "ReviewVerdict",
        getArtifact: () => verdict
      });
      if (result.artifact) {
        leaderThread.push({ role: "assistant", content: artifactThreadMessage("ReviewVerdict", result.artifact, result.text) });
        return result.artifact;
      }
      const extracted = await extractFromProse({
        resolution: leader,
        ledger: options.ledger,
        role: "leader",
        schema: ReviewVerdictSchema,
        artifactName: "ReviewVerdict",
        text: result.text,
        abortSignal: options.abortSignal,
        originalError: new Error("Leader review finished without submit_review.")
      });
      leaderThread.push({ role: "assistant", content: artifactThreadMessage("ReviewVerdict", extracted, result.text) });
      return extracted;
    },

    takeover: async ({ plan, reports, feedback }) => {
      if (leader.entry.provider === "codex-cli") {
        return codexLeaderTakeover(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, reports, feedback }
        );
      }
      if (leader.entry.provider === "claude-code-cli") {
        return claudeLeaderTakeover(
          {
            config: options.config,
            cwd: options.cwd,
            env: options.env,
            entry: leader.entry,
            ledger: options.ledger,
            abortSignal: options.abortSignal,
            onLeaderText: options.onLeaderText,
            onToolEvent: options.onToolEvent,
            projectInstructions: options.projectInstructions,
            confirmCodexWrite: options.confirmCodexWrite
          },
          { plan, reports, feedback }
        );
      }
      let submitted: { report: z.infer<typeof CompletionReportSchema>; userSummary: string } | undefined;
      const submitTools = {
        submit_takeover: tool({
          description: "Submit takeover report and user summary.",
          inputSchema: z.object({ report: CompletionReportSchema, userSummary: z.string() }),
          execute: (input) => {
            submitted = input;
            return { ok: true };
          }
        })
      };
      const system = `${leaderTakeoverPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nRun every verification command, then call submit_takeover. In verificationResults[].command, repeat the BuildPlan verification command string verbatim. If you adapt a command for the host platform, still use the plan's original command as command and describe the adapted command plus real output in output.`;
      await compactLeaderThread(system);
      leaderThread.push({
        role: "user",
        content: `Leader takeover requested.\nBuildPlan:\n${jsonBlock(plan)}\n\nPrevious reports:\n${jsonBlock(reports)}\n\nFeedback history:\n${jsonBlock(feedback)}`
      });
      const result = await runAgentArtifact({
        model: leader.model,
        modelEntry: leader.entry,
        costRole: "leader",
        ledger: options.ledger,
        system,
        providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
        systemProviderOptions: leaderSystemProviderOptions(leader.entry),
        messages: leaderThread,
        tools: mergeTools(makeToolSet({ ...toolContext, media: leader.entry.media }, "takeover"), submitTools),
        maxSteps: Math.max(options.config.maxStepsPerAgentTurn, TAKEOVER_MIN_STEPS),
        stopToolName: "submit_takeover",
        abortSignal: options.abortSignal,
        onText: options.onLeaderText,
        onThinking: options.onLeaderThinking,
        artifactName: "TakeoverReport",
        getArtifact: () => submitted
      });
      if (result.artifact) {
        leaderThread.push({ role: "assistant", content: artifactThreadMessage("TakeoverReport", result.artifact, result.text) });
        return result.artifact;
      }

      const takeoverSchema = z.object({ report: CompletionReportSchema, userSummary: z.string() });
      const extracted = await extractFromProse({
        resolution: leader,
        ledger: options.ledger,
        role: "leader",
        schema: takeoverSchema,
        artifactName: "TakeoverReport",
        text: result.text,
        abortSignal: options.abortSignal,
        originalError: new Error("Leader takeover finished without submit_takeover.")
      });
      leaderThread.push({ role: "assistant", content: artifactThreadMessage("TakeoverReport", extracted, result.text) });
      return extracted;
    }
  };
}

export interface GoalProgressNote {
  goalId: number;
  note: string;
}

export async function suggestGoalProgressNotes(options: Pick<LiveAgentOptions, "config" | "cwd" | "env" | "ledger" | "abortSignal" | "onLeaderText" | "onLeaderThinking"> & {
  goals: Goal[];
  userSummary: string;
}): Promise<GoalProgressNote[]> {
  if (options.goals.length === 0) return [];
  const leader = await makeModel(options.config.leader, options.config, options.env);
  let submitted: { notes: GoalProgressNote[] } | undefined;
  const submitTools = {
    submit_goal_notes: tool({
      description: "Submit one-line progress notes for only the goals that advanced.",
      inputSchema: z.object({
        notes: z.array(
          z.object({
            goalId: z.number().int().positive(),
            note: z.string().min(1).max(240)
          })
        )
      }),
      execute: (input) => {
        submitted = input;
        return { ok: true };
      }
    })
  };
  const result = await runAgentArtifact({
    model: leader.model,
    modelEntry: leader.entry,
    costRole: "leader",
    ledger: options.ledger,
    system: "You update Tandem standing goals. If the completed run advanced a goal, call submit_goal_notes with a short past-tense note. Omit unrelated goals.",
    providerOptions: openAiPromptCacheProviderOptions(leader.entry, options.cwd, "leader"),
    messages: [
      {
        role: "user",
        content: `Active goals:\n${jsonBlock(options.goals.map((goal) => ({ id: goal.id, text: goal.text })))}\n\nRun summary:\n${options.userSummary}`
      }
    ],
    tools: submitTools,
    maxSteps: Math.min(5, options.config.maxStepsPerAgentTurn),
    stopToolName: "submit_goal_notes",
    toolChoice: { type: "tool", toolName: "submit_goal_notes" },
    abortSignal: options.abortSignal,
    onText: options.onLeaderText,
    onThinking: options.onLeaderThinking,
    artifactName: "GoalProgressNotes",
    getArtifact: () => submitted
  });
  const allowedIds = new Set(options.goals.map((goal) => goal.id));
  return (result.artifact?.notes ?? []).filter((note) => allowedIds.has(note.goalId));
}
