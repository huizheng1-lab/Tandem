/** The two hard boundaries are deliberately named after the existing guards. */
export type SecurityBoundary = "destructive-command-blacklist" | "self-modification-protection";

export interface SecurityBoundaryReport {
  boundary: SecurityBoundary;
  action: string;
  performed: false;
}

export interface SecurityRisk {
  kind: "unpinned-install-url" | "permission-widening" | "protection-disable" | "outside-project-write";
  action: string;
  proceeded: true;
}

/** Base denial used by permission gates, including non-overridable boundaries. */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class SecurityBoundaryError extends PermissionDeniedError {
  readonly report: SecurityBoundaryReport;

  constructor(boundary: SecurityBoundary, action: string) {
    const report: SecurityBoundaryReport = { boundary, action, performed: false };
    const legacyHint = boundary === "destructive-command-blacklist"
      ? " Blocked destructive command."
      : " Tandem will not modify its own installation. Pick a different project folder.";
    super(`Security boundary reached: ${boundary}. The requested action "${action}" was not performed.${legacyHint}`);
    this.name = "SecurityBoundaryError";
    this.report = report;
  }
}

/** Classify softer concerns without changing whether an explicit request runs. */
export function securityRiskFor(action: string, target: string): SecurityRisk | undefined {
  const value = `${action} ${target}`;
  if (/\b(?:npm|pip|python(?:3)?\s+-m\s+pip)\s+install\s+https?:\/\//i.test(value)) {
    return { kind: "unpinned-install-url", action: target, proceeded: true };
  }
  if (/\b(?:chmod|icacls|setfacl|grant|allow)\b/i.test(value)) {
    return { kind: "permission-widening", action: target, proceeded: true };
  }
  if (/\b(?:disable|turn\s+off)\b.*\b(?:protection|guard|sandbox)\b/i.test(value)) {
    return { kind: "protection-disable", action: target, proceeded: true };
  }
  return undefined;
}

export function securityBoundarySummary(report: SecurityBoundaryReport): string {
  return `Security boundary reached: ${report.boundary}. The requested action "${report.action}" was not performed.`;
}
