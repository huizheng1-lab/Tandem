import { hasToolCall, stepCountIs, streamText } from "ai";
import type { LanguageModel, LanguageModelUsage, ToolSet } from "ai";
import { CostLedger, CostRole } from "../session/cost.js";
import { ModelEntry } from "../providers/registry.js";

export interface RunnerMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentRunOptions {
  model: LanguageModel;
  modelEntry?: ModelEntry;
  costRole?: CostRole;
  ledger?: CostLedger;
  system: string;
  messages: RunnerMessage[];
  tools?: ToolSet;
  maxSteps: number;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onUsage?: (usage: LanguageModelUsage) => void;
  abortSignal?: AbortSignal;
  stopToolName?: string;
  toolChoice?: { type: "tool"; toolName: string };
}

function isRetryable(error: unknown): boolean {
  const text = String(error);
  return /\b(429|500|502|503|504)\b/.test(text);
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

  constructor(private readonly onText?: (text: string) => void, private readonly onThinking?: (text: string) => void) {}

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
        continue;
      }

      const openIndex = this.buffer.toLowerCase().indexOf("<think>");
      if (openIndex === -1) {
        const keep = suffixPrefixLength(this.buffer, "<think>");
        const ready = keep > 0 ? this.buffer.slice(0, -keep) : this.buffer;
        if (ready) {
          text += ready;
          this.onText?.(ready);
        }
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : "";
        break;
      }

      const ready = this.buffer.slice(0, openIndex);
      if (ready) {
        text += ready;
        this.onText?.(ready);
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
    this.onText?.(remaining);
    return { text: remaining, thinking: "" };
  }
}

export async function runAgentText(options: AgentRunOptions): Promise<{ text: string; usage?: LanguageModelUsage }> {
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
      const result = streamText({
        model: options.model,
        system: options.system,
        messages: options.messages,
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
        }
      }
      text += filter.end().text;
      if (streamError) throw streamError;
      finishedUsage ??= await result.totalUsage;
      recordUsage(finishedUsage);
      return { text, usage: finishedUsage };
    } catch (error) {
      lastError = error;
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

  // The model finished its work but ended the turn in prose instead of calling its submit tool.
  // Continue the conversation once with the tool call forced.
  const nudged = await runAgentText({
    ...options,
    messages: [
      ...options.messages,
      { role: "assistant", content: result.text || "(no text)" },
      { role: "user", content: `You did not call ${options.stopToolName}. Call ${options.stopToolName} now with your final ${options.artifactName}. Do not write prose.` }
    ],
    toolChoice: { type: "tool", toolName: options.stopToolName }
  });
  return { ...nudged, text: `${result.text}${nudged.text}`, artifact: options.getArtifact() };
}
