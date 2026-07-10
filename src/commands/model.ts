import { CodexCliReasoningEffortSchema, TandemConfig } from "../config/schema.js";
import { saveProjectConfig } from "../config/load.js";
import { modelRegistry, resolveModel } from "../providers/registry.js";
import { modelDisplayName } from "../providers/cli-models.js";
import type { ModelEntry } from "../providers/registry.js";
import { locateCodexCli } from "../agents/codex-cli/locate.js";
import { locateClaudeCli } from "../agents/claude-code-cli/locate.js";

function mediaBadge(model: Pick<ModelEntry, "media">): string {
  const values = [model.media?.images ? "img" : "", model.media?.pdf ? "pdf" : ""].filter(Boolean);
  return values.length > 0 ? ` [${values.join("+")}]` : "";
}

export function listModels(config: TandemConfig, env: NodeJS.ProcessEnv): string {
  return modelRegistry(config.customModels)
    .map((model) => {
      if (model.provider === "codex-cli") {
        return `${locateCodexCli({ env, overridePath: config.codexCliPath }) ? "ok " : "key"} ${modelDisplayName(model.id, config)} (Codex CLI)`;
      }
      if (model.provider === "claude-code-cli") {
        return `${locateClaudeCli({ env, overridePath: config.claudeCliPath }) ? "ok " : "key"} ${modelDisplayName(model.id, config)} (Claude Code CLI)${mediaBadge(model)}`;
      }
      return `${model.envKey && env[model.envKey] ? "ok " : "key"} ${model.id}${mediaBadge(model)} (${model.envKey})`;
    })
    .join("\n");
}

export async function setModel(config: TandemConfig, role: "leader" | "worker", id: string, cwd = process.cwd()): Promise<TandemConfig> {
  resolveModel(id, config.customModels);
  const next = { ...config, [role]: id };
  await saveProjectConfig(next, cwd);
  return next;
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

export async function setCliModelConfig(config: TandemConfig, target: string | undefined, value: string | undefined, cwd = process.cwd()): Promise<{ config?: TandemConfig; message: string }> {
  const result = cliModelPatch(target, value);
  if (result.usage) return { message: result.usage };
  const next = { ...config, ...result.patch };
  await saveProjectConfig(next, cwd);
  return { config: next, message: result.message ?? "Updated CLI model config." };
}
