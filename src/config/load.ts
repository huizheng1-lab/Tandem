import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { tandemStateDir } from "../paths.js";
import { readJsonFileSync } from "../json.js";
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

export function globalConfigPath(homeDir?: string): string {
  return path.join(tandemStateDir(homeDir), "config.json");
}

function globalStateDirFor(homeDir: string | undefined, env: NodeJS.ProcessEnv | undefined): string {
  if (homeDir) return tandemStateDir(homeDir);
  const envHome = env?.TANDEM_HOME?.trim();
  return envHome ? path.resolve(envHome) : tandemStateDir();
}

function readJsonIfPresent(filePath: string): unknown {
  if (!existsSync(filePath)) return {};
  try {
    return readJsonFileSync(filePath);
  } catch (error) {
    throw new ConfigError(`Could not parse ${filePath}. Fix the JSON and try again. ${String(error)}`);
  }
}

function readObjectIfPresent(filePath: string): Record<string, unknown> {
  const value = readJsonIfPresent(filePath);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mergeConfig(...parts: unknown[]): TandemConfig {
  const merged = Object.assign({}, ...parts);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid Tandem config. Update .tandem/config.json: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parsePartialConfig(value: unknown, filePath: string): Partial<TandemConfig> {
  const parsed = ConfigSchema.partial().safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`Invalid Tandem config. Update ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function loadEnv(cwd = process.cwd(), homeDir: string | undefined = undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const projectEnv = path.join(cwd, ".env");
  const globalEnv = path.join(globalStateDirFor(homeDir, env), ".env");
  if (existsSync(globalEnv)) dotenv.config({ path: globalEnv, processEnv: env, override: false, quiet: true });
  if (existsSync(projectEnv)) dotenv.config({ path: projectEnv, processEnv: env, override: true, quiet: true });
  return env;
}

export function loadConfig(options: LoadConfigOptions = {}): TandemConfig {
  return loadConfigDetails(options).config;
}

export function loadConfigDetails(options: LoadConfigOptions = {}): { config: TandemConfig; globalConfig: TandemConfig; projectConfig: Partial<TandemConfig>; projectOverrides: Array<keyof TandemConfig> } {
  const cwd = options.cwd ?? process.cwd();
  const globalPath = path.join(globalStateDirFor(options.homeDir, options.env), "config.json");
  const projectPath = projectConfigPath(cwd);
  const globalRaw = readObjectIfPresent(globalPath);
  const projectConfig = parsePartialConfig(readObjectIfPresent(projectPath), projectPath);
  const globalConfig = mergeConfig(defaultConfig, globalRaw);
  const config = mergeConfig(globalConfig, projectConfig, options.flags ?? {});
  const projectOverrides = Object.keys(projectConfig).filter((key) => {
    const typedKey = key as keyof TandemConfig;
    return JSON.stringify(projectConfig[typedKey]) !== JSON.stringify(globalConfig[typedKey]);
  }) as Array<keyof TandemConfig>;
  return { config, globalConfig, projectConfig, projectOverrides };
}

export async function saveProjectConfig(config: TandemConfig, cwd = process.cwd()): Promise<void> {
  const filePath = projectConfigPath(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveGlobalConfigPatch(patch: Partial<TandemConfig>, homeDir?: string): Promise<void> {
  const filePath = globalConfigPath(homeDir);
  const existing = readObjectIfPresent(filePath);
  const parsed = parsePartialConfig({ ...existing, ...patch }, filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}
