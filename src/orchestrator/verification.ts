import { PermissionBridge, ensurePermission } from "../tools/permissions.js";
import { bashTool, ShellResult } from "../tools/shell.js";
import { runnableVerificationCommand } from "./artifacts.js";

export type VerificationResult = Pick<ShellResult, "command" | "passed" | "output">;
export type VerificationRunner = (commands: string[]) => Promise<VerificationResult[]>;

export const VERIFICATION_COMMAND_TIMEOUT_MS = 300_000;

export function createVerificationRunner(options: {
  cwd: string;
  permissionMode: "ask" | "auto-edit" | "yolo";
  permissionBridge?: PermissionBridge;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): VerificationRunner {
  return async (commands) => {
    if (commands.length === 0) return [];
    if (options.permissionMode === "ask") {
      await ensurePermission(
        "ask",
        {
          action: "bash",
          target: `Run the plan's ${commands.length} verification command(s)?\n${commands.join("\n")}`
        },
        options.permissionBridge
      );
    }
    const results: VerificationResult[] = [];
    for (const command of commands) {
      const result = await bashTool(
        {
          cwd: options.cwd,
          permissionMode: "yolo",
          abortSignal: options.abortSignal
        },
        runnableVerificationCommand(command),
        options.timeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS
      );
      results.push({ ...result, command });
    }
    return results;
  };
}
