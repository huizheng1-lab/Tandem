import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";

export interface LocateCodexOptions {
  overridePath?: string;
  env?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  exists?: (filePath: string) => boolean;
  stat?: (filePath: string) => { mtimeMs: number; isFile?: () => boolean };
  readdir?: (dirPath: string) => string[];
  platform?: NodeJS.Platform;
}

let cachedPath: string | undefined;
let cachedKey: string | undefined;

function canUse(filePath: string, exists: (value: string) => boolean): boolean {
  return exists(filePath);
}

function pathCandidates(env: NodeJS.ProcessEnv, pathSeparator: string): string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const names = process.platform === "win32" ? ["codex.exe", "codex"] : ["codex", "codex.exe"];
  return pathValue
    .split(pathSeparator)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function newestWindowsFallback(options: Required<Pick<LocateCodexOptions, "exists" | "stat" | "readdir">> & { env: NodeJS.ProcessEnv }): string | undefined {
  const localAppData = options.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!options.exists(binRoot)) return undefined;
  const candidates = options
    .readdir(binRoot)
    .map((entry) => path.join(binRoot, entry, "codex.exe"))
    .filter((candidate) => options.exists(candidate))
    .map((candidate) => ({ path: candidate, mtimeMs: options.stat(candidate).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path;
}

export function clearCodexCliPathCache(): void {
  cachedPath = undefined;
  cachedKey = undefined;
}

export function locateCodexCli(options: LocateCodexOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = options.overridePath || env.CODEX_CLI_PATH;
  const key = JSON.stringify({ override, path: env.PATH ?? env.Path ?? env.path, local: env.LOCALAPPDATA, platform: options.platform ?? process.platform });
  if (cachedKey === key) return cachedPath;

  const exists = options.exists ?? existsSync;
  const stat = options.stat ?? statSync;
  const readdir = options.readdir ?? readdirSync;
  const pathSeparator = options.pathSeparator ?? path.delimiter;
  const platform = options.platform ?? process.platform;

  if (override && canUse(override, exists)) {
    cachedKey = key;
    cachedPath = override;
    return cachedPath;
  }

  for (const candidate of pathCandidates(env, pathSeparator)) {
    if (canUse(candidate, exists)) {
      cachedKey = key;
      cachedPath = candidate;
      return cachedPath;
    }
  }

  const fallback = platform === "win32" ? newestWindowsFallback({ env, exists, stat, readdir }) : undefined;
  cachedKey = key;
  cachedPath = fallback;
  return cachedPath;
}

export async function codexCliVersion(codexPath: string): Promise<string> {
  const result = await execa(codexPath, ["--version"], { reject: false, windowsHide: true, stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `codex --version failed with exit code ${result.exitCode}`);
  return result.stdout.trim();
}
