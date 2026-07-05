import { describe, expect, it } from "vitest";
import { usageTokens } from "../src/agents/runner.js";

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
});
