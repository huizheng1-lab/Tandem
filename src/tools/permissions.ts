import { PermissionMode, PermissionRules } from "../config/schema.js";

export type PermissionAction = "write" | "edit" | "bash";

export interface PermissionRequest {
  action: PermissionAction;
  target: string;
}

export const DEFAULT_DENY_RULES = [
  "Bash(rm -rf /*)", "Bash(format *:*)", "Bash(:(){ :|:& };:)", "Bash(del /f *:\\*)",
  "Bash(uninstall *)", "Bash(downgrade *)", "Bash(setx PATH *)", "Bash(*security software*)",
  "Bash(* install http://*)", "Bash(* install https://*)"
] as const;

export interface PermissionOptions { rules?: PermissionRules; unattended?: boolean }

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
  /\bdel\s+\/[fsq]\s+[a-z]:\\/i,
  // Package removal/downgrades and persistent PATH/security changes are
  // machine-wide side effects that yolo must not bypass.
  /\b(?:npm|pip|python(?:3)?\s+-m\s+pip)\s+(?:uninstall|remove|downgrade)\b/i,
  /\b(?:setx|export)\s+PATH\b/i,
  /\b(?:disable|turn\s+off)\b.*\b(?:defender|antivirus|security\s+software)\b/i,
  /\b(?:npm|pip|python(?:3)?\s+-m\s+pip)\s+install\s+https?:\/\//i
];

export function isDestructiveCommand(command: string): boolean {
  return destructivePatterns.some((pattern) => pattern.test(command));
}

function ruleMatches(rule: string, request: PermissionRequest): boolean {
  const match = /^(Bash|Read|Write|Edit|WebFetch)\((.*)\)$/i.exec(rule.trim());
  if (!match) return false;
  if (match[1].toLowerCase() !== request.action && !(request.action === "write" && match[1].toLowerCase() === "write") && !(request.action === "edit" && match[1].toLowerCase() === "edit")) return false;
  const escaped = match[2].replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(request.target);
}

export async function ensurePermission(
  mode: PermissionMode,
  request: PermissionRequest,
  bridge?: PermissionBridge,
  options: PermissionOptions = {}
): Promise<void> {
  const rules = options.rules;
  const denyRules = [...DEFAULT_DENY_RULES, ...(rules?.deny ?? [])];
  if (request.action === "bash" && (isDestructiveCommand(request.target) || denyRules.some((rule) => ruleMatches(rule, request)))) {
    throw new PermissionDeniedError(`Blocked destructive command. Change the command and try again: ${request.target}`);
  }
  if (rules?.allow.some((rule) => ruleMatches(rule, request))) return;
  if (rules?.ask.some((rule) => ruleMatches(rule, request)) && options.unattended && rules.unattendedAsk === "deny") {
    throw new PermissionDeniedError(`Unattended ask rule denied ${request.action} ${request.target}.`);
  }
  if (mode === "yolo") return;
  if (mode === "auto-edit" && request.action !== "bash") return;
  if (!bridge) throw new PermissionDeniedError(`Permission required for ${request.action} ${request.target}. Retry with an approval bridge or yolo mode.`);
  const approved = await bridge.approve(request);
  if (!approved) throw new PermissionDeniedError(`Permission denied for ${request.action} ${request.target}.`);
}
