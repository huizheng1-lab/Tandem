import { CustomModel } from "../config/schema.js";

export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compatible";

export interface ModelEntry {
  id: string;
  provider: ProviderKind;
  modelName: string;
  envKey: string;
  baseURL?: string;
  contextWindow: number;
  costHints?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

export const builtInModels: ModelEntry[] = [
  {
    id: "anthropic/claude-fable-5",
    provider: "anthropic",
    modelName: "claude-fable-5",
    envKey: "ANTHROPIC_API_KEY",
    contextWindow: 200000,
    costHints: { inputPerMillion: 15, outputPerMillion: 75 }
  },
  {
    id: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    modelName: "claude-opus-4-8",
    envKey: "ANTHROPIC_API_KEY",
    contextWindow: 200000,
    costHints: { inputPerMillion: 15, outputPerMillion: 75 }
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    modelName: "claude-sonnet-5",
    envKey: "ANTHROPIC_API_KEY",
    contextWindow: 200000,
    costHints: { inputPerMillion: 3, outputPerMillion: 15 }
  },
  {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    modelName: "claude-haiku-4-5",
    envKey: "ANTHROPIC_API_KEY",
    contextWindow: 200000,
    costHints: { inputPerMillion: 1, outputPerMillion: 5 }
  },
  {
    id: "google/gemini-2.5-pro",
    provider: "google",
    modelName: "gemini-2.5-pro",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000,
    costHints: { inputPerMillion: 1.25, outputPerMillion: 10 }
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    modelName: "gemini-2.5-flash",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000,
    costHints: { inputPerMillion: 0.3, outputPerMillion: 2.5 }
  },
  {
    id: "google/gemini-3.5-flash",
    provider: "google",
    modelName: "gemini-3.5-flash",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000
  },
  {
    id: "google/gemini-3.1-pro-preview",
    provider: "google",
    modelName: "gemini-3.1-pro-preview",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000
  },
  {
    id: "google/gemini-3-pro-preview",
    provider: "google",
    modelName: "gemini-3-pro-preview",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000
  },
  {
    id: "google/gemini-3.1-flash-lite",
    provider: "google",
    modelName: "gemini-3.1-flash-lite",
    envKey: "GEMINI_API_KEY",
    contextWindow: 1000000
  },
  {
    id: "openai/gpt-5",
    provider: "openai",
    modelName: "gpt-5",
    envKey: "OPENAI_API_KEY",
    contextWindow: 256000,
    costHints: { inputPerMillion: 10, outputPerMillion: 30 }
  },
  {
    id: "openai/gpt-5-mini",
    provider: "openai",
    modelName: "gpt-5-mini",
    envKey: "OPENAI_API_KEY",
    contextWindow: 128000,
    costHints: { inputPerMillion: 1, outputPerMillion: 4 }
  }
];

export function customToModelEntry(model: CustomModel): ModelEntry {
  return {
    id: model.id,
    provider: model.provider ?? "openai-compatible",
    modelName: model.modelName,
    envKey: model.apiKeyEnv,
    baseURL: model.baseURL,
    contextWindow: model.contextWindow ?? 128000,
    costHints: model.costHints
  };
}

export function modelRegistry(customModels: CustomModel[] = []): ModelEntry[] {
  const custom = customModels.map(customToModelEntry);
  const customIds = new Set(custom.map((model) => model.id));
  return [...custom, ...builtInModels.filter((model) => !customIds.has(model.id))];
}

export function resolveModel(id: string, customModels: CustomModel[] = []): ModelEntry {
  const registry = modelRegistry(customModels);
  const model = registry.find((entry) => entry.id === id);
  if (!model) {
    const ids = registry.map((entry) => entry.id).join(", ");
    throw new Error(`Unknown model "${id}". Set config field leader/worker to one of: ${ids}`);
  }
  return model;
}

export function validateModelEnv(entry: ModelEntry, env: NodeJS.ProcessEnv): void {
  if (!env[entry.envKey]) {
    throw new Error(`Missing ${entry.envKey} for model ${entry.id}. Add it to .env or ~/.tandem/.env, then retry.`);
  }
}
