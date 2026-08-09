import type { ResolvedEnvironment, ResolvedTool } from "../environment/types.js";

export function hostPlatformPrompt(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const shell = platform === "win32" ? env.ComSpec || "cmd/PowerShell" : env.SHELL || "sh";
  if (platform === "win32") {
    return `Host: Windows (${platform}); shell: ${shell}. Commands run with Windows cmd/PowerShell semantics. Verification commands must run verbatim on Windows. Do not use POSIX-only commands such as cat, grep, ls, touch, rm, sed, awk, head, tail, or chmod; prefer node -e, npm scripts, type, findstr, or PowerShell equivalents.`;
  }
  return `Host platform: ${platform}; shell: ${shell}. Verification commands must run verbatim on this host and must not assume a different OS or shell.`;
}

export function resolvedEnvironmentPrompt(environment: ResolvedEnvironment | undefined): string {
  if (!environment) return "Recorded environment preflight: unavailable; do not assert that a runtime is missing based only on this CLI sandbox. Report only commands that actually failed.";
  const resolved = Object.entries(environment.tools)
    .filter((entry): entry is [string, ResolvedTool] => Boolean(entry[1]?.executablePath))
    .map(([capability, tool]) => `${capability}=${tool.executablePath}`);
  const missing = environment.unresolvedCapabilities.map((item) => `${item.name}: ${item.reason}`);
  return `Recorded environment preflight (advisory snapshot): resolved=${resolved.join(", ") || "none"}; unresolved=${missing.join("; ") || "none"}. Use this snapshot to plan efficiently, but treat actual command output as authoritative. Do not claim a resolved runtime is unavailable based on a different CLI sandbox.`;
}
