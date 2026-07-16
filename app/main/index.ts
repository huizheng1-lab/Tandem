import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ipcChannels } from "../shared/ipc.js";
import { TandemService } from "./tandem-service.js";
import { startupErrorInfo } from "./startup-error.js";
import type { StartupErrorInfo } from "../shared/ipc.js";
import { parseDesktopLaunchOptions } from "./launch-options.js";
import { startAutomationServer, type AutomationServerHandle } from "./automation-server.js";
import type {
  AttachmentAddDataRequest,
  AttachmentAddFilesRequest,
  GoalAddRequest,
  GoalCompleteRequest,
  MemoryAddRequest,
  MemoryRemoveRequest,
  PipelineRunRequest,
  ScheduleAddRequest,
  ScheduleRemoveRequest,
  SessionAutoApproveRequest,
  SessionArchiveRequest,
  SessionDeleteRequest,
  SessionRenameRequest,
  SessionResumeRequest,
  SessionStartRequest
} from "../shared/ipc.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const launchOptions = parseDesktopLaunchOptions();
process.env.TANDEM_PROTECTED_ROOTS = [
  process.env.TANDEM_PROTECTED_ROOTS,
  app.getAppPath(),
  path.dirname(process.execPath),
  path.resolve(currentDir, "..")
]
  .filter(Boolean)
  .join(path.delimiter);

let mainWindow: BrowserWindow | undefined;
let service: TandemService | undefined;
let startupError: StartupErrorInfo | undefined;
let automationServer: AutomationServerHandle | undefined;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#101114",
    title: "Tandem",
    show: !launchOptions.hidden,
    skipTaskbar: launchOptions.hidden,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(currentDir, "../preload/index.js")
    }
  });
  try {
    service = new TandemService(mainWindow);
    startupError = undefined;
  } catch (error) {
    service = undefined;
    startupError = startupErrorInfo(error);
    console.error(startupError.message);
    if (!launchOptions.hidden) dialog.showErrorBox(startupError.title, startupError.message);
  }

  if (service && launchOptions.automation) {
    void startAutomationServer({
      ...launchOptions.automation,
      instanceId: process.env.TANDEM_INSTANCE_ID,
      service
    }).then((server) => {
      automationServer = server;
      console.log(`Tandem automation ready on 127.0.0.1:${server.port}`);
    }).catch((error: unknown) => {
      console.error(`Tandem automation failed: ${String(error)}`);
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(currentDir, "../renderer/index.html"));
  }
}

ipcMain.handle(ipcChannels.ping, () => "pong");
ipcMain.handle(ipcChannels.startupErrorGet, () => startupError);
ipcMain.handle(ipcChannels.sessionStart, (_event, request: SessionStartRequest) => {
  return service?.startSession(request);
});
ipcMain.handle(ipcChannels.pipelineRun, async (_event, request: PipelineRunRequest) => {
  await service?.run(request.prompt, request.attachments ?? []);
});
ipcMain.handle(ipcChannels.pipelineAbort, () => {
  service?.abort();
});
ipcMain.handle(ipcChannels.attachmentAddFiles, (_event, request: AttachmentAddFilesRequest) => service?.addAttachmentFiles(request.paths));
ipcMain.handle(ipcChannels.attachmentAddData, (_event, request: AttachmentAddDataRequest) => service?.addAttachmentData(request.name, request.data));
ipcMain.handle(ipcChannels.appStateGet, () => service?.getAppState());
ipcMain.handle(ipcChannels.configGet, () => service?.getConfig());
ipcMain.handle(ipcChannels.configSet, (_event, patch) => service?.setConfig(patch));
ipcMain.handle(ipcChannels.modelsList, () => service?.listModels());
ipcMain.handle(ipcChannels.sessionsList, () => service?.listSessions());
ipcMain.handle(ipcChannels.sessionResume, (_event, request: SessionResumeRequest) => service?.resumeSession(request.id));
ipcMain.handle(ipcChannels.sessionCompact, () => service?.compactSession());
ipcMain.handle(ipcChannels.sessionRename, (_event, request: SessionRenameRequest) => service?.renameSession(request.id, request.title));
ipcMain.handle(ipcChannels.sessionArchive, (_event, request: SessionArchiveRequest) => service?.archiveSession(request.id, request.archived));
ipcMain.handle(ipcChannels.sessionDelete, (_event, request: SessionDeleteRequest) => service?.deleteSession(request.id));
ipcMain.handle(ipcChannels.goalsList, () => service?.listGoals());
ipcMain.handle(ipcChannels.goalAdd, (_event, request: GoalAddRequest) => service?.addGoal(request.text));
ipcMain.handle(ipcChannels.goalComplete, (_event, request: GoalCompleteRequest) => service?.completeGoal(request.id));
ipcMain.handle(ipcChannels.goalClear, () => service?.clearGoals());
ipcMain.handle(ipcChannels.memoryList, () => service?.listMemory());
ipcMain.handle(ipcChannels.memoryAdd, (_event, request: MemoryAddRequest) => service?.addMemory(request.text));
ipcMain.handle(ipcChannels.memoryRemove, (_event, request: MemoryRemoveRequest) => service?.removeMemory(request.id));
ipcMain.handle(ipcChannels.schedulesList, () => service?.listSchedules());
ipcMain.handle(ipcChannels.scheduleAdd, (_event, request: ScheduleAddRequest) => service?.addSchedule(request.cron, request.prompt));
ipcMain.handle(ipcChannels.scheduleRemove, (_event, request: ScheduleRemoveRequest) => service?.removeSchedule(request.id));
ipcMain.handle(ipcChannels.permissionSessionAutoApproveSet, (_event, request: SessionAutoApproveRequest) => service?.setSessionAutoApprove(request.mode));
ipcMain.handle(ipcChannels.dialogPickFolder, async () => {
  if (!mainWindow) return undefined;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || launchOptions.hidden) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void automationServer?.close();
    automationServer = undefined;
  });
}

async function recordFatal(error: unknown): Promise<void> {
  try {
    await service?.recordCrash(error);
  } finally {
    console.error(String(error));
  }
}

process.on("uncaughtException", (error) => {
  void recordFatal(error).finally(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (error) => {
  void recordFatal(error);
});
