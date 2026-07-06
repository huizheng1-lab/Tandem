import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { editFileTool, listDirTool, readFileTool, ToolActivityRole, ToolContext, writeFileTool } from "./fs.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";

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
    ctx.onToolEvent?.({ ...eventBase, phase: "start" });
    try {
      const result = await execute(input);
      ctx.onToolEvent?.({ ...eventBase, phase: "end", ok: true, ms: Date.now() - started });
      return result;
    } catch (error) {
      ctx.onToolEvent?.({ ...eventBase, phase: "end", ok: false, ms: Date.now() - started });
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
      description: "Find files by glob pattern.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: wrapExecute(ctx, role, "glob", ({ pattern }) => pattern, ({ pattern }) => globTool(ctx.cwd, pattern))
    }),
    grep: tool({
      description: "Search files by regex.",
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional(), path: z.string().optional() }),
      execute: wrapExecute(ctx, role, "grep", ({ pattern }) => pattern, ({ pattern, glob, path }) => grepTool(ctx.cwd, pattern, glob, path))
    })
  };

  const bashExecute = async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
    if (role === "reviewer" && !allowedBashCommands.includes(command)) {
      throw new Error(`Reviewer bash is restricted to plan verification commands: ${allowedBashCommands.join(", ")}`);
    }
    return bashTool(ctx, command, timeoutMs);
  };

  const sharedTools = memoryTools(ctx, role);

  if (role === "leader-readonly") return { ...readonlyTools, ...sharedTools };

  if (role === "reviewer") {
    return {
      ...readonlyTools,
      ...sharedTools,
      bash: tool({
        description: "Run one of the plan verification commands in the project root.",
        inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional() }),
        execute: wrapExecute(ctx, role, "bash", ({ command }) => command, bashExecute)
      })
    };
  }

  return {
    ...readonlyTools,
    ...sharedTools,
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
      inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional() }),
      execute: wrapExecute(ctx, role, "bash", ({ command }) => command, bashExecute)
    })
  };
}
