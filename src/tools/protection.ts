import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PROTECTION_MESSAGE = "Tandem will not modify its own installation. Pick a different project folder.";

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(candidate: string, root: string): boolean {
  const value = normalizePath(candidate);
  const base = normalizePath(root);
  return value === base || value.startsWith(`${base}${path.sep}`);
}

function overlaps(candidate: string, root: string): boolean {
  return isSameOrInside(candidate, root) || isSameOrInside(root, candidate);
}

function findSourceRoot(start: string): string | undefined {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "src", "orchestrator", "machine.ts"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function envProtectedRoots(): string[] {
  return (process.env.TANDEM_PROTECTED_ROOTS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function safeDefaultProjectDir(homeDir = homedir()): string {
  return path.join(homeDir, "TandemProjects");
}

export function protectedRoots(homeDir = homedir()): string[] {
  const moduleRoot = findSourceRoot(path.dirname(fileURLToPath(import.meta.url)));
  const cwdRoot = findSourceRoot(process.cwd());
  return [...envProtectedRoots(), moduleRoot, cwdRoot, path.join(homeDir, ".tandem")]
    .filter((item): item is string => Boolean(item))
    .map((item) => path.resolve(item));
}

export function isProtectedPath(filePath: string, homeDir = homedir()): boolean {
  return protectedRoots(homeDir).some((root) => isSameOrInside(filePath, root));
}

export function isProtectedProjectDir(projectDir: string, homeDir = homedir()): boolean {
  return protectedRoots(homeDir).some((root) => overlaps(projectDir, root));
}

export function assertSafeProjectDir(projectDir: string): void {
  if (isProtectedProjectDir(projectDir)) throw new Error(SELF_PROTECTION_MESSAGE);
}

export function assertSafeWritePath(projectDir: string, targetPath: string): void {
  assertSafeProjectDir(projectDir);
  if (isProtectedPath(targetPath)) throw new Error(SELF_PROTECTION_MESSAGE);
}

export function assertSafeBash(projectDir: string, command: string): void {
  assertSafeProjectDir(projectDir);
  if (/(^|[\s"'`])(?:~[/\\]\.tandem|\$HOME[/\\]\.tandem|%USERPROFILE%[/\\]\.tandem)(?=$|[\s"'`/\\])/i.test(command)) {
    throw new Error(SELF_PROTECTION_MESSAGE);
  }
}

