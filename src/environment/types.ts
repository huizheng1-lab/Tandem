/** Executable names are intentionally open-ended. The named runtimes below are
 * richer requests, not an access allowlist. */
export type ExecutableCapability = string;

export type RequestedCapability =
  | { kind: "python"; modules?: string[]; minimumVersion?: string }
  | { kind: "node"; minimumVersion?: string }
  | { kind: "ffmpeg" }
  | { kind: "ffprobe" }
  | { kind: "codex-sandbox-helper" }
  | { kind: "executable"; name: string }
  | { kind: "network-host"; host: string };

export type ResolutionSource = "override" | "path" | "installed-runtime" | "registered-directory" | "declared-host";

export interface ResolutionSourceAttempt {
  capability: string;
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
  capability: string;
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
  capability: string;
  name: string;
  reason: string;
  attemptedSources: string[];
}

export interface ResolutionDiagnostic {
  severity: "info" | "warning" | "error";
  capability: string;
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
  installEvidence?: InstallEvidence[];
}

export interface InstallEvidence {
  executable: string;
  packageManager: "npm" | "pip";
  source: string;
  command: string;
  requestedBy: string;
  status: "started" | "completed" | "failed" | "blocked";
  detail?: string;
}
