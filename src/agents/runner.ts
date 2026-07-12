import { hasToolCall, stepCountIs, streamText } from "ai";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { CostLedger, CostRole } from "../session/cost.js";
import { ModelEntry } from "../providers/registry.js";
import type { ContentPart } from "../session/attachments.js";

export interface RunnerMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface AgentRunOptions {
  model: LanguageModel;
  modelEntry?: ModelEntry;
  costRole?: CostRole;
  ledger?: CostLedger;
  system: string;
  providerOptions?: ProviderOptions;
  systemProviderOptions?: ProviderOptions;
  messages: RunnerMessage[];
  tools?: ToolSet;
  maxSteps: number;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCallThinking?: (toolName: string) => void;
  onUsage?: (usage: LanguageModelUsage) => void;
  abortSignal?: AbortSignal;
  stopToolName?: string;
  toolChoice?: { type: "tool"; toolName: string };
}

export interface PromptSizeEstimate {
  chars: number;
  approxTokens: number;
}

interface AgentTextResult {
  text: string;
  usage?: LanguageModelUsage;
  responseMessages: ModelMessage[];
  stepsUsed: number;
}

const ARTIFACT_NUDGE_MAX_STEPS = 3;

export function toolCallThinkingDelta(toolName: string): string {
  return `[tool call: ${toolName || "tool"}]\n`;
}

function isRetryable(error: unknown): boolean {
  const text = String(error);
  return /\b(429|500|502|503|504)\b/.test(text);
}

function truncate(value: string, max = 1200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

export function estimatePromptSize(system: string, messages: RunnerMessage[]): PromptSizeEstimate {
  const chars =
    system.length +
    messages.reduce((sum, message) => {
      const contentLength = typeof message.content === "string" ? message.content.length : message.content.reduce((partSum, part) => partSum + (part.type === "text" ? part.text.length : 512), 0);
      return sum + message.role.length + contentLength;
    }, 0);
  return { chars, approxTokens: Math.ceil(chars / 4) };
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key] as Record<string, unknown> | undefined;
  }
  return current;
}

function providerDetail(error: unknown): string {
  const value = error as Record<string, unknown>;
  const fields: string[] = [];
  const add = (label: string, detail: unknown) => {
    const text = safeJson(detail);
    if (text) fields.push(`${label}: ${text}`);
  };
  add("finishReason", value.finishReason ?? value.finish_reason ?? value.finish);
  add("status", value.status ?? value.statusCode ?? value.status_code ?? valueAtPath(error, ["response", "status"]));
  add("responseBody", value.responseBody ?? value.body ?? value.data ?? valueAtPath(error, ["response", "body"]) ?? valueAtPath(error, ["cause", "responseBody"]));
  add("providerMetadata", value.providerMetadata ?? value.provider_metadata);
  add("cause", value.cause);
  return fields.join("; ") || "provider did not expose response detail";
}

export function isNoOutputGeneratedError(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown };
  const text = `${String(value.name ?? "")} ${String(value.code ?? "")} ${String(error)}`;
  return /NoOutputGenerated|AI_NoOutputGenerated|No output generated/i.test(text);
}

export function enrichAgentError(error: unknown, options: Pick<AgentRunOptions, "system" | "messages" | "costRole" | "modelEntry">): Error {
  if (!isNoOutputGeneratedError(error)) return error instanceof Error ? error : new Error(String(error));
  const estimate = estimatePromptSize(options.system, options.messages);
  const role = options.costRole ?? "agent";
  const model = options.modelEntry?.id ?? "unknown model";
  const message = `${String(error)} Provider detail: ${providerDetail(error)}. Approx input: ${estimate.approxTokens} tokens (${estimate.chars} chars) for ${role} ${model}.`;
  return new Error(message, { cause: error });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

export function usageTokens(usage: unknown): { input: number; output: number } {
  const value = (usage ?? {}) as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
    promptTokens?: unknown;
    completionTokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    usage?: unknown;
  };
  const nested = (value.usage ?? {}) as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
    promptTokens?: unknown;
    completionTokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  let input = firstNumber(value.inputTokens, value.promptTokens, value.input_tokens, value.prompt_tokens, nested.inputTokens, nested.promptTokens, nested.input_tokens, nested.prompt_tokens);
  let output = firstNumber(
    value.outputTokens,
    value.completionTokens,
    value.output_tokens,
    value.completion_tokens,
    nested.outputTokens,
    nested.completionTokens,
    nested.output_tokens,
    nested.completion_tokens
  );
  const total = firstNumber(value.totalTokens, value.total_tokens, nested.totalTokens, nested.total_tokens);
  if ((output === undefined || output === 0) && total !== undefined && input !== undefined && total >= input) output = total - input;
  if ((input === undefined || input === 0) && total !== undefined && output !== undefined && total >= output) input = total - output;
  return { input: input ?? 0, output: output ?? 0 };
}

