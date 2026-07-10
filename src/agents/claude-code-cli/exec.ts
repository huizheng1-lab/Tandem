import { execa } from "execa";
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
  systemPrompt: string;
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
  // D66-2: 429-shaped rate-limit envelopes include this structured field. The prose-side
  // substring check ("hit your limit") is the secondary signal.
  api_error_status?: number;
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
  systemPrompt: string;
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
    "--no-session-persistence",
    "--system-prompt",
    input.systemPrompt
  ];
  if (input.readOnly) args.push("--tools", "Read,Grep,Glob");
  if (input.modelName) args.push("--model", input.modelName);
  return args;
}

function formatPermissionDenials(denials: unknown[] | undefined): string {
  if (!denials || denials.length === 0) return "";
  return `Claude Code permission denials: ${jsonText(denials)}`;
}

// D66-2: dedicated error class for rate-limit outcomes so retryArtifact can fast-fail on
// attempt 1 instead of burning 2 more attempts that are guaranteed to fail identically
// until the reset time. The handoff's live evidence: a single 429 attempt cost $1.17 (36
// turns, 20535 output tokens) before hitting the limit; subsequent retries added no value.
export class RateLimitError extends Error {
  readonly resetsAt: string;
  constructor(message: string, resetsAt: string) {
    super(message);
    this.name = "RateLimitError";
    this.resetsAt = resetsAt;
  }
}

// Detects the 429-shaped envelope Claude returns when a rate limit is hit. Tests BOTH the
// structured field (api_error_status === 429) AND a substring match on the prose
// ("hit your limit") as a belt-and-suspenders check. Returns the resetsAt string
// (e.g. "11:50pm (America/New_York)") or "rate-limited" if no reset time is parseable.
function detectRateLimit(envelope: ClaudeEnvelope): string {
  if (envelope.api_error_status === 429) {
    const resultText = typeof envelope.result === "string" ? envelope.result : "";
    const m = /resets\s+([^\n.]+?)(?:\s*$|\.|\n)/.exec(resultText);
    return m ? m[1].trim() : "rate-limited";
  }
  if (typeof envelope.result === "string" && /hit your limit/i.test(envelope.result)) {
    const m = /resets\s+([^\n.]+?)(?:\s*$|\.|\n)/.exec(envelope.result);
    return m ? m[1].trim() : "rate-limited";
  }
  return "";
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

  // D66-2: detect 429-shaped envelope here too, so a rate-limit signal reaches the caller
  // even if exitCode is 0 (the 429-path observed in the live evidence exited non-zero, but
  // this is the belt-and-suspenders position for the same risk).
  const rateLimitReset = detectRateLimit(envelope);
  if (rateLimitReset) {
    throw new RateLimitError(
      `Claude Code CLI is rate-limited (resets ${rateLimitReset}). Try again after that time or switch engines.`,
      rateLimitReset
    );
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
    systemPrompt: options.systemPrompt,
    schema: jsonSchemaFor(options.schema),
    permissionMode: claudePermissionFor(options.permissionMode, options.readOnly),
    modelName: options.modelName || undefined,
    readOnly: options.readOnly
  });
  options.onToolEvent?.({ role: options.role, tool: "claude_code_cli", target: options.readOnly ? "read-only prompt" : "write prompt", phase: "start" });
  const started = Date.now();
  const result = await execa(claudePath, args, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    windowsHide: true,
    reject: false,
    cancelSignal: options.abortSignal
  });
  options.onToolEvent?.({
    role: options.role,
    tool: "claude_code_cli",
    target: options.readOnly ? "read-only prompt" : "write prompt",
    phase: "end",
    ok: result.exitCode === 0 && !options.abortSignal?.aborted,
    ms: Date.now() - started
  });
  if (options.abortSignal?.aborted) throw new Error("Claude Code CLI run aborted.");
  if (result.exitCode !== 0) {
    let denials = "";
    let rateLimitReset = "";
    try {
      const env = JSON.parse(result.stdout) as ClaudeEnvelope;
      denials = formatPermissionDenials(env.permission_denials);
      rateLimitReset = detectRateLimit(env);
    } catch {
      denials = "";
      rateLimitReset = "";
    }
    if (rateLimitReset) {
      // D66-2: throw a RateLimitError so retryArtifact fast-fails on attempt 1 instead of
      // burning 2 more attempts that are guaranteed to fail identically until the reset
      // time. The handoff's live evidence: a single 429 attempt cost $1.17 + 36 turns
      // before the second attempt hit the same 429.
      throw new RateLimitError(
        `Claude Code CLI is rate-limited (resets ${rateLimitReset}). Try again after that time or switch engines.`,
        rateLimitReset
      );
    }
    throw new Error(`Claude Code CLI exited with code ${result.exitCode}: ${[result.stderr.trim(), denials, result.stdout.trim()].filter(Boolean).join("\n")}`);
  }
  return parseClaudeEnvelope(result.stdout, options);
}
