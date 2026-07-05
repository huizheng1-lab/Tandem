import { execa } from "execa";
import { ToolContext, resolveInside } from "./fs.js";
import { ensurePermission } from "./permissions.js";

export interface ShellResult {
  command: string;
  passed: boolean;
  output: string;
}

export function tailOutput(output: string, maxChars = 2000): string {
  if (output.length <= maxChars) return output;
  return output.slice(output.length - maxChars);
}

export async function bashTool(ctx: ToolContext, command: string, timeoutMs = 120000): Promise<ShellResult> {
  resolveInside(ctx.cwd, ".");
  await ensurePermission(ctx.permissionMode, { action: "bash", target: command }, ctx.permissionBridge);
  try {
    const result = await execa(command, { cwd: ctx.cwd, shell: true, timeout: timeoutMs, reject: false, all: true });
    return {
      command,
      passed: result.exitCode === 0,
      output: tailOutput(result.all ?? "")
    };
  } catch (error) {
    return { command, passed: false, output: tailOutput(String(error)) };
  }
}
