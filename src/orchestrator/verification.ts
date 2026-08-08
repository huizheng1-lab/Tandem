import { PermissionBridge, ensurePermission } from "../tools/permissions.js";
import { bashTool, ShellResult } from "../tools/shell.js";
import { runnableVerificationCommand } from "./artifacts.js";
import { applyResolvedEnvironment } from "../environment/preflight.js";
import type { ResolvedEnvironment } from "../environment/types.js";

export type VerificationResult = Pick<ShellResult, "command" | "passed" | "output">;
export type VerificationRunner = (commands: string[], environment?: ResolvedEnvironment) => Promise<VerificationResult[]>;

export const VERIFICATION_COMMAND_TIMEOUT_MS = 300_000;

export function createVerificationRunner(options: {
  cwd: string;
  permissionMode: "ask" | "auto-edit" | "yolo";
  permissionBridge?: PermissionBridge;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): VerificationRunner {
  return async (commands, environment) => {
    if (commands.length === 0) return [];
    if (environment) applyResolvedEnvironment(options.env ?? process.env, environment);
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
          env: options.env,
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
