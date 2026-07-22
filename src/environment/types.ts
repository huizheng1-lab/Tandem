export type ExecutableCapability = "python" | "node" | "ffmpeg" | "ffprobe" | "codex-sandbox-helper";

export type RequestedCapability =
  | { kind: "python"; modules?: string[]; minimumVersion?: string }
  | { kind: "node"; minimumVersion?: string }
  | { kind: "ffmpeg" }
  | { kind: "ffprobe" }
  | { kind: "codex-sandbox-helper" }
  | { kind: "network-host"; host: string };

export type ResolutionSource = "override" | "path" | "installed-runtime" | "registered-directory" | "declared-host";

export interface ResolutionSourceAttempt {
  capability: RequestedCapability["kind"];
  source: ResolutionSource;
  value: string;
}

export interface ProcessProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

export interface CandidateProbeEvidence {
  capability: RequestedCapability["kind"];
  candidate?: string;
  source: ResolutionSource | "network";
  accepted: boolean;
  version?: string;
  checkedCapabilities: string[];
  failedCapabilities: string[];
  detail: string;
}

export interface ResolvedTool {
  capability: ExecutableCapability;
  executablePath: string;
  source: ResolutionSource;
  version?: string;
  pythonModules?: string[];
}

export interface UnresolvedCapability {
  capability: RequestedCapability["kind"];
  name: string;
  reason: string;
  attemptedSources: string[];
}

export interface ResolutionDiagnostic {
  severity: "info" | "warning" | "error";
  capability: RequestedCapability["kind"];
  message: string;
  candidate?: string;
}

export interface ResolvedEnvironment {
  requestedCapabilities: RequestedCapability[];
  tools: Partial<Record<ExecutableCapability, ResolvedTool>>;
  probeEvidence: CandidateProbeEvidence[];
  unresolvedCapabilities: UnresolvedCapability[];
  attemptedSources: ResolutionSourceAttempt[];
  diagnostics: ResolutionDiagnostic[];
}
