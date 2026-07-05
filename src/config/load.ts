import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { ConfigFlags, ConfigSchema, TandemConfig, defaultConfig } from "./schema.js";

export class ConfigError extends Error {}

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
  flags?: ConfigFlags;
  env?: NodeJS.ProcessEnv;
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".tandem", "config.json");
}

export function globalConfigPath(homeDir = homedir()): string {
  return path.join(homeDir, ".tandem", "config.json");
}

function readJsonIfPresent(filePath: string): unknown {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(`Could not parse ${filePath}. Fix the JSON and try again. ${String(error)}`);
  }
}

function mergeConfig(...parts: unknown[]): TandemConfig {
  const merged = Object.assign({}, ...parts);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid Tandem config. Update .tandem/config.json: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function loadEnv(cwd = process.cwd(), homeDir = homedir(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const projectEnv = path.join(cwd, ".env");
  const globalEnv = path.join(homeDir, ".tandem", ".env");
  if (existsSync(globalEnv)) dotenv.config({ path: globalEnv, processEnv: env, override: false });
  if (existsSync(projectEnv)) dotenv.config({ path: projectEnv, processEnv: env, override: true });
  return env;
}

export function loadConfig(options: LoadConfigOptions = {}): TandemConfig {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const globalConfig = readJsonIfPresent(globalConfigPath(home));
  const projectConfig = readJsonIfPresent(projectConfigPath(cwd));
  return mergeConfig(defaultConfig, globalConfig, projectConfig, options.flags ?? {});
}

export async function saveProjectConfig(config: TandemConfig, cwd = process.cwd()): Promise<void> {
  const filePath = projectConfigPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
