import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { resolveOnPath } from "../../tools/resolve-on-path.js";

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

export function clearClaudeCliPathCache(): void {
  cachedPath = undefined;
  cachedKey = undefined;
}

export function locateClaudeCli(options: LocateClaudeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = options.overridePath || env.CLAUDE_CLI_PATH;
  const platform = options.platform ?? process.platform;
  const key = JSON.stringify({ override, path: env.PATH ?? env.Path ?? env.path, platform });
  if (cachedKey === key) {
    const cachedExists = options.exists ?? existsSync;
    if (cachedPath === undefined || cachedExists(cachedPath)) return cachedPath;
    cachedKey = undefined;
    cachedPath = undefined;
  }

  const exists = options.exists ?? existsSync;
  const pathSeparator = options.pathSeparator ?? path.delimiter;

  if (override && canUse(override, exists)) {
    cachedKey = key;
    cachedPath = override;
    return cachedPath;
  }

  // D57-1: use the shared resolveOnPath helper. Claude's PATH lookup is the more elaborate
  // of the two CLIs - the local-install node_modules path is tried first so the user
  // doesn't need a global install.
  const names =
    platform === "win32"
      ? [path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "claude.exe", "claude", "claude.cmd"]
      : ["claude", "claude.cmd", "claude.exe"];
  const resolved = resolveOnPath({ token: "claude", names, env, pathSeparator, exists });
  if (resolved) {
    cachedKey = key;
    cachedPath = resolved;
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
