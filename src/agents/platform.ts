export function hostPlatformPrompt(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const shell = platform === "win32" ? env.ComSpec || "cmd/PowerShell" : env.SHELL || "sh";
  if (platform === "win32") {
    return `Host: Windows (${platform}); shell: ${shell}. Commands run with Windows cmd/PowerShell semantics. Verification commands must run verbatim on Windows. Do not use POSIX-only commands such as cat, grep, ls, touch, rm, sed, awk, head, tail, or chmod; prefer node -e, npm scripts, type, findstr, or PowerShell equivalents.`;
  }
  return `Host platform: ${platform}; shell: ${shell}. Verification commands must run verbatim on this host and must not assume a different OS or shell.`;
}
