import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PermissionBridge, ensurePermission } from "./permissions.js";
import { PermissionMode } from "../config/schema.js";
import { assertSafeWritePath } from "./protection.js";

export interface ToolContext {
  cwd: string;
  permissionMode: PermissionMode;
  permissionBridge?: PermissionBridge;
  recordTouchedPath?: (filePath: string) => void;
}

export function resolveInside(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${target}. Choose a path inside ${cwd}.`);
  }
  return resolved;
}

export async function readFileTool(ctx: Pick<ToolContext, "cwd">, filePath: string, offset = 0, limit = 2000): Promise<string> {
  const fullPath = resolveInside(ctx.cwd, filePath);
  const content = await readFile(fullPath, "utf8");
  const lines = content.split(/\r?\n/);
  return lines
    .slice(offset, offset + limit)
    .map((line, index) => `${offset + index + 1}: ${line}`)
    .join("\n");
}

export async function writeFileTool(ctx: ToolContext, filePath: string, content: string): Promise<string> {
  const fullPath = resolveInside(ctx.cwd, filePath);
  assertSafeWritePath(ctx.cwd, fullPath);
  await ensurePermission(ctx.permissionMode, { action: "write", target: filePath }, ctx.permissionBridge);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  ctx.recordTouchedPath?.(filePath);
  return `Wrote ${filePath}`;
}

export async function editFileTool(ctx: ToolContext, filePath: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
  const fullPath = resolveInside(ctx.cwd, filePath);
  assertSafeWritePath(ctx.cwd, fullPath);
  await ensurePermission(ctx.permissionMode, { action: "edit", target: filePath }, ctx.permissionBridge);
  const content = await readFile(fullPath, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`Could not find exact text in ${filePath}.`);
  if (!replaceAll && occurrences > 1) throw new Error(`Text is not unique in ${filePath}; set replaceAll to true or narrow old_string.`);
  const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  await writeFile(fullPath, updated, "utf8");
  ctx.recordTouchedPath?.(filePath);
  return `Edited ${filePath}`;
}

export async function listDirTool(ctx: Pick<ToolContext, "cwd">, dirPath = "."): Promise<string> {
  const fullPath = resolveInside(ctx.cwd, dirPath);
  const entries = await readdir(fullPath);
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const entryStat = await stat(path.join(fullPath, entry));
      return `${entryStat.isDirectory() ? "dir " : "file"} ${entry}`;
    })
  );
  return rows.join("\n");
}
