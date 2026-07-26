import { CodexCliReasoningEffortSchema, type TandemConfig } from "../config/schema.js";
import type { ModelEntry } from "./registry.js";

export const CLAUDE_CLI_OPUS_5_MODEL = "claude-opus-5";
export const CLAUDE_CLI_OPUS_5_ID = "claude-code/opus-5";
export const CLAUDE_CLI_MODEL_OPTIONS = ["haiku", "sonnet", "opus", "claude-fable-5", CLAUDE_CLI_OPUS_5_MODEL] as const;

export function normalizeClaudeCliModelName(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "opus-5" || normalized === "opus5" || normalized === "claude-opus5" || normalized === CLAUDE_CLI_OPUS_5_MODEL) {
    return CLAUDE_CLI_OPUS_5_MODEL;
  }
  return trimmed;
}

export function configuredCliModelName(entry: Pick<ModelEntry, "id" | "provider">, config: TandemConfig): string | undefined {
  if (entry.provider === "codex-cli" && "id" in entry && entry.id === "codex/cli") return config.codexCliModel;
  if (entry.provider === "claude-code-cli" && "id" in entry && entry.id === "claude-code/cli") {
    return config.claudeCliModel ? normalizeClaudeCliModelName(config.claudeCliModel) : undefined;
  }
  if (entry.provider === "claude-code-cli" && "id" in entry && entry.id === CLAUDE_CLI_OPUS_5_ID) return CLAUDE_CLI_OPUS_5_MODEL;
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
    return `${modelId} (model ${config.claudeCliModel ? normalizeClaudeCliModelName(config.claudeCliModel) : "CLI default"})`;
  }
  if (modelId === CLAUDE_CLI_OPUS_5_ID) {
    return `${modelId} (model ${CLAUDE_CLI_OPUS_5_MODEL})`;
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
    const modelName = cleared ? undefined : normalizeClaudeCliModelName(normalized);
    return {
      patch: { claudeCliModel: modelName },
      message: cleared ? "Set Claude Code CLI model to CLI default." : `Set Claude Code CLI model to ${modelName}.`
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
