import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn((options: unknown) => (modelName: string) => ({ modelName, options }))
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic
}));

describe("provider client construction", () => {
  it("pins Anthropic to the canonical API base URL", async () => {
    const { makeModel } = await import("../src/providers/client.js");

    await makeModel("anthropic/claude-sonnet-5", defaultConfig, {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com"
    });

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://api.anthropic.com/v1"
    });
  });
});