function suffixPrefixLength(value: string, tag: string): number {
  const lowerValue = value.toLowerCase();
  const lowerTag = tag.toLowerCase();
  const max = Math.min(lowerValue.length, lowerTag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (lowerValue.endsWith(lowerTag.slice(0, length))) return length;
  }
  return 0;
}

export class ThinkingStreamFilter {
  private buffer = "";
  private inThinking = false;
  private suppressFollowingWhitespace = false;
  private hasVisibleNonWhitespace = false;

  constructor(private readonly onText?: (text: string) => void, private readonly onThinking?: (text: string) => void) {}

  private emitText(delta: string): string {
    if (!delta) return "";
    this.hasVisibleNonWhitespace ||= /\S/.test(delta);
    this.onText?.(delta);
    return delta;
  }

  push(delta: string): { text: string; thinking: string } {
    this.buffer += delta;
    let text = "";
    let thinking = "";

    while (this.buffer.length > 0) {
      if (this.inThinking) {
        const closeIndex = this.buffer.toLowerCase().indexOf("</think>");
        if (closeIndex === -1) {
          const keep = suffixPrefixLength(this.buffer, "</think>");
          const ready = keep > 0 ? this.buffer.slice(0, -keep) : this.buffer;
          if (ready) {
            thinking += ready;
            this.onThinking?.(ready);
          }
          this.buffer = keep > 0 ? this.buffer.slice(-keep) : "";
          break;
        }

        const ready = this.buffer.slice(0, closeIndex);
        if (ready) {
          thinking += ready;
          this.onThinking?.(ready);
        }
        this.buffer = this.buffer.slice(closeIndex + "</think>".length);
        this.inThinking = false;
        this.suppressFollowingWhitespace = true;
        continue;
      }

      if (this.suppressFollowingWhitespace) {
        const trimmed = this.buffer.replace(/^\s+/, "");
        if (trimmed.length === 0) {
          this.buffer = "";
          break;
        }
        this.buffer = trimmed;
        this.suppressFollowingWhitespace = false;
      }

      const lowerBuffer = this.buffer.toLowerCase();
      const strayCloseIndex = lowerBuffer.indexOf("</think>");
      const openIndex = lowerBuffer.indexOf("<think>");
      if (strayCloseIndex !== -1 && (openIndex === -1 || strayCloseIndex < openIndex)) {
        const ready = this.buffer.slice(0, strayCloseIndex);
        if (ready && (!/^\s+$/.test(ready) || this.hasVisibleNonWhitespace)) {
          text += this.emitText(ready);
        }
        this.buffer = this.buffer.slice(strayCloseIndex + "</think>".length);
        this.suppressFollowingWhitespace = true;
        continue;
      }

      if (openIndex === -1) {
        const keep = Math.max(suffixPrefixLength(this.buffer, "<think>"), suffixPrefixLength(this.buffer, "</think>"));
        const ready = keep > 0 ? this.buffer.slice(0, -keep) : this.buffer;
        if (ready) {
          text += this.emitText(ready);
        }
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : "";
        break;
      }

      const ready = this.buffer.slice(0, openIndex);
      if (ready && (!/^\s+$/.test(ready) || this.hasVisibleNonWhitespace)) {
        text += this.emitText(ready);
      }
      this.buffer = this.buffer.slice(openIndex + "<think>".length);
      this.inThinking = true;
    }

    return { text, thinking };
  }

  end(): { text: string; thinking: string } {
    if (!this.buffer) return { text: "", thinking: "" };
    const remaining = this.buffer;
    this.buffer = "";
    if (this.inThinking) {
      this.onThinking?.(remaining);
      return { text: "", thinking: remaining };
    }
    const visible = this.suppressFollowingWhitespace ? remaining.replace(/^\s+/, "") : remaining;
    return { text: this.emitText(visible), thinking: "" };
  }
}

