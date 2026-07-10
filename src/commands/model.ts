import { TandemConfig } from "../config/schema.js";
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
