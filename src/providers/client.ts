import { TandemConfig } from "../config/schema.js";
import { ModelEntry, resolveModel, validateModelEnv } from "./registry.js";
import type { LanguageModel } from "ai";

export interface ModelResolution {
  entry: ModelEntry;
  model: LanguageModel;
}

export async function makeModel(modelId: string, config: TandemConfig, env: NodeJS.ProcessEnv = process.env): Promise<ModelResolution> {
  const entry = resolveModel(modelId, config.customModels);
  validateModelEnv(entry, env, { codexCliPath: config.codexCliPath, claudeCliPath: config.claudeCliPath });

  if (entry.provider === "codex-cli" || entry.provider === "claude-code-cli") {
    return { entry, model: {} as LanguageModel };
  }

  if (entry.provider === "anthropic") {
    const apiKey = env[entry.envKey as string];
    const mod = await import("@ai-sdk/anthropic");
    // SDK boundary: provider factory names are version-coupled, so isolate dynamic access here.
    const createAnthropic = (mod as Record<string, unknown>).createAnthropic as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createAnthropic({ apiKey })(entry.modelName) };
  }

  if (entry.provider === "openai") {
    const apiKey = env[entry.envKey as string];
    const mod = await import("@ai-sdk/openai");
    // SDK boundary: see note above.
    const createOpenAI = (mod as Record<string, unknown>).createOpenAI as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createOpenAI({ apiKey })(entry.modelName) };
  }

  if (entry.provider === "google") {
    const apiKey = env[entry.envKey as string];
    const mod = await import("@ai-sdk/google");
    // SDK boundary: see note above.
    const createGoogle = (mod as Record<string, unknown>).createGoogleGenerativeAI as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createGoogle({ apiKey })(entry.modelName) };
  }

  const mod = await import("@ai-sdk/openai-compatible");
  if (!entry.baseURL) throw new Error(`Custom model ${entry.id} is openai-compatible and requires baseURL.`);
  // SDK boundary: see note above.
  const createOpenAICompatible = (mod as Record<string, unknown>).createOpenAICompatible as (options: {
    name: string;
    apiKey?: string;
    baseURL: string;
    includeUsage?: boolean;
  }) => (modelName: string) => LanguageModel;
  return {
    entry,
    model: createOpenAICompatible({
      name: entry.id.split("/")[0] ?? "compatible",
    apiKey: env[entry.envKey as string],
      baseURL: entry.baseURL,
      includeUsage: true
    })(entry.modelName)
  };
}
