import { describe, expect, it } from "vitest";
import { leaderSystemProviderOptions, openAiPromptCacheProviderOptions } from "../src/agents/live.js";
import { leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt } from "../src/agents/leader.js";
import { hostPlatformPrompt } from "../src/agents/platform.js";
import { defaultConfig } from "../src/config/schema.js";
import type { ModelEntry } from "../src/providers/registry.js";

const anthropicEntry: ModelEntry = { id: "anthropic/claude-sonnet-5", provider: "anthropic", modelName: "claude-sonnet-5", contextWindow: 200000 };
const googleEntry: ModelEntry = { id: "google/gemini-2.5-pro", provider: "google", modelName: "gemini-2.5-pro", contextWindow: 1000000 };
const openaiEntry: ModelEntry = { id: "openai/gpt-5", provider: "openai", modelName: "gpt-5", contextWindow: 400000 };
const openaiCompatibleEntry: ModelEntry = { id: "minimax/minimax-m2.7", provider: "openai-compatible", modelName: "minimax-M2.7", contextWindow: 128000 };

describe("leader system-prompt caching (D45)", () => {
  it("returns an Anthropic cache-control breakpoint only for the anthropic provider", () => {
    expect(leaderSystemProviderOptions(anthropicEntry)).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral" }
      }
    });
    expect(leaderSystemProviderOptions(googleEntry)).toBeUndefined();
    expect(leaderSystemProviderOptions(openaiCompatibleEntry)).toBeUndefined();
  });

  it("treats Claude Code CLI the same as every other provider (no cache breakpoint - that engine is out of scope)", async () => {
    const codexEntry: ModelEntry = { id: "codex/cli", provider: "codex-cli", modelName: "", contextWindow: 256000 };
    const claudeCodeEntry: ModelEntry = { id: "claude-code/cli", provider: "claude-code-cli", modelName: "", contextWindow: 200000 };
    expect(leaderSystemProviderOptions(codexEntry)).toBeUndefined();
    expect(leaderSystemProviderOptions(claudeCodeEntry)).toBeUndefined();
  });

  it("requires providerOptions payload for Anthropic to attach ephemeral cache breakpoint (not just any options)", () => {
    const options = leaderSystemProviderOptions(anthropicEntry);
    expect(options).toBeDefined();
    const anthropicOptions = (options as { anthropic: { cacheControl: { type: string } } }).anthropic;
    expect(anthropicOptions.cacheControl.type).toBe("ephemeral");
  });
});

describe("OpenAI prompt cache key routing (D73)", () => {
  it("returns deterministic role-scoped OpenAI prompt cache keys", () => {
    const cwd = "C:\\Users\\demo\\Secret Project";
    const leaderOptions = openAiPromptCacheProviderOptions(openaiEntry, cwd, "leader") as { openai: { promptCacheKey: string } };
    const sameLeaderOptions = openAiPromptCacheProviderOptions(openaiEntry, cwd, "leader") as { openai: { promptCacheKey: string } };
    const workerOptions = openAiPromptCacheProviderOptions(openaiEntry, cwd, "worker") as { openai: { promptCacheKey: string } };

    expect(leaderOptions.openai.promptCacheKey).toBe(sameLeaderOptions.openai.promptCacheKey);
    expect(leaderOptions.openai.promptCacheKey).toMatch(/^tandem:leader:v1:[a-f0-9]{16}$/);
    expect(workerOptions.openai.promptCacheKey).toMatch(/^tandem:worker:v1:[a-f0-9]{16}$/);
    expect(workerOptions.openai.promptCacheKey).not.toBe(leaderOptions.openai.promptCacheKey);
    expect(leaderOptions.openai.promptCacheKey.length).toBeLessThanOrEqual(64);
    expect(workerOptions.openai.promptCacheKey.length).toBeLessThanOrEqual(64);
  });

  it("does not leak raw local paths into OpenAI prompt cache keys", () => {
    const options = openAiPromptCacheProviderOptions(openaiEntry, "C:\\Users\\demo\\Secret Project", "leader") as { openai: { promptCacheKey: string } };

    expect(options.openai.promptCacheKey).not.toContain("Users");
    expect(options.openai.promptCacheKey).not.toContain("Secret");
    expect(options.openai.promptCacheKey).not.toContain("\\");
  });

  it("only applies OpenAI prompt cache keys to the official OpenAI provider", () => {
    expect(openAiPromptCacheProviderOptions(anthropicEntry, process.cwd(), "leader")).toBeUndefined();
    expect(openAiPromptCacheProviderOptions(googleEntry, process.cwd(), "leader")).toBeUndefined();
    expect(openAiPromptCacheProviderOptions(openaiCompatibleEntry, process.cwd(), "worker")).toBeUndefined();
  });
});