export async function runAgentText(options: AgentRunOptions): Promise<AgentTextResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let finishedUsage: LanguageModelUsage | undefined;
      let streamError: unknown;
      let recordedUsage = false;
      let stepInputTokens = 0;
      let stepOutputTokens = 0;
      const recordUsage = (usage: unknown) => {
        if (!options.ledger || !options.costRole || !options.modelEntry || recordedUsage) return;
        const tokens = usageTokens(usage);
        const input = tokens.input || stepInputTokens;
        const output = tokens.output || stepOutputTokens;
        options.ledger.add(options.costRole, options.modelEntry, input, output);
        recordedUsage = true;
      };
      // When providerOptions are attached to the system message (e.g. Anthropic cacheControl),
      // route the system through the messages array as a SystemModelMessage rather than the
      // top-level `system` string, so the AI SDK forwards providerOptions to the provider.
      const streamMessages = options.systemProviderOptions
        ? [{ role: "system" as const, content: options.system, providerOptions: options.systemProviderOptions }, ...options.messages]
        : options.messages;
      const result = streamText({
        model: options.model,
        ...(options.systemProviderOptions ? {} : { system: options.system }),
        messages: streamMessages as never,
        allowSystemInMessages: true,
        providerOptions: options.providerOptions,
        tools: options.tools,
        stopWhen: options.stopToolName ? [stepCountIs(options.maxSteps), hasToolCall(options.stopToolName)] : stepCountIs(options.maxSteps),
        toolChoice: options.toolChoice,
        abortSignal: options.abortSignal,
        maxRetries: 2,
        onError: ({ error }) => {
          streamError = error;
        },
        onStepFinish: ({ usage }) => {
          const tokens = usageTokens(usage);
          stepInputTokens += tokens.input;
          stepOutputTokens += tokens.output;
        },
        onFinish: ({ totalUsage }) => {
          finishedUsage = totalUsage;
          options.onUsage?.(totalUsage);
          recordUsage(totalUsage);
        }
      });

      let text = "";
      const filter = new ThinkingStreamFilter(options.onText, options.onThinking);
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          const visible = filter.push(part.text).text;
          text += visible;
        } else if (part.type === "reasoning-delta") {
          const reasoning = "text" in part ? part.text : (part as { delta?: string }).delta;
          if (reasoning) options.onThinking?.(reasoning);
        } else if (part.type === "tool-call") {
          const toolName = "toolName" in part && typeof part.toolName === "string" ? part.toolName : "tool";
          options.onToolCallThinking?.(toolName);
        }
      }
      text += filter.end().text;
      if (streamError) throw streamError;
      finishedUsage ??= await result.totalUsage;
      recordUsage(finishedUsage);
      const response = result.response ? await result.response : undefined;
      const steps = result.steps ? await result.steps : undefined;
      return {
        text,
        usage: finishedUsage,
        responseMessages: (response?.messages ?? []) as ModelMessage[],
        stepsUsed: steps?.length ?? 0
      };
    } catch (error) {
      lastError = enrichAgentError(error, options);
      if (!isRetryable(error) || attempt === 2 || options.abortSignal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runAgentArtifact<T>(options: AgentRunOptions & { artifactName: string; getArtifact: () => T | undefined }): Promise<{ artifact?: T; text: string; usage?: LanguageModelUsage }> {
  const result = await runAgentText(options);
  const artifact = options.getArtifact();
  if (artifact !== undefined || !options.stopToolName) return { ...result, artifact };

  const remainingSteps = Math.max(0, options.maxSteps - result.stepsUsed);
  if (remainingSteps === 0) return { ...result, artifact };

  // The model finished its work but ended the turn in prose instead of calling its submit tool.
  // Continue the complete generated conversation once with the tool call forced.
  const generatedMessages = result.responseMessages.length > 0
    ? result.responseMessages
    : [{ role: "assistant" as const, content: result.text || "(no text)" }];
  const nudged = await runAgentText({
    ...options,
    messages: [
      ...options.messages,
      ...generatedMessages,
      { role: "user", content: `You did not call ${options.stopToolName}. Call ${options.stopToolName} now with your final ${options.artifactName}. Do not write prose.` }
    ] as RunnerMessage[],
    maxSteps: Math.min(remainingSteps, ARTIFACT_NUDGE_MAX_STEPS),
    toolChoice: { type: "tool", toolName: options.stopToolName }
  });
  return { ...nudged, text: `${result.text}${nudged.text}`, artifact: options.getArtifact() };
}
