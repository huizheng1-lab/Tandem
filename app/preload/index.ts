import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type TandemDesktopApi } from "../shared/ipc.js";
import type {
  MachineEvent,
  PipelineDoneEvent,
  PermissionRequestEvent,
  PermissionResponse,
  PlanConfirmEvent,
  PlanResponse,
  TextEvent
} from "../shared/ipc.js";

function on<T>(channel: string, callback: (event: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api: TandemDesktopApi = {
  ping: () => ipcRenderer.invoke(ipcChannels.ping),
  startSession: (request) => ipcRenderer.invoke(ipcChannels.sessionStart, request),
  runPipeline: (request) => ipcRenderer.invoke(ipcChannels.pipelineRun, request),
  abortPipeline: () => ipcRenderer.invoke(ipcChannels.pipelineAbort),
  getConfig: () => ipcRenderer.invoke(ipcChannels.configGet),
  setConfig: (patch) => ipcRenderer.invoke(ipcChannels.configSet, patch),
  listModels: () => ipcRenderer.invoke(ipcChannels.modelsList),
  listSessions: () => ipcRenderer.invoke(ipcChannels.sessionsList),
  resumeSession: (request) => ipcRenderer.invoke(ipcChannels.sessionResume, request),
  pickFolder: () => ipcRenderer.invoke(ipcChannels.dialogPickFolder),
  respondToPermission: (response: PermissionResponse) => ipcRenderer.send(ipcChannels.permissionRespond, response),
  respondToPlan: (response: PlanResponse) => ipcRenderer.send(ipcChannels.planRespond, response),
  onMachineEvent: (callback) => on<MachineEvent>(ipcChannels.machineEvent, callback),
  onTextEvent: (callback) => on<TextEvent>(ipcChannels.textEvent, callback),
  onCostEvent: (callback) => on(ipcChannels.costEvent, callback),
  onDoneEvent: (callback) => on<PipelineDoneEvent>(ipcChannels.doneEvent, callback),
  onPermissionRequest: (callback) => on<PermissionRequestEvent>(ipcChannels.permissionRequest, callback),
  onPlanConfirm: (callback) => on<PlanConfirmEvent>(ipcChannels.planConfirm, callback)
};

contextBridge.exposeInMainWorld("tandem", api);
