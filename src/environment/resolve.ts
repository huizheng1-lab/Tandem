import { statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { resolveOnPath } from "../tools/resolve-on-path.js";
import type {
  CandidateProbeEvidence,
  ExecutableCapability,
  ProcessProbeResult,
  RequestedCapability,
  ResolvedEnvironment,
  ResolvedTool,
  ResolutionSource,
  ResolutionSourceAttempt,
  UnresolvedCapability
} from "./types.js";

export interface EnvironmentFileSystem {
  stat(filePath: string): { size: number; isFile(): boolean };
}

export interface EnvironmentProcessProbe {
  run(executablePath: string, args: string[], options: { timeoutMs: number }): Promise<ProcessProbeResult>;
}

export interface EnvironmentNetworkProbe {
  probe(host: string, options: { timeoutMs: number }): Promise<{ ok: boolean; detail: string }>;
}

export interface InstalledRuntimeCandidates {
  python?: string[];
  node?: string[];
  ffmpeg?: string[];
  ffprobe?: string[];
  codexSandboxHelper?: string[];
  ffmpegDirectories?: string[];
  codexDirectories?: string[];
}

export interface ResolveEnvironmentOptions {
  requestedCapabilities: RequestedCapability[];
  overrides?: Partial<Record<ExecutableCapability, string>>;
  installed?: InstalledRuntimeCandidates;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathSeparator?: string;
  filesystem?: EnvironmentFileSystem;
  processProbe?: EnvironmentProcessProbe;
  networkProbe?: EnvironmentNetworkProbe;
  probeTimeoutMs?: number;
  maxCandidatesPerCapability?: number;
}

interface Candidate {
  path: string;
  source: ResolutionSource;
}

const SOURCE_ORDER: Record<ResolutionSource, number> = {
  override: 0,
  path: 1,
  "installed-runtime": 2,
  "registered-directory": 3,
  "declared-host": 4
};

const WINDOWS_NAMES: Record<ExecutableCapability, string[]> = {
  python: ["python.exe", "python3.exe", "python"],
  node: ["node.exe", "node"],
  ffmpeg: ["ffmpeg.exe", "ffmpeg"],
  ffprobe: ["ffprobe.exe", "ffprobe"],
  "codex-sandbox-helper": ["codex-windows-sandbox.exe", "codex-windows-sandbox"]
};

const POSIX_NAMES: Record<ExecutableCapability, string[]> = {
  python: ["python3", "python"],
  node: ["node"],
  ffmpeg: ["ffmpeg"],
  ffprobe: ["ffprobe"],
  "codex-sandbox-helper": ["codex-windows-sandbox"]
};

function defaultFileSystem(): EnvironmentFileSystem {
  return { stat: (filePath) => statSync(filePath) };
}

function defaultProcessProbe(): EnvironmentProcessProbe {
  return {
    async run(executablePath, args, options) {
      try {
        const result = await execa(executablePath, args, {
          reject: false,
          timeout: options.timeoutMs,
          windowsHide: true,
          stdin: "ignore"
        });
        return { exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { exitCode: null, stdout: "", stderr: "", error: detail, timedOut: /timed out|timeout/i.test(detail) };
      }
    }
  };
}

function defaultNetworkProbe(): EnvironmentNetworkProbe {
  return {
    async probe(host, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        await fetch(`https://${host}/`, { method: "HEAD", signal: controller.signal, redirect: "manual" });
        return { ok: true, detail: `Connected to ${host}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function canonicalPath(candidate: string, platform: NodeJS.Platform): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(candidate)) return undefined;
  return pathApi.normalize(candidate);
}

function safeFileCheck(filePath: string, filesystem: EnvironmentFileSystem): { ok: boolean; detail: string } {
  try {
    const stat = filesystem.stat(filePath);
    if (!stat.isFile()) return { ok: false, detail: `${filePath} is not a file` };
    if (stat.size <= 0) return { ok: false, detail: `${filePath} is a zero-byte executable` };
    return { ok: true, detail: `${filePath} is a non-zero file` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${filePath} is missing or inaccessible: ${detail}` };
  }
}

function collectPathCandidates(
  tool: ExecutableCapability,
  names: string[],
  env: NodeJS.ProcessEnv,
  pathSeparator: string,
  filesystem: EnvironmentFileSystem,
  maximum: number
): string[] {
  const found: string[] = [];
  const ignored = new Set<string>();
  while (found.length < maximum) {
    const next = resolveOnPath({
      token: tool,
      names,
      env,
      pathSeparator,
      exists: (candidate) => {
        if (ignored.has(candidate)) return false;
        try {
          filesystem.stat(candidate);
          return true;
        } catch {
          return false;
        }
      }
    });
    if (!next) break;
    found.push(next);
    ignored.add(next);
  }
  return found;
}

function installedFor(tool: ExecutableCapability, installed: InstalledRuntimeCandidates): string[] {
  if (tool === "codex-sandbox-helper") return installed.codexSandboxHelper ?? [];
  return installed[tool] ?? [];
}

function directoryCandidates(tool: ExecutableCapability, installed: InstalledRuntimeCandidates, names: string[], platform: NodeJS.Platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directories = tool === "ffprobe" ? installed.ffmpegDirectories ?? [] : tool === "codex-sandbox-helper" ? installed.codexDirectories ?? [] : [];
  return directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
}

function uniqueCandidates(candidates: Candidate[], platform: NodeJS.Platform, maximum: number): Candidate[] {
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source])
    .filter((candidate) => {
      const canonical = canonicalPath(candidate.path, platform);
      if (!canonical) return false;
      const key = platform === "win32" ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) return false;
      seen.add(key);
      candidate.path = canonical;
      return true;
    })
    .slice(0, maximum);
}

