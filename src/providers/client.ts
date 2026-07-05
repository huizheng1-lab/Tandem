import { TandemConfig } from "../config/schema.js";
import { ModelEntry, resolveModel, validateModelEnv } from "./registry.js";
import type { LanguageModel } from "ai";

export interface ModelResolution {
  entry: ModelEntry;
  model: LanguageModel;
}

export async function makeModel(modelId: string, config: TandemConfig, env: NodeJS.ProcessEnv = process.env): Promise<ModelResolution> {
  const entry = resolveModel(modelId, config.customModels);
  validateModelEnv(entry, env);

  if (entry.provider === "anthropic") {
    const mod = await import("@ai-sdk/anthropic");
    // SDK boundary: provider factory names are version-coupled, so isolate dynamic access here.
    const createAnthropic = (mod as Record<string, unknown>).createAnthropic as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createAnthropic({ apiKey: env[entry.envKey] })(entry.modelName) };
  }

  if (entry.provider === "openai") {
    const mod = await import("@ai-sdk/openai");
    // SDK boundary: see note above.
    const createOpenAI = (mod as Record<string, unknown>).createOpenAI as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createOpenAI({ apiKey: env[entry.envKey] })(entry.modelName) };
  }

  if (entry.provider === "google") {
    const mod = await import("@ai-sdk/google");
    // SDK boundary: see note above.
    const createGoogle = (mod as Record<string, unknown>).createGoogleGenerativeAI as (options: { apiKey?: string }) => (modelName: string) => LanguageModel;
    return { entry, model: createGoogle({ apiKey: env[entry.envKey] })(entry.modelName) };
  }

  const mod = await import("@ai-sdk/openai-compatible");
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
      apiKey: env[entry.envKey],
      baseURL: entry.baseURL ?? "",
      includeUsage: true
    })(entry.modelName)
  };
}
