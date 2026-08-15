import type { SessionMetadata, SessionResumeResponse, SessionStartResponse } from "../../shared/ipc.js";
import type { TandemConfig } from "../../../src/config/schema.js";
import type { MachineEvent, OrchestrationCheckpoint } from "../../../src/orchestrator/machine.js";
import type { SessionEvent } from "../../../src/session/store.js";
import { taskOutcomeFromDone, TASK_STALL_THRESHOLD_MS, type TaskOutcomeStatus } from "../../../src/task-outcome-status.js";

export const MODEL_STALL_WARNING_SECONDS = TASK_STALL_THRESHOLD_MS / 1000;

export { TASK_STALL_THRESHOLD_MS, isTaskStale, type TaskOutcomeStatus } from "../../../src/task-outcome-status.js";

export type TranscriptRole = "user" | "leader" | "worker" | "system";

export type VisibleTranscriptEntry =
  | { id: number; kind: "message"; role: TranscriptRole; text: string; thinking?: boolean }
  | { id: number; kind: "artifact"; name: string; value: unknown; open: boolean };

export const THINKING_STATUS_TEXT = "Thinking";

export function isVisibleLiveTextRole(role: "leader" | "worker"): role is "leader" {
  return role === "leader";
}

export interface VisibleSessionReplay {
  entries: VisibleTranscriptEntry[];
  checkpoint?: OrchestrationCheckpoint;
  taskStatus?: TaskOutcomeStatus;
}

type TranscriptEntryWithOptionalMessageFields = {
  id: number;
  kind: string;
  role?: unknown;
  text?: unknown;
  thinking?: unknown;
};

export function sessionFromResume(response: SessionResumeResponse): SessionStartResponse {
  return {
    projectDir: response.projectDir,
    sessionId: response.id,
    config: response.config,
    defaultProject: false,
    projectSummary: response.projectSummary,
    projectConfigOverrides: response.projectConfigOverrides,
    projectInstructions: response.projectInstructions
  };
}

export function needsProjectPickForSession(session: SessionStartResponse | undefined): boolean {
  return !session || Boolean(session.defaultProject);
}

export function effectiveRendererConfig(session: Pick<SessionStartResponse, "config"> | undefined, config: TandemConfig | undefined): TandemConfig | undefined {
  return config ?? session?.config;
}

export function isSessionActionable(item: Pick<SessionMetadata, "projectDir">): boolean {
  return Boolean(item.projectDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendAgentText(entries: VisibleTranscriptEntry[], role: "leader" | "worker", delta: string, nextId: () => number, boundText: (text: string) => string): void {
  if (!delta.trim()) return;
  const last = entries.at(-1);
  if (last?.kind === "message" && last.role === role && !last.thinking) {
    last.text = boundText(`${last.text}${delta}`);
  } else {
    entries.push({ id: nextId(), kind: "message", role, text: boundText(delta) });
  }
}

export function appendThinkingStatus<T extends TranscriptEntryWithOptionalMessageFields>(entries: T[], role: "leader" | "worker", nextId: () => number): void {
  const last = entries.at(-1);
  if (last?.kind === "message" && last.role === role && last.thinking && last.text === THINKING_STATUS_TEXT) return;
  entries.push({ id: nextId(), kind: "message", role, text: THINKING_STATUS_TEXT, thinking: true } as T);
}

export function replayVisibleSessionEvents(
  events: SessionEvent[],
  nextId: () => number,
  boundText: (text: string) => string = (text) => text
): VisibleSessionReplay {
  const entries: VisibleTranscriptEntry[] = [];
  let checkpoint: OrchestrationCheckpoint | undefined;
  let taskStatus: TaskOutcomeStatus | undefined;

  for (const stored of events) {
    const payload = stored.payload;
    if (stored.type === "thinking" && isRecord(payload) && (payload.role === "leader" || payload.role === "worker")) {
      appendThinkingStatus(entries, payload.role, nextId);
      continue;
    }
    if (stored.type === "thinking") continue;
    if (stored.type === "user" && isRecord(payload) && typeof payload.prompt === "string") {
      entries.push({ id: nextId(), kind: "message", role: "user", text: boundText(payload.prompt) });
    }
    if (stored.type === "text" && isRecord(payload) && payload.role === "leader" && typeof payload.delta === "string") {
      appendAgentText(entries, payload.role, payload.delta, nextId, boundText);
    }
    if (stored.type === "text" && isRecord(payload) && payload.role === "worker" && typeof payload.delta === "string" && payload.delta) {
      appendThinkingStatus(entries, payload.role, nextId);
    }
    if (stored.type === "machine" && isRecord(payload)) {
      const event = payload as MachineEvent;
      if (event.type === "artifact") entries.push({ id: nextId(), kind: "artifact", name: event.name, value: event.value, open: false });
      if (event.type === "checkpoint") checkpoint = event.checkpoint;
      if (event.type === "error") taskStatus = "failed";
    }
    if (stored.type === "done" && isRecord(payload) && typeof payload.summary === "string") {
      taskStatus = taskOutcomeFromDone(payload);
    }
  }

  if (!taskStatus && checkpoint?.phase === "DONE") {
    const report = checkpoint.reports.at(-1);
    const verdict = checkpoint.verdicts.at(-1)?.verdict;
    taskStatus = report?.status === "complete" && (verdict === undefined || verdict === "approve") ? "successful" : "failed";
  }
  return { entries, checkpoint, taskStatus };
}
