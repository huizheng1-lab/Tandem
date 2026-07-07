import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";

export interface LocateClaudeOptions {
  overridePath?: string;
  env?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  exists?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
}

let cachedPath: string | undefined;
let cachedKey: string | undefined;

function canUse(filePath: string, exists: (value: string) => boolean): boolean {
  return exists(filePath);
}

function pathCandidates(env: NodeJS.ProcessEnv, pathSeparator: string, platform: NodeJS.Platform): string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const names = platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude", "claude.cmd", "claude.exe"];
  return pathValue
    .split(pathSeparator)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function clearClaudeCliPathCache(): void {
  cachedPath = undefined;
  cachedKey = undefined;
}

export function locateClaudeCli(options: LocateClaudeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = options.overridePath || env.CLAUDE_CLI_PATH;
  const platform = options.platform ?? process.platform;
  const key = JSON.stringify({ override, path: env.PATH ?? env.Path ?? env.path, platform });
  if (cachedKey === key) return cachedPath;

  const exists = options.exists ?? existsSync;
  const pathSeparator = options.pathSeparator ?? path.delimiter;

  for (const candidate of pathCandidates(env, pathSeparator, platform)) {
    if (canUse(candidate, exists)) {
      cachedKey = key;
      cachedPath = candidate;
      return cachedPath;
    }
  }

  if (override && canUse(override, exists)) {
    cachedKey = key;
    cachedPath = override;
    return cachedPath;
  }

  cachedKey = key;
  cachedPath = undefined;
  return cachedPath;
}

export async function claudeCliVersion(claudePath: string): Promise<string> {
  const result = await execa(claudePath, ["--version"], { reject: false, windowsHide: true, stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `claude --version failed with exit code ${result.exitCode}`);
  return result.stdout.trim();
}
