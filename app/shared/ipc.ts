import type { TandemConfig } from "../../src/config/schema.js";
import type { BuildPlan } from "../../src/orchestrator/artifacts.js";
import type { MachineEvent, OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import type { CostTick } from "../../src/session/cost.js";
import type { Goal } from "../../src/session/goals.js";
import type { AttachmentRef } from "../../src/session/attachments.js";
import type { SessionMemoryNote } from "../../src/session/memory.js";
import type { SessionEvent, SessionMetadata } from "../../src/session/store.js";
import type { Schedule } from "../../src/commands/schedule.js";
import type { ToolActivityEvent } from "../../src/tools/fs.js";

export type { MachineEvent, OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
export type { Goal } from "../../src/session/goals.js";
export type { AttachmentRef } from "../../src/session/attachments.js";
export type { SessionMemoryNote } from "../../src/session/memory.js";
export type { Schedule } from "../../src/commands/schedule.js";
export type { SessionMetadata } from "../../src/session/store.js";
export type { ToolActivityEvent } from "../../src/tools/fs.js";

export const ipcChannels = {
  ping: "app:ping",
  startupErrorGet: "startup-error:get",
  sessionStart: "session:start",
  pipelineRun: "pipeline:run",
  pipelineAbort: "pipeline:abort",
  attachmentAddFiles: "attachment:add-files",
  attachmentAddData: "attachment:add-data",
  permissionRequest: "permission:request",
  permissionRespond: "permission:respond",
  planConfirm: "plan:confirm",
  planRespond: "plan:respond",
  configGet: "config:get",
  configSet: "config:set",
  appStateGet: "app-state:get",
  modelsList: "models:list",
  sessionsList: "sessions:list",
  sessionResume: "session:resume",
  sessionCompact: "session:compact",
  sessionRename: "session:rename",
  sessionArchive: "session:archive",
  sessionDelete: "session:delete",
  goalsList: "goals:list",
  goalAdd: "goal:add",
  goalComplete: "goal:complete",
  goalClear: "goal:clear",
  memoryList: "memory:list",
  memoryAdd: "memory:add",
  memoryRemove: "memory:remove",
  schedulesList: "schedules:list",
  scheduleAdd: "schedule:add",
  scheduleRemove: "schedule:remove",
  remoteControlGet: "remote-control:get",
  remoteControlEnable: "remote-control:enable",
  remoteControlRevoke: "remote-control:revoke",
  permissionSessionAutoApproveSet: "permission:auto-approve:set",
  dialogPickFolder: "dialog:pickFolder",
  machineEvent: "evt:machine",
  textEvent: "evt:text",
  costEvent: "evt:cost",
  toolEvent: "evt:tool",
  memoryEvent: "evt:memory",
  remoteControlEvent: "evt:remote-control",
  doneEvent: "evt:done"
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

export interface SessionStartRequest {
  projectDir?: string;
}

export interface SessionStartResponse {
  projectDir: string;
  sessionId: string;
  config: TandemConfig;
  defaultProject: boolean;
  projectSummary: string;
  projectConfigOverrides?: Array<keyof TandemConfig>;
  projectInstructions?: { fileName: string; chars: number; truncated: boolean };
}

export interface DesktopAppStateResponse {
  projectDir: string;
  lastProjectDir?: string;
  config: TandemConfig;
  projectSummary: string;
}

export interface StartupErrorInfo {
  title: string;
  message: string;
}

export interface PipelineRunRequest {
  prompt: string;
  attachments?: AttachmentRef[];
}

export interface MissingKeyInfo {
  key: string;
  model: string;
  projectEnvPath: string;
  globalEnvPath: string;
}

export interface PipelineDoneEvent {
  summary: string;
  takeover: boolean;
  error?: boolean;
  missingKey?: MissingKeyInfo;
}

export interface TextEvent {
  role: "leader" | "worker";
  delta: string;
  thinking?: boolean;
}

export interface CostTotals {
  leader: CostTick;
  worker: CostTick;
  cumulative?: { leader: CostTick; worker: CostTick };
}

export interface PermissionRequestEvent {
  id: string;
  action: "write" | "edit" | "bash";
  target: string;
}

export interface PermissionResponse {
  id: string;
  approved: boolean;
}

export type SessionAutoApproveMode = "none" | "edits" | "all";

export interface SessionAutoApproveRequest {
  mode: SessionAutoApproveMode;
}

export interface PlanConfirmEvent {
  id: string;
  plan: BuildPlan;
}

export interface PlanResponse {
  id: string;
  approved: boolean;
}

export interface ModelListItem {
  id: string;
  provider: string;
  modelName: string;
  envKey?: string;
  available: boolean;
  media?: { images?: boolean; pdf?: boolean };
  costHints?: { inputPerMillion: number; outputPerMillion: number };
}

export interface AttachmentAddFilesRequest {
  paths: string[];
}

export interface AttachmentAddDataRequest {
  name: string;
  data: Uint8Array;
}

export interface SessionResumeRequest {
  id: string;
}

export interface SessionResumeResponse {
  id: string;
  projectDir: string;
  config: TandemConfig;
  defaultProject: boolean;
  projectSummary: string;
  projectConfigOverrides?: Array<keyof TandemConfig>;
  projectInstructions?: { fileName: string; chars: number; truncated: boolean };
  events: SessionEvent[];
  eventsTruncated?: boolean;
  checkpoint?: OrchestrationCheckpoint;
  cost?: CostTotals;
}

export interface SessionRenameRequest {
  id: string;
  title: string;
}

export interface SessionArchiveRequest {
  id: string;
  archived: boolean;
}

export interface SessionDeleteRequest {
  id: string;
}

export interface SessionDeleteResponse {
  sessions: SessionMetadata[];
  activeSession?: SessionStartResponse;
}

export interface SessionCompactResponse {
  summary: string;
  compactedTurns: number;
}

export interface GoalAddRequest {
  text: string;
}

export interface GoalCompleteRequest {
  id: number;
}

export interface MemoryAddRequest {
  text: string;
}

export interface MemoryRemoveRequest {
  id: string;
}

export interface MemoryEvent {
  notes: SessionMemoryNote[];
}

export interface ScheduleAddRequest {
  cron: string;
  prompt: string;
}

export interface ScheduleRemoveRequest {
  id: string;
}

export interface RemoteControlState {
  configured: boolean;
  enabled: boolean;
  polling: boolean;
  paired: boolean;
  pairedUserId?: string;
  pairingCode?: string;
  pairingExpiresAt?: string;
  lastError?: string;
}

export interface TandemDesktopApi {
  ping(): Promise<string>;
  getStartupError(): Promise<StartupErrorInfo | undefined>;
  startSession(request: SessionStartRequest): Promise<SessionStartResponse>;
  runPipeline(request: PipelineRunRequest): Promise<void>;
  abortPipeline(): Promise<void>;
  addAttachmentFiles(request: AttachmentAddFilesRequest): Promise<AttachmentRef[]>;
  addAttachmentData(request: AttachmentAddDataRequest): Promise<AttachmentRef>;
  getAppState(): Promise<DesktopAppStateResponse>;
  getConfig(): Promise<TandemConfig>;
  setConfig(patch: Partial<TandemConfig>): Promise<TandemConfig>;
  listModels(): Promise<ModelListItem[]>;
  listSessions(): Promise<SessionMetadata[]>;
  resumeSession(request: SessionResumeRequest): Promise<SessionResumeResponse>;
  compactSession(): Promise<SessionCompactResponse | undefined>;
  renameSession(request: SessionRenameRequest): Promise<SessionMetadata[]>;
  archiveSession(request: SessionArchiveRequest): Promise<SessionMetadata[]>;
  deleteSession(request: SessionDeleteRequest): Promise<SessionDeleteResponse>;
  listGoals(): Promise<Goal[]>;
  addGoal(request: GoalAddRequest): Promise<Goal[]>;
  completeGoal(request: GoalCompleteRequest): Promise<Goal[]>;
  clearGoals(): Promise<number>;
  listMemory(): Promise<SessionMemoryNote[]>;
  addMemory(request: MemoryAddRequest): Promise<SessionMemoryNote[]>;
  removeMemory(request: MemoryRemoveRequest): Promise<SessionMemoryNote[]>;
  listSchedules(): Promise<Schedule[]>;
  addSchedule(request: ScheduleAddRequest): Promise<Schedule[]>;
  removeSchedule(request: ScheduleRemoveRequest): Promise<Schedule[]>;
  getRemoteControl(): Promise<RemoteControlState>;
  enableRemoteControl(): Promise<RemoteControlState>;
  revokeRemoteControl(): Promise<RemoteControlState>;
  setSessionAutoApprove(request: SessionAutoApproveRequest): Promise<SessionAutoApproveMode>;
  pickFolder(): Promise<string | undefined>;
  respondToPermission(response: PermissionResponse): void;
  respondToPlan(response: PlanResponse): void;
  onMachineEvent(callback: (event: MachineEvent) => void): () => void;
  onTextEvent(callback: (event: TextEvent) => void): () => void;
  onToolEvent(callback: (event: ToolActivityEvent) => void): () => void;
  onMemoryEvent(callback: (event: MemoryEvent) => void): () => void;
  onRemoteControlEvent(callback: (event: RemoteControlState) => void): () => void;
  onCostEvent(callback: (event: CostTotals) => void): () => void;
  onDoneEvent(callback: (event: PipelineDoneEvent) => void): () => void;
  onPermissionRequest(callback: (event: PermissionRequestEvent) => void): () => void;
  onPlanConfirm(callback: (event: PlanConfirmEvent) => void): () => void;
}
