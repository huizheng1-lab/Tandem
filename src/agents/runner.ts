import { streamText } from "ai";

export interface RunnerMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentRunOptions {
  model: unknown;
  system: string;
  messages: RunnerMessage[];
  tools?: Record<string, unknown>;
  maxSteps: number;
  onText?: (text: string) => void;
  abortSignal?: AbortSignal;
}

export async function runAgentText(options: AgentRunOptions): Promise<string> {
  const result = streamText({
    // SDK boundary: Tandem resolves concrete LanguageModel instances dynamically.
    model: options.model as never,
    system: options.system,
    messages: options.messages,
    tools: options.tools as never,
    stopWhen: ({ steps }) => steps.length >= options.maxSteps,
    abortSignal: options.abortSignal
  });

  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
    options.onText?.(delta);
  }
  return text;
}
