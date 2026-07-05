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
  onUsage?: (usage: LanguageModelUsage) => void;
  abortSignal?: AbortSignal;
  stopToolName?: string;
}

function isRetryable(error: unknown): boolean {
  const text = String(error);
  return /\b(429|500|502|503|504)\b/.test(text);
}

function usageTokens(usage: LanguageModelUsage): { input: number; output: number } {
  const value = usage as unknown as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  return {
    input: value.inputTokens ?? value.promptTokens ?? 0,
    output: value.outputTokens ?? value.completionTokens ?? 0
  };
}

export async function runAgentText(options: AgentRunOptions): Promise<{ text: string; usage?: LanguageModelUsage }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let finishedUsage: LanguageModelUsage | undefined;
      const result = streamText({
        model: options.model,
        system: options.system,
        messages: options.messages,
        tools: options.tools,
        stopWhen: options.stopToolName ? [stepCountIs(options.maxSteps), hasToolCall(options.stopToolName)] : stepCountIs(options.maxSteps),
        abortSignal: options.abortSignal,
        maxRetries: 2,
        onFinish: ({ totalUsage }) => {
          finishedUsage = totalUsage;
          options.onUsage?.(totalUsage);
          if (options.ledger && options.costRole && options.modelEntry) {
            const tokens = usageTokens(totalUsage);
            options.ledger.add(options.costRole, options.modelEntry, tokens.input, tokens.output);
          }
        }
      });

      let text = "";
      for await (const delta of result.textStream) {
        text += delta;
        options.onText?.(delta);
      }
      finishedUsage ??= await result.totalUsage;
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
  return { ...result, artifact: options.getArtifact() };
}
