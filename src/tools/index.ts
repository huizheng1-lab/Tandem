import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { editFileTool, listDirTool, readFileTool, ToolActivityRole, ToolContext, writeFileTool } from "./fs.js";
import { searchFilesTool, MAX_SEARCH_RESULTS, MAX_SEARCH_RUNTIME_MS } from "./search.js";
import { backgroundProcessTool, bashTool } from "./shell.js";
import { DURABLE_AWAIT_DESCRIPTION } from "../orchestrator/await.js";
import { sanitizePromptText } from "./sanitize.js";
import { SecurityBoundaryError, securityRiskFor } from "./security.js";

export type ToolRole = "leader-readonly" | "worker" | "reviewer" | "takeover";

function activityRole(role: ToolRole): ToolActivityRole {
  return role === "worker" ? "worker" : "leader";
}

function memoryTools(ctx: ToolContext, role: ToolRole): ToolSet {
  if (!ctx.rememberNote) return {};
  return {
    remember: tool({
      description: "Save a short fact, constraint, or decision that future turns and the other agent should know.",
      inputSchema: z.object({ text: z.string() }),
      execute: wrapExecute(ctx, role, "remember", ({ text }) => text.slice(0, 80), async ({ text }) => {
        if (text.replace(/\s+/g, " ").trim().length > 300) {
          throw new Error("Memory note is too long. Save one short fact, constraint, or decision in 300 characters or fewer.");
        }
        return ctx.rememberNote?.(text, activityRole(role)) ?? "Memory is not available.";
      })
    })
  };
}

function wrapExecute<Input, Output>(ctx: ToolContext, role: ToolRole, toolName: string, target: (input: Input) => string, execute: (input: Input) => Promise<Output>): (input: Input) => Promise<Output> {
  return async (input) => {
    const started = Date.now();
    const eventBase = { role: activityRole(role), tool: toolName, target: target(input) };
    const securityRisk = securityRiskFor(toolName, eventBase.target);
    if (securityRisk) ctx.recordSecurityRisk?.(securityRisk);
    ctx.onToolEvent?.({ ...eventBase, phase: "start" });
    try {
      const result = await execute(input);
      const output = result && typeof result === "object" && "output" in result && typeof result.output === "string"
        ? result.output
        : undefined;
      ctx.onToolEvent?.({ ...eventBase, phase: "end", ok: true, ms: Date.now() - started, output, securityRisk });
      return result;
    } catch (error) {
      const errorText = String(error);
      // Keep the bounded failure detail in the event payload as well as the
      // display-oriented error field. Session records otherwise lose the
      // command's stderr when a bridge rejects a background start.
      const blockedSecurityAction = error instanceof SecurityBoundaryError ? error.report : undefined;
      ctx.onToolEvent?.({ ...eventBase, phase: "end", ok: false, ms: Date.now() - started, error: errorText, output: sanitizePromptText(errorText).slice(-2000), blockedSecurityAction });
      throw error;
    }
  };
}

