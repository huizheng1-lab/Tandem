import { describe, expect, it } from "vitest";
import { enrichAgentError, estimatePromptSize, toolCallThinkingDelta, usageTokens } from "../src/agents/runner.js";

describe("usageTokens", () => {
  it("reads raw OpenAI-compatible usage when AI SDK fields are NaN", () => {
    const tokens = usageTokens({
      inputTokens: Number.NaN,
      outputTokens: Number.NaN,
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 321,
        total_tokens: 1555
      }
    });

    expect(tokens).toEqual({ input: 1234, output: 321 });
  });

  it("derives missing completion tokens from total tokens", () => {
    expect(usageTokens({ promptTokens: 100, completionTokens: Number.NaN, totalTokens: 140 })).toEqual({ input: 100, output: 40 });
  });

  it("enriches no-output errors with provider detail and prompt size", () => {
    const error = Object.assign(new Error("No output generated. Check the stream for errors."), {
      name: "AI_NoOutputGeneratedError",
      finishReason: "error",
      response: { status: 413 },
      responseBody: { error: { message: "context length exceeded" } }
    });

    const enriched = enrichAgentError(error, {
      costRole: "worker",
      modelEntry: { id: "minimax/minimax-m2.7", provider: "openai-compatible", modelName: "m2.7", envKey: "MINIMAX_API_KEY", contextWindow: 100000 },
      system: "system prompt",
      messages: [{ role: "user", content: "x".repeat(80) }]
    });

    expect(enriched.message).toContain("context length exceeded");
    expect(enriched.message).toContain("status: 413");
    expect(enriched.message).toContain("Approx input:");
    expect(enriched.message).toContain("worker minimax/minimax-m2.7");
  });

  it("estimates prompt size from system and messages", () => {
    expect(estimatePromptSize("abcd", [{ role: "user", content: "12345678" }])).toEqual({ chars: 16, approxTokens: 4 });
  });

  it("D98: formats tool-call thinking deltas for tool-only leader streams", () => {
    expect(toolCallThinkingDelta("read_file")).toBe("[tool call: read_file]\n");
    expect(toolCallThinkingDelta("")).toBe("[tool call: tool]\n");
  });
});
