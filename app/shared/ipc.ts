import type { TandemConfig } from "../../src/config/schema.js";
import type { BuildPlan } from "../../src/orchestrator/artifacts.js";
import type { MachineEvent, OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import type { CostTick } from "../../src/session/cost.js";
import type { Goal } from "../../src/session/goals.js";
import type { SessionEvent } from "../../src/session/store.js";
import type { Schedule } from "../../src/commands/schedule.js";

export type { MachineEvent, OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
export type { Goal } from "../../src/session/goals.js";
export type { Schedule } from "../../src/commands/schedule.js";

export const ipcChannels = {
  ping: "app:ping",
  sessionStart: "session:start",
  pipelineRun: "pipeline:run",
  pipelineAbort: "pipeline:abort",
  permissionRequest: "permission:request",
  permissionRespond: "permission:respond",
  planConfirm: "plan:confirm",
  planRespond: "plan:respond",
  configGet: "config:get",
  configSet: "config:set",
  modelsList: "models:list",
  sessionsList: "sessions:list",
  sessionResume: "session:resume",
  goalsList: "goals:list",
  goalAdd: "goal:add",
  goalComplete: "goal:complete",
  schedulesList: "schedules:list",
  scheduleAdd: "schedule:add",
  scheduleRemove: "schedule:remove",
  dialogPickFolder: "dialog:pickFolder",
  machineEvent: "evt:machine",
  textEvent: "evt:text",
  costEvent: "evt:cost",
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
}

export interface PipelineRunRequest {
  prompt: string;
}

export interface PipelineDoneEvent {
  summary: string;
  takeover: boolean;
}

export interface TextEvent {
  role: "leader" | "worker";
  delta: string;
}

export interface CostTotals {
  leader: CostTick;
  worker: CostTick;
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
  envKey: string;
  available: boolean;
}

export interface SessionResumeRequest {
  id: string;
}

export interface SessionResumeResponse {
  id: string;
  events: SessionEvent[];
  checkpoint?: OrchestrationCheckpoint;
}

export interface GoalAddRequest {
  text: string;
}

export interface GoalCompleteRequest {
  id: number;
}

export interface ScheduleAddRequest {
  cron: string;
  prompt: string;
}

export interface ScheduleRemoveRequest {
  id: string;
}

export interface TandemDesktopApi {
  ping(): Promise<string>;
  startSession(request: SessionStartRequest): Promise<SessionStartResponse>;
  runPipeline(request: PipelineRunRequest): Promise<void>;
  abortPipeline(): Promise<void>;
  getConfig(): Promise<TandemConfig>;
  setConfig(patch: Partial<TandemConfig>): Promise<TandemConfig>;
  listModels(): Promise<ModelListItem[]>;
  listSessions(): Promise<string[]>;
  resumeSession(request: SessionResumeRequest): Promise<SessionResumeResponse>;
  listGoals(): Promise<Goal[]>;
  addGoal(request: GoalAddRequest): Promise<Goal[]>;
  completeGoal(request: GoalCompleteRequest): Promise<Goal[]>;
  listSchedules(): Promise<Schedule[]>;
  addSchedule(request: ScheduleAddRequest): Promise<Schedule[]>;
  removeSchedule(request: ScheduleRemoveRequest): Promise<Schedule[]>;
  pickFolder(): Promise<string | undefined>;
  respondToPermission(response: PermissionResponse): void;
  respondToPlan(response: PlanResponse): void;
  onMachineEvent(callback: (event: MachineEvent) => void): () => void;
  onTextEvent(callback: (event: TextEvent) => void): () => void;
  onCostEvent(callback: (event: CostTotals) => void): () => void;
  onDoneEvent(callback: (event: PipelineDoneEvent) => void): () => void;
  onPermissionRequest(callback: (event: PermissionRequestEvent) => void): () => void;
  onPlanConfirm(callback: (event: PlanConfirmEvent) => void): () => void;
}