export function makeToolSet(ctx: ToolContext, role: ToolRole, allowedBashCommands: string[] = []) {
  const readonlyTools = {
    read_file: tool({
      description: "Read a file with line numbers.",
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().positive().optional() }),
      execute: wrapExecute(ctx, role, "read_file", ({ path }) => path, ({ path, offset, limit }) => readFileTool(ctx, path, offset, limit))
    }),
    list_dir: tool({
      description: "List a directory.",
      inputSchema: z.object({ path: z.string().optional() }),
      execute: wrapExecute(ctx, role, "list_dir", ({ path }) => path ?? ".", ({ path }) => listDirTool(ctx, path ?? "."))
    }),
    glob: tool({
      description: "Find files by one or more glob patterns. Returns an explicit no-match result and the roots actually searched.",
      inputSchema: z.object({ root: z.string().optional(), pattern: z.string().optional(), patterns: z.array(z.string()).min(1).max(32).optional(), maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(), timeoutMs: z.number().int().positive().max(MAX_SEARCH_RUNTIME_MS).optional() }),
      execute: wrapExecute(ctx, role, "glob", ({ root, pattern, patterns }) => `${root ?? ctx.cwd}:${(patterns ?? (pattern ? [pattern] : [])).join(",")}`, ({ root, pattern, patterns, maxResults, timeoutMs }) => {
        const selected = patterns ?? (pattern ? [pattern] : []);
        if (selected.length === 0) throw new Error("glob requires pattern or patterns.");
        return searchFilesTool({ root: root ?? ctx.cwd, patterns: selected, maxResults, timeoutMs });
      })
    }),
    grep: tool({
      description: "Search file contents by regex under a root and glob patterns. Returns an explicit no-match result and searched roots.",
      inputSchema: z.object({ pattern: z.string(), root: z.string().optional(), glob: z.string().optional(), patterns: z.array(z.string()).min(1).max(32).optional(), maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(), timeoutMs: z.number().int().positive().max(MAX_SEARCH_RUNTIME_MS).optional() }),
      execute: wrapExecute(ctx, role, "grep", ({ pattern, root }) => `${root ?? ctx.cwd}:${pattern}`, ({ pattern, root, glob, patterns, maxResults, timeoutMs }) => searchFilesTool({ root: root ?? ctx.cwd, patterns: patterns ?? [glob ?? "**/*"], contentPattern: pattern, maxResults, timeoutMs }))
    })
  };

  const bashExecute = async ({ command, timeoutMs, runInBackground }: { command: string; timeoutMs?: number; runInBackground?: boolean }) => {
    if (role === "reviewer" && !allowedBashCommands.includes(command)) {
      throw new Error(`Reviewer bash is restricted to plan verification commands: ${allowedBashCommands.join(", ")}`);
    }
    return bashTool(ctx, command, timeoutMs, runInBackground);
  };

  const backgroundTool = tool({
    description: "List, read output from, or stop a background shell process.",
    inputSchema: z.object({ action: z.enum(["list", "read", "stop"]), id: z.string().optional() }),
    execute: wrapExecute(ctx, role, "bash_background", ({ action, id }) => id ?? action, ({ action, id }) => backgroundProcessTool(action, id))
  });
  const awaitTool = tool({
    description: `${DURABLE_AWAIT_DESCRIPTION} For background renders, provide expectedDurationMs and safetyMarginMs when known; intervals below 60 seconds are raised to a 60-second minimum, so use a deadline measured in minutes rather than a few seconds. A wakeup is not failure and the await may be extended or re-registered.`,
    inputSchema: z.object({ processId: z.string(), timeoutMs: z.number().int().positive(), terminalTimeoutMs: z.number().int().positive().optional(), id: z.string().optional(), expectedDurationMs: z.number().int().nonnegative().optional(), safetyMarginMs: z.number().int().nonnegative().optional() }),
    execute: wrapExecute(ctx, role, "await_background", ({ processId }) => processId, ({ processId, timeoutMs, terminalTimeoutMs, id, expectedDurationMs, safetyMarginMs }) => {
      if (!ctx.durableAwait) throw new Error("Durable await is unavailable outside an orchestrated round.");
      return ctx.durableAwait({ processId, timeoutMs, terminalTimeoutMs, id, expectedDurationMs, safetyMarginMs });
    })
  });

  const sharedTools = memoryTools(ctx, role);

  if (role === "leader-readonly") return { ...readonlyTools, ...sharedTools };

  if (role === "reviewer") {
    return {
      ...readonlyTools,
        ...sharedTools,
        bash_background: backgroundTool,
        await_background: awaitTool,
        bash: tool({
        description: "Run one of the plan verification commands in the project root.",
        inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional(), runInBackground: z.boolean().optional() }),
        execute: wrapExecute(ctx, role, "bash", ({ command }) => command, bashExecute)
      })
    };
  }

  return {
    ...readonlyTools,
    ...sharedTools,
    bash_background: backgroundTool,
    await_background: awaitTool,
    write_file: tool({
      description: "Write a file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: wrapExecute(ctx, role, "write_file", ({ path }) => path, ({ path, content }) => writeFileTool(ctx, path, content))
    }),
    edit_file: tool({
      description: "Edit a file by exact replacement.",
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replaceAll: z.boolean().optional() }),
      execute: wrapExecute(ctx, role, "edit_file", ({ path }) => path, ({ path, old_string, new_string, replaceAll }) => editFileTool(ctx, path, old_string, new_string, replaceAll))
    }),
    bash: tool({
      description: "Run a shell command in the project root.",
      inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional(), runInBackground: z.boolean().optional() }),
      execute: wrapExecute(ctx, role, "bash", ({ command }) => command, bashExecute)
    })
  };
}
