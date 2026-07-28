import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  logger?: (message: string) => void;
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

const retiredDefaultMigrations = [
  {
    field: "maxStepsPerAgentTurn",
    from: 60,
    to: defaultConfig.maxStepsPerAgentTurn,
    reason: "D102 raised the shipped default agent step budget"
  },
  {
    field: "maxParallelWorkers",
    from: 1,
    to: defaultConfig.maxParallelWorkers,
    reason: "D63 raised the shipped default parallel worker count"
  }
] as const satisfies ReadonlyArray<{
  field: keyof TandemConfig;
  from: unknown;
  to: unknown;
  reason: string;
}>;

function migrateRetiredDefaults(raw: Record<string, unknown>, filePath: string, logger: ((message: string) => void) | undefined): Record<string, unknown> {
  if (!existsSync(filePath)) return raw;
  let migrated: Record<string, unknown> | undefined;
  const changes: string[] = [];

  for (const migration of retiredDefaultMigrations) {
    if (raw[migration.field] === migration.from && migration.from !== migration.to) {
      migrated ??= { ...raw };
      migrated[migration.field] = migration.to;
      changes.push(`${String(migration.field)} ${String(migration.from)} -> ${String(migration.to)} (${migration.reason})`);
    }
  }

  if (!migrated) return raw;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
  const message = `Migrated stale Tandem config defaults in ${filePath}: ${changes.join("; ")}. Exact retired default values are treated as stale shipped defaults.`;
  (logger ?? console.warn)(message);
  return migrated;
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
  const globalRaw = migrateRetiredDefaults(readObjectIfPresent(globalPath), globalPath, options.logger);
  const projectConfig = parsePartialConfig(migrateRetiredDefaults(readObjectIfPresent(projectPath), projectPath, options.logger), projectPath);
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
