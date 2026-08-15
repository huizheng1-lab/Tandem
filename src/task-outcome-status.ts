import type { MachineEvent, RunResult } from "./orchestrator/machine.js";

export type TaskOutcomeStatus = "successful" | "failed" | "hung";

/** Reuse the existing renderer stall window for both live surfaces. */
export const TASK_STALL_THRESHOLD_MS = 180_000;

export function isTaskStale(lastActivityAt: number, now = Date.now(), thresholdMs = TASK_STALL_THRESHOLD_MS): boolean {
  return now - lastActivityAt >= thresholdMs;
}

export function taskOutcomeFromRun(result: RunResult): TaskOutcomeStatus {
  const report = result.reports.at(-1);
  const verdict = result.verdicts.at(-1)?.verdict;
  if (result.phase !== "DONE" || report?.status !== "complete" || (verdict !== undefined && verdict !== "approve")) return "failed";
  return "successful";
}

export function taskOutcomeFromMachineEvent(event: MachineEvent): TaskOutcomeStatus | undefined {
  if (event.type === "error") return "failed";
  return undefined;
}

export function taskOutcomeFromDone(payload: { outcome?: unknown; error?: unknown }): TaskOutcomeStatus {
  if (payload.outcome === "successful" || payload.outcome === "failed" || payload.outcome === "hung") return payload.outcome;
  return payload.error === true ? "failed" : "successful";
}
