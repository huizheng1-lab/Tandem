import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { resolveOnPath } from "../../tools/resolve-on-path.js";

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

function isWindowsAppsPayload(filePath: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const normalized = path.win32.normalize(filePath).toLowerCase();
  return normalized.includes("\\program files\\windowsapps\\");
}

function canUse(filePath: string, exists: (value: string) => boolean, platform: NodeJS.Platform): boolean {
  return exists(filePath) && !isWindowsAppsPayload(filePath, platform);
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
  const platform = options.platform ?? process.platform;
  const key = JSON.stringify({ override, path: env.PATH ?? env.Path ?? env.path, local: env.LOCALAPPDATA, platform });
  if (cachedKey === key) {
    const cachedExists = options.exists ?? existsSync;
    if (cachedPath === undefined || canUse(cachedPath, cachedExists, platform)) return cachedPath;
    cachedKey = undefined;
    cachedPath = undefined;
  }

  const exists = options.exists ?? existsSync;
  const stat = options.stat ?? statSync;
  const readdir = options.readdir ?? readdirSync;
  const pathSeparator = options.pathSeparator ?? path.delimiter;

  if (override && canUse(override, exists, platform)) {
    cachedKey = key;
    cachedPath = override;
    return cachedPath;
  }

  // D57-1: use the shared resolveOnPath helper instead of the inline pathCandidates loop.
  const names = platform === "win32" ? ["codex.exe", "codex"] : ["codex", "codex.exe"];
  const resolved = resolveOnPath({
    token: "codex",
    names,
    env,
    pathSeparator,
    exists: (candidate) => canUse(candidate, exists, platform)
  });
  if (resolved) {
    cachedKey = key;
    cachedPath = resolved;
    return cachedPath;
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
