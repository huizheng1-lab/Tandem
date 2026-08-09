import { readdirSync } from "node:fs";
import path from "node:path";
import { resolveEnvironment } from "./resolve.js";
import type { InstalledRuntimeCandidates } from "./resolve.js";
import type { RequestedCapability, ResolvedEnvironment } from "./types.js";

export interface EnvironmentPreflightResult {
  environment: ResolvedEnvironment;
  env: NodeJS.ProcessEnv;
  /** The bounded installed-runtime scan used by this preflight. */
  installed: InstalledRuntimeCandidates;
  /** Capabilities named by the plan/command and therefore strict. */
  requiredCapabilities: RequestedCapability[];
  /** Every capability attempted, including best-effort standard toolchain probes. */
  attemptedCapabilities: RequestedCapability[];
  /** Best-effort misses are reported here but do not block execution. */
  notFoundCapabilities: ResolvedEnvironment["unresolvedCapabilities"];
}

/** Put the resolver's canonical executable directories first for every caller. */
export function applyResolvedEnvironment(env: NodeJS.ProcessEnv, environment: ResolvedEnvironment, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const pathSeparator = platform === "win32" ? ";" : ":";
  const selectedDirectories = Object.values(environment.tools)
    .map((tool) => tool?.executablePath ? path.dirname(tool.executablePath) : undefined)
    .filter((directory): directory is string => Boolean(directory));
  const currentPath = env.PATH ?? env.Path ?? env.path ?? "";
  const normalizedPath = [...new Set([...selectedDirectories, ...currentPath.split(pathSeparator).filter(Boolean)])].join(pathSeparator);
  env.PATH = normalizedPath;
  if (platform === "win32" && env.Path !== undefined) env.Path = normalizedPath;
  return env;
}

export function commandCapabilities(commands: string[], platform: NodeJS.Platform): RequestedCapability[] {
  const text = commands.join("\n");
  const capabilities: RequestedCapability[] = [];
  const add = (capability: RequestedCapability) => {
    if (!capabilities.some((item) => item.kind === capability.kind && (item.kind !== "executable" || capability.kind !== "executable" || item.name === capability.name))) capabilities.push(capability);
  };
  // Inspect command positions, rather than maintaining a list of approved
  // binaries. Quoted absolute paths are supported for Windows installs.
  const shellBuiltins = new Set(["if", "then", "else", "fi", "for", "do", "done", "in", "echo", "cd", "set", "call"]);
  const commandTokens = /(?:^|[\r\n;&|]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gm;
  for (const match of text.matchAll(commandTokens)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw) continue;
    const name = raw.replaceAll("\\", "/").split("/").pop()!.replace(/\.exe$/i, "");
    if (!name || shellBuiltins.has(name.toLowerCase()) || name.startsWith("-")) continue;
    if (name.toLowerCase() === "ffmpeg") add({ kind: "ffmpeg" });
    else if (name.toLowerCase() === "ffprobe") add({ kind: "ffprobe" });
    else if (/^python(?:3)?$/i.test(name)) add({ kind: "python" });
    else if (name.toLowerCase() === "node") add({ kind: "node" });
    else if (name.toLowerCase() === "codex-windows-sandbox") add({ kind: "codex-sandbox-helper" });
    else add({ kind: "executable", name });
  }
  return capabilities;
}

export function installedRuntimeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): InstalledRuntimeCandidates {
  if (platform !== "win32") return { ffmpegDirectories: [], codexDirectories: [] };
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramW6432"], env["ProgramFiles(x86)"]]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.win32.normalize(value));
  const found = new Set<string>();
  const queue = roots.map((root) => ({ root, depth: 0 }));
  while (queue.length > 0 && found.size < 4000) {
    const current = queue.shift()!;
    if (current.depth > 7) continue;
    let entries;
    try { entries = readdirSync(current.root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const child = path.win32.join(current.root, entry.name);
      found.add(child);
      queue.push({ root: child, depth: current.depth + 1 });
    }
  }
  const directories = [...found];
  return {
    ffmpegDirectories: directories.filter((directory) => /ffmpeg|media/i.test(directory)),
    codexDirectories: directories.filter((directory) => /codex/i.test(directory))
  };
}

export async function preflightEnvironment(options: {
  commands: string[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolve?: typeof resolveEnvironment;
  installed?: InstalledRuntimeCandidates;
  /** Set when the caller has already memoized the bounded installed scan. */
  skipInstalledDirectoryDiscovery?: boolean;
}): Promise<EnvironmentPreflightResult> {
  const platform = options.platform ?? process.platform;
  const requestedCapabilities = commandCapabilities(options.commands, platform);
  const discovered = options.skipInstalledDirectoryDiscovery
    ? { ffmpegDirectories: [], codexDirectories: [] }
    : installedRuntimeCandidates(options.env, platform);
  const installed: InstalledRuntimeCandidates = {
    ...discovered,
    ...options.installed,
    ffmpegDirectories: [...new Set([...(discovered.ffmpegDirectories ?? []), ...(options.installed?.ffmpegDirectories ?? [])])],
    codexDirectories: [...new Set([...(discovered.codexDirectories ?? []), ...(options.installed?.codexDirectories ?? [])])]
  };
  // Resolve the standard toolchain opportunistically, not only what the plan text
  // happened to name. A worker routinely runs commands the BuildPlan never mentions
  // (ad-hoc ffprobe/ffmpeg during a render), and plan-scoped discovery left those
  // unresolved so PATH was never augmented and the tool looked "unavailable" even
  // when installed. These extras are best effort: discovered ones get their
  // directory prepended, absent ones must never fail a run that did not need them.
  // Open-ended executable discovery is best effort. A command can name a shell,
  // interpreter, or task-specific CLI without making its absence a preflight
  // blocker; explicit runtime capabilities remain strict.
  const requiredKinds: Set<string> = new Set(requestedCapabilities
    .filter((capability) => capability.kind !== "executable")
    .map((capability) => capability.kind));
  const opportunistic: RequestedCapability[] = (["node", "ffmpeg", "ffprobe", "python"] as const)
    .filter((kind) => !requiredKinds.has(kind))
    .map((kind) => ({ kind }));
  const environment = await (options.resolve ?? resolveEnvironment)({
    requestedCapabilities: [...requestedCapabilities, ...opportunistic],
    env: options.env,
    platform,
    installed
  });
  applyResolvedEnvironment(options.env, environment, platform);
  return {
    environment,
    env: options.env,
    installed,
    requiredCapabilities: requestedCapabilities.filter((capability) => capability.kind !== "executable"),
    attemptedCapabilities: environment.requestedCapabilities,
    notFoundCapabilities: environment.unresolvedCapabilities
  };
}
