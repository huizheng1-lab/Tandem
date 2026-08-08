import { readdirSync } from "node:fs";
import path from "node:path";
import { resolveEnvironment } from "./resolve.js";
import type { RequestedCapability, ResolvedEnvironment } from "./types.js";

export interface EnvironmentPreflightResult {
  environment: ResolvedEnvironment;
  env: NodeJS.ProcessEnv;
}

export class EnvironmentPreflightError extends Error {
  readonly environment: ResolvedEnvironment;
  constructor(environment: ResolvedEnvironment) {
    const missing = environment.unresolvedCapabilities[0];
    super(`Environment preflight blocked execution: missing ${missing?.name ?? "required capability"}. ${missing?.reason ?? "No usable runtime was found."}`);
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
  const executable = platform === "win32" ? "(?:[A-Za-z]:[\\\\/][^\\s&|;]+[\\\\/])?" : "(?:\\.\\.?/)?";
  const token = (name: string) => new RegExp(`(?:^|[\\s;&|])${executable}${name}(?:\\.exe)?(?=\\s|$)`, "im").test(text);
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
}): Promise<EnvironmentPreflightResult> {
  const platform = options.platform ?? process.platform;
  const requestedCapabilities = commandCapabilities(options.commands, platform);
  const installed = installedDirectories(options.env, platform);
  const environment = await (options.resolve ?? resolveEnvironment)({ requestedCapabilities, env: options.env, platform, installed });
  if (environment.unresolvedCapabilities.length > 0) throw new EnvironmentPreflightError(environment);

  const pathSeparator = platform === "win32" ? ";" : ":";
  const selectedDirectories = Object.values(environment.tools)
    .map((tool) => tool?.executablePath ? path.dirname(tool.executablePath) : undefined)
    .filter((directory): directory is string => Boolean(directory));
  const currentPath = options.env.PATH ?? options.env.Path ?? options.env.path ?? "";
  const normalizedPath = [...new Set([...selectedDirectories, ...currentPath.split(pathSeparator).filter(Boolean)])].join(pathSeparator);
  options.env.PATH = normalizedPath;
  if (platform === "win32" && options.env.Path !== undefined) options.env.Path = normalizedPath;
  return { environment, env: options.env };
}
