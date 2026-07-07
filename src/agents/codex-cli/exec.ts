import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { PermissionMode } from "../../config/schema.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger, CostRole } from "../../session/cost.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { locateCodexCli } from "./locate.js";
import { withCodexSchemaFiles, type CodexSchemaKind } from "./schema-json.js";

export interface CodexExecOptions {
  cwd: string;
  prompt: string;
  schema: CodexSchemaKind;
  permissionMode: PermissionMode;
  env?: NodeJS.ProcessEnv;
  codexCliPath?: string;
  modelName?: string;
  abortSignal?: AbortSignal;
  role: CostRole;
  entry: ModelEntry;
  ledger: CostLedger;
  onText?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
}

interface CodexJsonDiagnostics {
  errors: string[];
}

export function codexSandboxFor(permissionMode: PermissionMode, forceReadOnly = false): "read-only" | "workspace-write" {
  if (forceReadOnly) return "read-only";
  return permissionMode === "ask" ? "workspace-write" : "workspace-write";
}

export function buildCodexExecArgv(input: {
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  schemaPath: string;
  outputPath: string;
  prompt: string;
  modelName?: string;
}): string[] {
  const args = [
    "exec",
    "-C",
    input.cwd,
    "-s",
    input.sandbox,
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath
  ];
  if (input.modelName) args.push("-m", input.modelName);
  args.push(input.prompt);
  return args;
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

export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    result[key] = stripNulls(item);
  }
  return result;
}

export function handleCodexJsonLine(line: string, options: Pick<CodexExecOptions, "role" | "entry" | "ledger" | "onText" | "onToolEvent">, active = new Map<string, number>(), diagnostics?: CodexJsonDiagnostics): void {
  if (!line.trim()) return;
  const event = JSON.parse(line) as {
    type?: string;
    item?: { id?: string; type?: string; command?: string; text?: string; status?: string; exit_code?: number | null };
    usage?: Record<string, unknown>;
    message?: unknown;
    error?: unknown;
  };
  if (event.type === "error") {
    diagnostics?.errors.push(jsonText(event.message ?? event.error ?? event));
    return;
  }
  if (event.type === "turn.failed") {
    diagnostics?.errors.push(jsonText(event.error ?? event.message ?? event));
    return;
  }
  if (event.type === "item.started" && event.item) {
    const id = event.item.id ?? `${event.item.type ?? "item"}:${active.size}`;
    active.set(id, Date.now());
    options.onToolEvent?.({
      role: options.role,
      tool: event.item.type ?? "codex_item",
      target: event.item.command ?? event.item.text ?? id,
      phase: "start"
    });
    return;
  }
  if (event.type === "item.completed" && event.item) {
    if (event.item.type === "agent_message" && event.item.text) {
      options.onText?.(event.item.text);
      return;
    }
    const id = event.item.id ?? `${event.item.type ?? "item"}:${active.size}`;
    const started = active.get(id);
    active.delete(id);
    options.onToolEvent?.({
      role: options.role,
      tool: event.item.type ?? "codex_item",
      target: event.item.command ?? event.item.text ?? id,
      phase: "end",
      ok: event.item.exit_code === undefined || event.item.exit_code === null || event.item.exit_code === 0,
      ms: started ? Date.now() - started : undefined
    });
    return;
  }
  if (event.type === "turn.completed" && event.usage) {
    const input = usageNumber(event.usage.input_tokens);
    const output = usageNumber(event.usage.output_tokens) + usageNumber(event.usage.reasoning_output_tokens);
    options.ledger.add(options.role, options.entry, input, output);
  }
}

export async function runCodexExec(options: CodexExecOptions & { readOnly?: boolean }): Promise<unknown> {
  const codexPath = locateCodexCli({ env: options.env, overridePath: options.codexCliPath });
  if (!codexPath) throw new Error("Codex CLI not found. Install Codex CLI or set CODEX_CLI_PATH / codexCliPath.");
  return withCodexSchemaFiles(options.schema, async ({ schemaPath, outputPath }) => {
    const args = buildCodexExecArgv({
      cwd: options.cwd,
      sandbox: codexSandboxFor(options.permissionMode, options.readOnly),
      schemaPath,
      outputPath,
      prompt: options.prompt,
      modelName: options.modelName || undefined
    });
    const child = spawn(codexPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(codexPath)
    });
    const active = new Map<string, number>();
    const diagnostics: CodexJsonDiagnostics = { errors: [] };
    let stdoutBuffer = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleCodexJsonLine(line, options, active, diagnostics);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = (await once(child, "close")) as [number | null];
    options.abortSignal?.removeEventListener("abort", abort);
    if (stdoutBuffer.trim()) handleCodexJsonLine(stdoutBuffer, options, active, diagnostics);
    if (options.abortSignal?.aborted) throw new Error("Codex CLI run aborted.");
    const diagnosticText = diagnostics.errors.length > 0 ? ` Codex JSON error: ${diagnostics.errors.join("\n")}` : "";
    if (code !== 0) throw new Error(`Codex CLI exited with code ${code}: ${[stderr.trim(), diagnosticText.trim()].filter(Boolean).join("\n")}`);
    return stripNulls(JSON.parse(await readFile(outputPath, "utf8")));
  });
}
