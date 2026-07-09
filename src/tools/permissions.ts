import { PermissionMode } from "../config/schema.js";

export type PermissionAction = "write" | "edit" | "bash";

export interface PermissionRequest {
  action: PermissionAction;
  target: string;
}

export interface PermissionBridge {
  approve(request: PermissionRequest): Promise<boolean>;
}

export class PermissionDeniedError extends Error {}

const destructivePatterns = [
  /\brm\s+-rf\s+[/~]/i,
  // Disk-format gate. The bare-word `\bformat\b` was over-eager (matched the very common
  // ffprobe/ffmpeg idiom `-show_entries format=duration`). Narrowed to require `format` followed
  // by whitespace and a drive-letter-shaped argument, with optional Windows switches in between
  // (e.g. `format C:`, `format c:`, `format /FS:NTFS C:`, `format C: /FS:exFAT /Q`).
  /\bformat\s+(?:\/[a-z]+(?::[a-z]+)?\s+)*[a-z]:/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
  /\bdel\s+\/[fsq]\s+[a-z]:\\/i
];

export function isDestructiveCommand(command: string): boolean {
  return destructivePatterns.some((pattern) => pattern.test(command));
}

export async function ensurePermission(
  mode: PermissionMode,
  request: PermissionRequest,
  bridge?: PermissionBridge
): Promise<void> {
  if (request.action === "bash" && isDestructiveCommand(request.target)) {
    throw new PermissionDeniedError(`Blocked destructive command. Change the command and try again: ${request.target}`);
  }
  if (mode === "yolo") return;
  if (mode === "auto-edit" && request.action !== "bash") return;
  if (!bridge) throw new PermissionDeniedError(`Permission required for ${request.action} ${request.target}. Retry with an approval bridge or yolo mode.`);
  const approved = await bridge.approve(request);
  if (!approved) throw new PermissionDeniedError(`Permission denied for ${request.action} ${request.target}.`);
}
