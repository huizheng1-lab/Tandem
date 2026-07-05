import { tool } from "ai";
import { z } from "zod";
import { editFileTool, listDirTool, readFileTool, ToolContext, writeFileTool } from "./fs.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";

export type ToolRole = "leader-readonly" | "worker" | "reviewer" | "takeover";

export function makeToolSet(ctx: ToolContext, role: ToolRole, allowedBashCommands: string[] = []) {
  const readonlyTools = {
    read_file: tool({
      description: "Read a file with line numbers.",
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().positive().optional() }),
      execute: ({ path, offset, limit }) => readFileTool(ctx, path, offset, limit)
    }),
    list_dir: tool({
      description: "List a directory.",
      inputSchema: z.object({ path: z.string().optional() }),
      execute: ({ path }) => listDirTool(ctx, path ?? ".")
    }),
    glob: tool({
      description: "Find files by glob pattern.",
      inputSchema: z.object({ pattern: z.string() }),
      execute: ({ pattern }) => globTool(ctx.cwd, pattern)
    }),
    grep: tool({
      description: "Search files by regex.",
      inputSchema: z.object({ pattern: z.string(), glob: z.string().optional(), path: z.string().optional() }),
      execute: ({ pattern, glob, path }) => grepTool(ctx.cwd, pattern, glob, path)
    })
  };

  const bashExecute = async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
    if (role === "reviewer" && !allowedBashCommands.includes(command)) {
      throw new Error(`Reviewer bash is restricted to plan verification commands: ${allowedBashCommands.join(", ")}`);
    }
    return bashTool(ctx, command, timeoutMs);
  };

  if (role === "leader-readonly") return readonlyTools;

  if (role === "reviewer") {
    return {
      ...readonlyTools,
      bash: tool({
        description: "Run one of the plan verification commands in the project root.",
        inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional() }),
        execute: bashExecute
      })
    };
  }

  return {
    ...readonlyTools,
    write_file: tool({
      description: "Write a file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => writeFileTool(ctx, path, content)
    }),
    edit_file: tool({
      description: "Edit a file by exact replacement.",
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replaceAll: z.boolean().optional() }),
      execute: ({ path, old_string, new_string, replaceAll }) => editFileTool(ctx, path, old_string, new_string, replaceAll)
    }),
    bash: tool({
      description: "Run a shell command in the project root.",
      inputSchema: z.object({ command: z.string(), timeoutMs: z.number().int().positive().optional() }),
      execute: bashExecute
    })
  };
}
