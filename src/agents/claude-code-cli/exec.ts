import { spawn } from "node:child_process";
import { once } from "node:events";
import type { PermissionMode } from "../../config/schema.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger, CostRole } from "../../session/cost.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { assertSafeProjectDir } from "../../tools/protection.js";
import { locateClaudeCli } from "./locate.js";
import { jsonSchemaFor, stripNulls, type CodexSchemaKind } from "../codex-cli/schema-json.js";

export type ClaudeSchemaKind = CodexSchemaKind;
export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";

export interface ClaudeExecOptions {
  cwd: string;
  prompt: string;
  schema: ClaudeSchemaKind;
  permissionMode: PermissionMode;
  env?: NodeJS.ProcessEnv;
  claudeCliPath?: string;
  modelName?: string;
  abortSignal?: AbortSignal;
  role: CostRole;
  entry: ModelEntry;
  ledger: CostLedger;
  readOnly?: boolean;
  onText?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
}

interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: Record<string, unknown>;
  total_cost_usd?: unknown;
  permission_denials?: unknown[];
  error?: unknown;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function claudePermissionFor(permissionMode: PermissionMode, readOnly = false): ClaudePermissionMode {
  if (readOnly) return "plan";
  if (permissionMode === "yolo") return "bypassPermissions";
  if (permissionMode === "auto-edit") return "acceptEdits";
  return "bypassPermissions";
}

export function buildClaudeExecArgv(input: {
  prompt: string;
  schema: object;
  permissionMode: ClaudePermissionMode;
  modelName?: string;
  readOnly?: boolean;
}): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(input.schema),
    "--permission-mode",
    input.permissionMode,
    "--no-session-persistence"
  ];
  if (input.readOnly) args.push("--tools", "Read,Grep,Glob");
  if (input.modelName) args.push("--model", input.modelName);
  return args;
}

function formatPermissionDenials(denials: unknown[] | undefined): string {
  if (!denials || denials.length === 0) return "";
  return `Claude Code permission denials: ${jsonText(denials)}`;
}

export function parseClaudeEnvelope(stdout: string, options: Pick<ClaudeExecOptions, "role" | "ledger" | "entry" | "onText">): unknown {
  const envelope = JSON.parse(stdout) as ClaudeEnvelope;
  const usage = envelope.usage ?? {};
  const inputTokens = usageNumber(usage.input_tokens) + usageNumber(usage.cache_creation_input_tokens) + usageNumber(usage.cache_read_input_tokens);
  const outputTokens = usageNumber(usage.output_tokens);
  options.ledger.addDirectCost(options.role, usageNumber(envelope.total_cost_usd), inputTokens, outputTokens);

  if (typeof envelope.result === "string" && envelope.result.trim()) {
    options.onText?.(envelope.result);
  }

  const denials = formatPermissionDenials(envelope.permission_denials);
  if (denials) throw new Error(denials);
  if (envelope.is_error || envelope.subtype === "error") {
    throw new Error(`Claude Code CLI returned an error: ${[jsonText(envelope.error), envelope.result].filter(Boolean).join("\n")}`);
  }
  if (envelope.structured_output === undefined) throw new Error(`Claude Code CLI response did not include structured_output. Result: ${envelope.result ?? "(empty)"}`);
  return stripNulls(envelope.structured_output);
}

export async function runClaudeExec(options: ClaudeExecOptions): Promise<unknown> {
  assertSafeProjectDir(options.cwd);
  const claudePath = locateClaudeCli({ env: options.env, overridePath: options.claudeCliPath });
  if (!claudePath) throw new Error("Claude Code CLI not found. Install Claude Code or set CLAUDE_CLI_PATH / claudeCliPath.");
  const args = buildClaudeExecArgv({
    prompt: options.prompt,
    schema: jsonSchemaFor(options.schema),
    permissionMode: claudePermissionFor(options.permissionMode, options.readOnly),
    modelName: options.modelName || undefined,
    readOnly: options.readOnly
  });
  options.onToolEvent?.({ role: options.role, tool: "claude_code_cli", target: options.readOnly ? "read-only prompt" : "write prompt", phase: "start" });
  const started = Date.now();
  const child = spawn(claudePath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(claudePath)
  });
  let stdout = "";
  let stderr = "";
  const abort = () => child.kill("SIGTERM");
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  options.abortSignal?.removeEventListener("abort", abort);
  options.onToolEvent?.({
    role: options.role,
    tool: "claude_code_cli",
    target: options.readOnly ? "read-only prompt" : "write prompt",
    phase: "end",
    ok: code === 0 && !options.abortSignal?.aborted,
    ms: Date.now() - started
  });
  if (options.abortSignal?.aborted) throw new Error("Claude Code CLI run aborted.");
  if (code !== 0) {
    let denials = "";
    try {
      denials = formatPermissionDenials((JSON.parse(stdout) as ClaudeEnvelope).permission_denials);
    } catch {
      denials = "";
    }
    throw new Error(`Claude Code CLI exited with code ${code}: ${[stderr.trim(), denials, stdout.trim()].filter(Boolean).join("\n")}`);
  }
  return parseClaudeEnvelope(stdout, options);
}
