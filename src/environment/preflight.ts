import { readdirSync } from "node:fs";
import path from "node:path";
import { resolveEnvironment } from "./resolve.js";
import type { InstalledRuntimeCandidates } from "./resolve.js";
import type { RequestedCapability, ResolvedEnvironment } from "./types.js";

export interface EnvironmentPreflightResult {
  environment: ResolvedEnvironment;
  env: NodeJS.ProcessEnv;
  /** Capabilities named by the plan/command; opportunistic probes are not included. */
  requiredCapabilities: RequestedCapability[];
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

export class EnvironmentPreflightError extends Error {
  readonly environment: ResolvedEnvironment;
  constructor(environment: ResolvedEnvironment) {
    const missing = environment.unresolvedCapabilities[0];
    const detail = missing
      ? `${missing.name}: ${missing.reason} (attempted ${missing.attemptedSources.join(", ") || "no candidates"})`
      : "No usable runtime was found.";
    super(`Environment preflight blocked execution: missing ${detail}`);
    this.name = "EnvironmentPreflightError";
    this.environment = environment;
  }
}

function commandCapabilities(commands: string[], platform: NodeJS.Platform): RequestedCapability[] {
  const text = commands.join("\n");
  const capabilities: RequestedCapability[] = [];
  const add = (capability: RequestedCapability) => {
    if (!capabilities.some((item) => item.kind === capability.kind)) capabilities.push(capability);
  };
  // Do not require the command to be a bare PATH token. Windows installations
  // commonly live below a directory containing spaces (for example WinGet's
  // package folder), and the shell may receive a quoted absolute path.
  const token = (name: string) => new RegExp(`\\b${name}(?:\\.exe)?\\b`, "im").test(text);
  if (token("ffmpeg")) add({ kind: "ffmpeg" });
  if (token("ffprobe")) add({ kind: "ffprobe" });
  if (token("python(?:3)?")) add({ kind: "python" });
  if (token("node")) add({ kind: "node" });
  return capabilities;
}

function installedDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { ffmpegDirectories: string[]; codexDirectories: string[] } {
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
}): Promise<EnvironmentPreflightResult> {
  const platform = options.platform ?? process.platform;
  const requestedCapabilities = commandCapabilities(options.commands, platform);
  const discovered = installedDirectories(options.env, platform);
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
  const requiredKinds = new Set(requestedCapabilities.map((capability) => capability.kind));
  const opportunistic: RequestedCapability[] = (["node", "ffmpeg", "ffprobe", "python"] as const)
    .filter((kind) => !requiredKinds.has(kind))
    .map((kind) => ({ kind }));
  const environment = await (options.resolve ?? resolveEnvironment)({
    requestedCapabilities: [...requestedCapabilities, ...opportunistic],
    env: options.env,
    platform,
    installed
  });
  // Fail closed only for capabilities the plan genuinely required.
  const requiredUnresolved = environment.unresolvedCapabilities.filter((item) => requiredKinds.has(item.capability));
  if (requiredUnresolved.length > 0) throw new EnvironmentPreflightError({ ...environment, unresolvedCapabilities: requiredUnresolved });

  applyResolvedEnvironment(options.env, environment, platform);
  return { environment, env: options.env, requiredCapabilities: requestedCapabilities };
}
