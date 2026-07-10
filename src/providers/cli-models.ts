import { CodexCliReasoningEffortSchema, type TandemConfig } from "../config/schema.js";
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

export const modelCommandUsage =
  "Usage: /model leader <id>, /model worker <id>, /model claude-cli <model|clear>, /model codex-cli <model|clear>, or /model codex-effort <minimal|low|medium|high|clear>";

export function cliModelPatch(target: string | undefined, value: string | undefined): { patch?: Partial<TandemConfig>; message?: string; usage?: string } {
  if (!target || !value) return { usage: modelCommandUsage };
  const normalized = value.trim();
  if (!normalized) return { usage: modelCommandUsage };
  const cleared = normalized === "clear" || normalized === "default";
  if (target === "claude-cli") {
    return {
      patch: { claudeCliModel: cleared ? undefined : normalized },
      message: cleared ? "Set Claude Code CLI model to CLI default." : `Set Claude Code CLI model to ${normalized}.`
    };
  }
  if (target === "codex-cli") {
    return {
      patch: { codexCliModel: cleared ? undefined : normalized },
      message: cleared ? "Set Codex CLI model to CLI default." : `Set Codex CLI model to ${normalized}.`
    };
  }
  if (target === "codex-effort") {
    if (cleared) {
      return { patch: { codexCliReasoningEffort: undefined }, message: "Set Codex CLI reasoning effort to CLI default." };
    }
    const parsed = CodexCliReasoningEffortSchema.safeParse(normalized);
    if (!parsed.success) return { usage: "Usage: /model codex-effort <minimal|low|medium|high|clear>" };
    return {
      patch: { codexCliReasoningEffort: parsed.data },
      message: `Set Codex CLI reasoning effort to ${parsed.data}.`
    };
  }
  return { usage: modelCommandUsage };
}