describe("leader prompt stability (D45-1)", () => {
  // The static prefix must be byte-identical across calls of the same kind for the cache
  // breakpoint to actually amortize cost. We assert each leader system string has the
  // components in the same canonical order, with the variable trailer appended last.
  const hostPrompt = hostPlatformPrompt(process.platform, {});
  const projectInstructions = async () => "Project instructions:\n- Ship a stable build.";
  const memoryInstruction = "memory placeholder line";

  it("plan system strings start with persona + host + project instructions + memoryInstruction in that order", async () => {
    const planSystem = `${leaderPlannerPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nthen trailer A`;
    expect(planSystem.indexOf(leaderPlannerPrompt)).toBe(0);
    expect(planSystem.indexOf(hostPrompt)).toBeGreaterThan(0);
    expect(planSystem.indexOf("Project instructions:\n- Ship a stable build.")).toBeGreaterThan(planSystem.indexOf(hostPrompt));
    expect(planSystem.indexOf(memoryInstruction)).toBeGreaterThan(planSystem.indexOf("Project instructions:\n- Ship a stable build."));
    expect(planSystem.indexOf("then trailer A")).toBeGreaterThan(planSystem.indexOf(memoryInstruction));
  });

  it("review system strings start with persona + host + project instructions + memoryInstruction in that order", async () => {
    const reviewSystem = `${leaderReviewerPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nthen trailer B`;
    expect(reviewSystem.indexOf(leaderReviewerPrompt)).toBe(0);
    expect(reviewSystem.indexOf(hostPrompt)).toBeGreaterThan(0);
    expect(reviewSystem.indexOf("Project instructions:\n- Ship a stable build.")).toBeGreaterThan(reviewSystem.indexOf(hostPrompt));
    expect(reviewSystem.indexOf(memoryInstruction)).toBeGreaterThan(reviewSystem.indexOf("Project instructions:\n- Ship a stable build."));
    expect(reviewSystem.indexOf("then trailer B")).toBeGreaterThan(reviewSystem.indexOf(memoryInstruction));
  });

  it("takeover system strings start with persona + host + project instructions + memoryInstruction in that order", async () => {
    const takeoverSystem = `${leaderTakeoverPrompt}\n${hostPrompt}\n${await projectInstructions()}\n${memoryInstruction}\nthen trailer C`;
    expect(takeoverSystem.indexOf(leaderTakeoverPrompt)).toBe(0);
    expect(takeoverSystem.indexOf(hostPrompt)).toBeGreaterThan(0);
    expect(takeoverSystem.indexOf("Project instructions:\n- Ship a stable build.")).toBeGreaterThan(takeoverSystem.indexOf(hostPrompt));
    expect(takeoverSystem.indexOf(memoryInstruction)).toBeGreaterThan(takeoverSystem.indexOf("Project instructions:\n- Ship a stable build."));
    expect(takeoverSystem.indexOf("then trailer C")).toBeGreaterThan(takeoverSystem.indexOf(memoryInstruction));
  });

  it("defaultConfig leader is one of the entry IDs supported by the registry", () => {
    expect(defaultConfig.leader).toMatch(/^anthropic\/|^google\/|^openai\/|^codex\/cli|^claude-code\/cli/);
  });
});
