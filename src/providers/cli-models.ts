import type { TandemConfig } from "../config/schema.js";
import type { ModelEntry } from "./registry.js";

export function configuredCliModelName(entry: Pick<ModelEntry, "provider">, config: TandemConfig): string | undefined {
  if (entry.provider === "codex-cli") return config.codexCliModel;
  if (entry.provider === "claude-code-cli") return config.claudeCliModel;
  return undefined;
}

export function withConfiguredCliModel(entry: ModelEntry, config: TandemConfig): ModelEntry {
  const modelName = configuredCliModelName(entry, config);
  return modelName ? { ...entry, modelName } : entry;
}

export function modelDisplayName(modelId: string | undefined, config: TandemConfig | undefined): string {
  if (!modelId || !config) return modelId ?? "unknown";
  if (modelId === "codex/cli") {
    const parts = [`model ${config.codexCliModel ?? "CLI default"}`];
    if (config.codexCliReasoningEffort) parts.push(`reasoning ${config.codexCliReasoningEffort}`);
    return `${modelId} (${parts.join(", ")})`;
  }
  if (modelId === "claude-code/cli") {
    return `${modelId} (model ${config.claudeCliModel ?? "CLI default"})`;
  }
  return modelId;
}