function requestedExecutableKinds(requested: RequestedCapability[]): ExecutableCapability[] {
  const result: ExecutableCapability[] = [];
  for (const request of requested) {
    if (request.kind === "network-host") continue;
    if (!result.includes(request.kind)) result.push(request.kind);
  }
  return result;
}

function parseVersion(output: string): string | undefined {
  return output.match(/\d+(?:\.\d+){1,3}/)?.[0];
}

function versionAtLeast(actual: string | undefined, minimum: string | undefined): boolean {
  if (!minimum) return true;
  if (!actual) return false;
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function probeArguments(tool: ExecutableCapability): string[] {
  return tool === "ffmpeg" || tool === "ffprobe" ? ["-version"] : tool === "codex-sandbox-helper" ? ["--help"] : ["--version"];
}

function processFailure(result: ProcessProbeResult): string {
  if (result.timedOut) return "probe timed out";
  return result.error || result.stderr.trim() || result.stdout.trim() || `probe exited ${result.exitCode ?? "without a status"}`;
}

async function probeCandidate(
  tool: ExecutableCapability,
  candidate: Candidate,
  request: Exclude<RequestedCapability, { kind: "network-host" }>,
  dependencies: { filesystem: EnvironmentFileSystem; processProbe: EnvironmentProcessProbe; timeoutMs: number }
): Promise<{ evidence: CandidateProbeEvidence; resolved?: ResolvedTool }> {
  const file = safeFileCheck(candidate.path, dependencies.filesystem);
  if (!file.ok) {
    return {
      evidence: { capability: tool, candidate: candidate.path, source: candidate.source, accepted: false, checkedCapabilities: [tool], failedCapabilities: [tool], detail: file.detail }
    };
  }

  const versionResult = await dependencies.processProbe.run(candidate.path, probeArguments(tool), { timeoutMs: dependencies.timeoutMs });
  if (versionResult.exitCode !== 0) {
    return {
      evidence: {
        capability: tool,
        candidate: candidate.path,
        source: candidate.source,
        accepted: false,
        checkedCapabilities: [tool],
        failedCapabilities: [tool],
        detail: `${candidate.path} failed its executable probe: ${processFailure(versionResult)}`
      }
    };
  }

  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (tool !== "codex-sandbox-helper" && !version) {
    return {
      evidence: {
        capability: tool,
        candidate: candidate.path,
        source: candidate.source,
        accepted: false,
        checkedCapabilities: [tool, `${tool}-version`],
        failedCapabilities: [`${tool}-version`],
        detail: `${candidate.path} exited successfully but did not report a recognizable ${tool} version`
      }
    };
  }
  const minimum = "minimumVersion" in request ? request.minimumVersion : undefined;
  if (!versionAtLeast(version, minimum)) {
    const capability = `${tool}>=${minimum}`;
    return {
      evidence: { capability: tool, candidate: candidate.path, source: candidate.source, accepted: false, version, checkedCapabilities: [tool, capability], failedCapabilities: [capability], detail: `${candidate.path} reported ${version ?? "no version"}; required ${minimum}` }
    };
  }

  const modules = request.kind === "python" ? [...new Set(request.modules ?? [])] : [];
  const missingModules: string[] = [];
  for (const moduleName of modules) {
    const moduleResult = await dependencies.processProbe.run(candidate.path, ["-c", `import ${moduleName}`], { timeoutMs: dependencies.timeoutMs });
    if (moduleResult.exitCode !== 0) missingModules.push(moduleName);
  }
  if (missingModules.length > 0) {
    return {
      evidence: {
        capability: tool,
        candidate: candidate.path,
        source: candidate.source,
        accepted: false,
        version,
        checkedCapabilities: [tool, ...modules.map((moduleName) => `python-module:${moduleName}`)],
        failedCapabilities: missingModules.map((moduleName) => `python-module:${moduleName}`),
        detail: `${candidate.path} is missing Python module(s): ${missingModules.join(", ")}`
      }
    };
  }

  return {
    evidence: {
      capability: tool,
      candidate: candidate.path,
      source: candidate.source,
      accepted: true,
      version,
      checkedCapabilities: [tool, ...modules.map((moduleName) => `python-module:${moduleName}`)],
      failedCapabilities: [],
      detail: `${candidate.path} satisfies ${tool}${modules.length > 0 ? ` with modules ${modules.join(", ")}` : ""}`
    },
    resolved: { capability: tool, executablePath: candidate.path, source: candidate.source, version, pythonModules: tool === "python" ? modules : undefined }
  };
}

export async function resolveEnvironment(options: ResolveEnvironmentOptions): Promise<ResolvedEnvironment> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const filesystem = options.filesystem ?? defaultFileSystem();
  const processProbe = options.processProbe ?? defaultProcessProbe();
  const networkProbe = options.networkProbe ?? defaultNetworkProbe();
  const timeoutMs = options.probeTimeoutMs ?? 5_000;
  const maximum = options.maxCandidatesPerCapability ?? 32;
  const installed = options.installed ?? {};
  const namesByTool = platform === "win32" ? WINDOWS_NAMES : POSIX_NAMES;
  const pathSeparator = options.pathSeparator ?? (platform === "win32" ? ";" : ":");
  const result: ResolvedEnvironment = {
    requestedCapabilities: structuredClone(options.requestedCapabilities),
    tools: {},
    probeEvidence: [],
    unresolvedCapabilities: [],
    attemptedSources: [],
    diagnostics: []
  };

  for (const tool of requestedExecutableKinds(options.requestedCapabilities)) {
    const request = options.requestedCapabilities.find((item): item is Exclude<RequestedCapability, { kind: "network-host" }> => item.kind === tool)!;
    const names = namesByTool[tool];
    const rawCandidates: Candidate[] = [];
    const record = (source: ResolutionSource, value: string, candidates: string[]) => {
      result.attemptedSources.push({ capability: tool, source, value });
      rawCandidates.push(...candidates.map((candidatePath) => ({ path: candidatePath, source })));
    };
    const override = options.overrides?.[tool];
    if (override) record("override", override, [override]);
    record("path", env.PATH ?? env.Path ?? env.path ?? "", collectPathCandidates(tool, names, env, pathSeparator, filesystem, maximum));
    const boundedInstalled = installedFor(tool, installed).slice(0, maximum);
    record("installed-runtime", boundedInstalled.join(pathSeparator), boundedInstalled);
    const registered = directoryCandidates(tool, installed, names, platform).slice(0, maximum);
    if (registered.length > 0) record("registered-directory", registered.join(pathSeparator), registered);

    const candidates = uniqueCandidates(rawCandidates, platform, maximum);
    if (override && !canonicalPath(override, platform)) {
      result.probeEvidence.push({ capability: tool, candidate: override, source: "override", accepted: false, checkedCapabilities: [tool], failedCapabilities: [tool], detail: `Override '${override}' is an ambiguous launcher token or non-absolute path and cannot be selected` });
    }
    for (const candidate of candidates) {
      const probed = await probeCandidate(tool, candidate, request, { filesystem, processProbe, timeoutMs });
      result.probeEvidence.push(probed.evidence);
      if (probed.resolved) {
        result.tools[tool] = probed.resolved;
        result.diagnostics.push({ severity: "info", capability: tool, candidate: candidate.path, message: `Selected ${candidate.path} from ${candidate.source}` });
        break;
      }
      result.diagnostics.push({ severity: "warning", capability: tool, candidate: candidate.path, message: probed.evidence.detail });
    }

    if (!result.tools[tool]) {
      const failed = result.probeEvidence.filter((evidence) => evidence.capability === tool).flatMap((evidence) => evidence.failedCapabilities);
      const pythonModules = request.kind === "python" ? request.modules ?? [] : [];
      const missingModules = pythonModules.filter((moduleName) => failed.includes(`python-module:${moduleName}`));
      const unresolvedNames = missingModules.length > 0 ? missingModules.map((moduleName) => `python-module:${moduleName}`) : [tool];
      for (const name of unresolvedNames) {
        const unresolved: UnresolvedCapability = {
          capability: tool,
          name,
          reason: name.startsWith("python-module:") ? `No usable Python candidate supplies module ${name.slice("python-module:".length)}` : `No usable ${tool} executable was found`,
          attemptedSources: result.attemptedSources.filter((attempt) => attempt.capability === tool).map((attempt) => `${attempt.source}:${attempt.value || "<empty>"}`)
        };
        result.unresolvedCapabilities.push(unresolved);
        result.diagnostics.push({ severity: "error", capability: tool, message: `${unresolved.reason}; tried ${unresolved.attemptedSources.join(", ")}` });
      }
    }
  }

  for (const request of options.requestedCapabilities) {
    if (request.kind !== "network-host") continue;
    const host = request.host.trim();
    const attempt: ResolutionSourceAttempt = { capability: "network-host", source: "declared-host", value: host };
    result.attemptedSources.push(attempt);
    if (!host) {
      result.unresolvedCapabilities.push({ capability: "network-host", name: "network-host:<empty>", reason: "Declared network host is empty", attemptedSources: ["declared-host:<empty>"] });
      continue;
    }
    const network = await networkProbe.probe(host, { timeoutMs });
    result.probeEvidence.push({ capability: "network-host", candidate: host, source: "network", accepted: network.ok, checkedCapabilities: [`network-host:${host}`], failedCapabilities: network.ok ? [] : [`network-host:${host}`], detail: network.detail });
    result.diagnostics.push({ severity: network.ok ? "info" : "error", capability: "network-host", candidate: host, message: network.detail });
    if (!network.ok) {
      result.unresolvedCapabilities.push({ capability: "network-host", name: `network-host:${host}`, reason: `Declared host ${host} is unavailable: ${network.detail}`, attemptedSources: [`declared-host:${host}`] });
    }
  }

  return result;
}
