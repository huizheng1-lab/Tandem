import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn((options: unknown) => (modelName: string) => ({ modelName, options })),
  createGoogleGenerativeAI: vi.fn((options: unknown) => (modelName: string) => ({ modelName, options }))
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mocks.createGoogleGenerativeAI
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

  it("passes Gemini 3.6 Flash's provider model identifier for leader and worker selections", async () => {
    const { makeModel } = await import("../src/providers/client.js");
    const config = { ...defaultConfig, leader: "google/gemini-3.6-flash", worker: "google/gemini-3.6-flash" };

    const leader = await makeModel(config.leader, config, { GEMINI_API_KEY: "test-key" });
    const worker = await makeModel(config.worker, config, { GEMINI_API_KEY: "test-key" });

    expect(leader.entry).toMatchObject({ id: "google/gemini-3.6-flash", provider: "google", modelName: "gemini-3.6-flash" });
    expect(worker.entry).toMatchObject({ id: "google/gemini-3.6-flash", provider: "google", modelName: "gemini-3.6-flash" });
    expect(mocks.createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(leader.model).toMatchObject({ modelName: "gemini-3.6-flash" });
    expect(worker.model).toMatchObject({ modelName: "gemini-3.6-flash" });
  });
});
