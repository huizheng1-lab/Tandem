import { TandemConfig } from "../config/schema.js";
import { saveProjectConfig } from "../config/load.js";
import { modelRegistry, resolveModel } from "../providers/registry.js";

export function listModels(config: TandemConfig, env: NodeJS.ProcessEnv): string {
  return modelRegistry(config.customModels)
    .map((model) => `${env[model.envKey] ? "ok " : "key"} ${model.id} (${model.envKey})`)
    .join("\n");
}

export async function setModel(config: TandemConfig, role: "leader" | "worker", id: string, cwd = process.cwd()): Promise<TandemConfig> {
  resolveModel(id, config.customModels);
  const next = { ...config, [role]: id };
  await saveProjectConfig(next, cwd);
  return next;
}
