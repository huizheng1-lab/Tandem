import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { InstallEvidence } from "./types.js";
import { ensurePermission, type PermissionBridge } from "../tools/permissions.js";
import { assertSafeBash, assertSafeProjectDir } from "../tools/protection.js";
import type { PermissionMode, PermissionRules } from "../config/schema.js";
import { resolveOnPath } from "../tools/resolve-on-path.js";

const TOOL_PACKAGE_MAP: Record<string, { packageManager: "npm" | "pip"; packageName: string }> = {
  whisper: { packageManager: "pip", packageName: "openai-whisper" }
};

export interface InstallOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionMode: PermissionMode;
  permissionBridge?: PermissionBridge;
  rules?: PermissionRules;
  unattended?: boolean;
  record?: (evidence: InstallEvidence) => void;
}

/** Installs only an explicitly requested executable, using user/project scope. */
export async function installMissingTool(options: InstallOptions): Promise<InstallEvidence> {
  const executable = options.executable.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(executable)) throw new Error(`Refusing ambiguous tool package name '${executable}'.`);
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32"
    ? [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
    : [executable];
  const existing = resolveOnPath({ token: executable, names, env: options.env, pathSeparator });
  if (existing) {
    return {
      executable,
      packageManager: "none",
      source: "PATH",
      command: "",
      requestedBy: executable,
      status: "skipped",
      detail: `Already available at ${existing}; installation was not attempted.`
    };
  }
  const mapping = TOOL_PACKAGE_MAP[executable.toLowerCase()];
  if (!mapping) throw new Error(`No explicit package mapping exists for '${executable}'; installation was refused.`);
  // Check the project before creating even the project-local staging directory.
  // This keeps the installer subject to the same self-modification boundary as
  // the eventual shell command.
  assertSafeProjectDir(options.cwd);
  const npm = mapping.packageManager === "npm";
  const packageManager = mapping.packageManager;
  const source = npm ? "npm registry" : "Python package index (pip)";
  const installRoot = path.join(options.cwd, ".tandem", "tools");
  await mkdir(installRoot, { recursive: true });
  const command = npm
    ? `npm install --no-save --prefix "${installRoot}" ${executable}`
    : `python -m pip install --user ${mapping.packageName}`;
  const base: InstallEvidence = { executable, packageManager, source, command, requestedBy: executable, status: "started" };
  options.record?.(base);
  try {
    assertSafeBash(options.cwd, command);
    await ensurePermission(options.permissionMode, { action: "bash", target: command }, options.permissionBridge, { rules: options.rules, unattended: options.unattended });
    const result = await execa(command, { cwd: options.cwd, env: options.env, shell: true, reject: false, windowsHide: true });
    const evidence: InstallEvidence = { ...base, status: result.exitCode === 0 ? "completed" : "failed", detail: `${result.stdout}\n${result.stderr}`.trim() };
    options.record?.(evidence);
    return evidence;
  } catch (error) {
    const evidence: InstallEvidence = { ...base, status: "blocked", detail: String(error) };
    options.record?.(evidence);
    throw error;
  }
}
