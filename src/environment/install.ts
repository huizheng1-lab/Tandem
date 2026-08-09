import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { InstallEvidence } from "./types.js";
import { ensurePermission, type PermissionBridge } from "../tools/permissions.js";
import { assertSafeBash, assertSafeProjectDir } from "../tools/protection.js";
import type { PermissionMode, PermissionRules } from "../config/schema.js";

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
  // Check the project before creating even the project-local staging directory.
  // This keeps the installer subject to the same self-modification boundary as
  // the eventual shell command.
  assertSafeProjectDir(options.cwd);
  const npm = /^(npm|npx|node)$/i.test(executable);
  const packageManager = npm ? "npm" : "pip";
  const source = npm ? "npm registry" : "Python package index (pip)";
  const installRoot = path.join(options.cwd, ".tandem", "tools");
  await mkdir(installRoot, { recursive: true });
  const command = npm
    ? `npm install --no-save --prefix "${installRoot}" ${executable}`
    : `python -m pip install --user ${executable}`;
  const base: InstallEvidence = { executable, packageManager, source, command, requestedBy: executable, status: "started" };
  options.record?.(base);
  try {
    assertSafeBash(options.cwd, command);
    await ensurePermission(options.permissionMode, { action: "bash", target: command }, options.permissionBridge, { rules: options.rules, unattended: options.unattended });
    const result = await execa(command, { cwd: options.cwd, env: options.env, shell: true, reject: false, windowsHide: true });
    const evidence: InstallEvidence = { ...base, status: result.exitCode === 0 ? "completed" : "failed", detail: `${result.stdout}\n${result.stderr}`.trim() };
    options.record?.(evidence);
    if (result.exitCode !== 0) throw new Error(`Could not install ${executable} with ${packageManager}: ${evidence.detail}`);
    return evidence;
  } catch (error) {
    const evidence: InstallEvidence = { ...base, status: "blocked", detail: String(error) };
    options.record?.(evidence);
    throw error;
  }
}
