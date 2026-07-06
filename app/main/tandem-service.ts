import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { BrowserWindow, ipcMain } from "electron";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { loadConfig, loadConfigDetails, loadEnv, saveGlobalConfigPatch, saveProjectConfig } from "../../src/config/load.js";
import type { TandemConfig } from "../../src/config/schema.js";
import { createLiveAgents } from "../../src/agents/live.js";
import { createDiffTracker } from "../../src/orchestrator/diff.js";
import { runOrchestration, type MachineEvent, type OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import { modelRegistry } from "../../src/providers/registry.js";
import { tandemStateDir } from "../../src/paths.js";
import { CostLedger } from "../../src/session/cost.js";
import { copyAttachment, formatAttachmentBlock, writeAttachmentData } from "../../src/session/attachments.js";
import type { AttachmentRef } from "../../src/session/attachments.js";
import { addGoal, completeGoal, formatStandingGoals, listGoals } from "../../src/session/goals.js";
import { buildConversationHistory } from "../../src/session/history.js";
import { rebuildLeaderThread } from "../../src/session/leader-thread.js";
import { addNote, formatSessionNotes, removeNote, replaySessionMemory } from "../../src/session/memory.js";
import type { MemoryAuthor, SessionMemoryNote } from "../../src/session/memory.js";
import { appendProjectMemoryNote, formatProjectInstructions, readProjectInstructions } from "../../src/session/project-memory.js";
import { archiveSession, deleteSession, listSessions, renameSession, SessionStore } from "../../src/session/store.js";
import type { SessionMetadata } from "../../src/session/store.js";
import { safeDefaultProjectDir } from "../../src/tools/protection.js";
import type { PermissionBridge, PermissionRequest } from "../../src/tools/permissions.js";
import { addSchedule, listSchedules, markScheduleRun, removeSchedule } from "../../src/commands/schedule.js";
import type { Schedule } from "../../src/commands/schedule.js";
import {
  ipcChannels,
  type CostTotals,
  type DesktopAppStateResponse,
  type MemoryEvent,
  type MissingKeyInfo,
  type PermissionRequestEvent,
  type PermissionResponse,
  type PlanConfirmEvent,
  type PlanResponse,
  type SessionAutoApproveMode,
  type SessionDeleteResponse,
  type SessionResumeResponse,
  type ToolActivityEvent,
  type SessionStartRequest,
  type SessionStartResponse
} from "../shared/ipc.js";

type PendingResolver = (approved: boolean) => void;
type DesktopWindow = Pick<BrowserWindow, "webContents">;
type SessionLike = Pick<SessionStore, "id" | "append" | "read">;

interface DesktopAppState {
  lastProjectDir?: string;
}

function desktopAppStatePath(homeDir?: string): string {
  return path.join(tandemStateDir(homeDir), "desktop-state.json");
}

function readDesktopAppState(homeDir?: string): DesktopAppState {
  const filePath = desktopAppStatePath(homeDir);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as DesktopAppState;
    const lastProjectDir = typeof parsed.lastProjectDir === "string" && existsSync(parsed.lastProjectDir) ? parsed.lastProjectDir : undefined;
    return { lastProjectDir };
  } catch {
    return {};
  }
}

async function writeDesktopAppState(homeDir: string | undefined, state: DesktopAppState): Promise<void> {
  const filePath = desktopAppStatePath(homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function projectSummary(projectDir: string): Promise<string> {
  if (!existsSync(projectDir)) return "folder not created yet";
  const entries = await readdir(projectDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}node_modules${path.sep}`) && !entry.parentPath.includes(`${path.sep}.git${path.sep}`));
  return files.length === 0 ? "empty folder" : `existing project, ${files.length} file${files.length === 1 ? "" : "s"}`;
}

function missingKeyInfo(error: unknown, projectDir: string, homeDir?: string): MissingKeyInfo | undefined {
  const text = String(error);
  const match = /Missing\s+([A-Z0-9_]+)\s+for model\s+(.+?)(?:\.\s+Add|\.$)/.exec(text);
  if (!match) return undefined;
  return {
    key: match[1] ?? "",
    model: match[2] ?? "",
    projectEnvPath: path.join(projectDir, ".env"),
    globalEnvPath: path.join(tandemStateDir(homeDir), ".env")
  };
}

export interface TandemServiceDeps {
  createAgents?: typeof createLiveAgents;
  runOrchestration?: typeof runOrchestration;
  createSession?: (cwd: string) => Promise<SessionLike>;
  openSession?: (id: string, cwd: string) => Promise<SessionLike>;
  registerIpcResponses?: boolean;
  homeDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export class TandemService {
  private projectDir: string;
  private lastProjectDir?: string;
  private readonly homeDir?: string;
  private env: NodeJS.ProcessEnv;
  private config: TandemConfig;
  private projectConfigOverrides: Array<keyof TandemConfig> = [];
  private ledger = new CostLedger();
  private session?: SessionLike;
  private controller?: AbortController;
  private lastCheckpoint?: OrchestrationCheckpoint;
  private readonly pendingPermissions = new Map<string, PendingResolver>();
  private readonly pendingPlans = new Map<string, PendingResolver>();
  private readonly cronTasks = new Map<string, ScheduledTask>();
  private sessionAutoApprove: SessionAutoApproveMode = "none";

  constructor(
    private readonly window: DesktopWindow,
    private readonly deps: TandemServiceDeps = {}
  ) {
    this.homeDir = deps.homeDir;
    this.lastProjectDir = readDesktopAppState(this.homeDir).lastProjectDir;
    this.projectDir = this.lastProjectDir ?? safeDefaultProjectDir(this.homeDir);
    this.env = this.loadProjectEnv(this.projectDir);
    this.config = loadConfig({ cwd: this.projectDir, homeDir: this.homeDir, env: this.env });
    if (deps.registerIpcResponses === false) return;
    ipcMain.on(ipcChannels.permissionRespond, (_event, response: PermissionResponse) => {
      this.resolvePending(this.pendingPermissions, response.id, response.approved);
    });
    ipcMain.on(ipcChannels.planRespond, (_event, response: PlanResponse) => {
      this.resolvePending(this.pendingPlans, response.id, response.approved);
    });
  }

  async startSession(request: SessionStartRequest): Promise<SessionStartResponse> {
    const defaultProject = !request.projectDir;
    this.projectDir = request.projectDir || safeDefaultProjectDir(this.homeDir);
    await mkdir(this.projectDir, { recursive: true });
    if (!defaultProject) {
      this.lastProjectDir = this.projectDir;
      await writeDesktopAppState(this.homeDir, { lastProjectDir: this.projectDir });
    }
    this.env = this.loadProjectEnv(this.projectDir);
    const loaded = loadConfigDetails({ cwd: this.projectDir, homeDir: this.homeDir, env: this.env });
    this.config = loaded.config;
    this.projectConfigOverrides = loaded.projectOverrides;
    this.ledger = new CostLedger();
    this.lastCheckpoint = undefined;
    this.sessionAutoApprove = "none";
    this.session = await (this.deps.createSession ?? ((cwd) => SessionStore.create(cwd, this.homeDir)))(this.projectDir);
    await this.session.append("session:start", { projectDir: this.projectDir });
    await this.refreshCronTasks();
    const projectInstructions = await readProjectInstructions(this.projectDir);
    return {
      projectDir: this.projectDir,
      sessionId: this.session.id,
      config: this.config,
      defaultProject,
      projectSummary: await projectSummary(this.projectDir),
      projectConfigOverrides: this.projectConfigOverrides,
      projectInstructions: projectInstructions
        ? { fileName: projectInstructions.fileName, chars: projectInstructions.chars, truncated: projectInstructions.truncated }
        : undefined
    };
  }

  async run(prompt: string, attachments: AttachmentRef[] = []): Promise<void> {
    if (this.controller) throw new Error("A Tandem run is already active.");
    if (!this.session) await this.startSession({ projectDir: this.projectDir });
    const session = this.session as SessionLike;
    this.controller = new AbortController();
    const sessionEvents = await session.read();
    const history = buildConversationHistory(sessionEvents);
    await this.emitMachine({ type: "notice", message: `context: ${history.priorTurns} prior turn${history.priorTurns === 1 ? "" : "s"}` });
    if (history.truncated) await this.emitMachine({ type: "notice", message: "including last 10 turns of context" });
    const attachmentBlock = formatAttachmentBlock(attachments);
    const promptWithAttachments = attachmentBlock ? `${prompt}\n\n${attachmentBlock}` : prompt;
    await session.append("user", { prompt: promptWithAttachments, attachments });
    const initialState = this.lastCheckpoint?.phase === "DONE" ? undefined : this.lastCheckpoint;
    this.lastCheckpoint = undefined;

    try {
      const diffTracker = createDiffTracker(this.projectDir);
      const permissionBridge: PermissionBridge = {
        approve: (request) => this.requestPermission(request)
      };
      const agents = await (this.deps.createAgents ?? createLiveAgents)({
        config: this.config,
        cwd: this.projectDir,
        env: this.env,
        ledger: this.ledger,
        permissionBridge,
        recordTouchedPath: (filePath) => diffTracker.recordTouchedPath(filePath),
        abortSignal: this.controller.signal,
        onLeaderText: (delta) => void this.emitText("leader", delta),
        onWorkerText: (delta) => void this.emitText("worker", delta),
        onLeaderThinking: (delta) => void this.emitText("leader", delta, true),
        onWorkerThinking: (delta) => void this.emitText("worker", delta, true),
        onToolEvent: (event) => void this.emitTool(event),
        projectInstructions: () => this.currentProjectInstructions(),
        rememberNote: (text, by) => this.rememberProjectNote(text, by),
        leaderThread: rebuildLeaderThread(sessionEvents),
        onLeaderCompaction: (event) => this.recordLeaderCompaction(event),
        onTriage: (kind) => this.emitMachine({ type: "notice", message: `triage: ${kind}` })
      });
      const goals = formatStandingGoals((await listGoals(this.projectDir)).filter((goal) => goal.status === "active"));
      const result = await (this.deps.runOrchestration ?? runOrchestration)({
        request: promptWithAttachments,
        config: this.config,
        agents,
        goals,
        history: history.text,
        attachments,
        diffProvider: diffTracker,
        initialState,
        confirmPlan: (plan) => this.confirmPlan(plan),
        emit: (event) => void this.emitMachine(event)
      });
      const done = { summary: result.summary, takeover: result.takeover };
      this.window.webContents.send(ipcChannels.doneEvent, done);
      await session.append("done", done);
      this.lastCheckpoint = undefined;
    } catch (error) {
      const event: MachineEvent = { type: "error", message: String(error) };
      const done = { summary: event.message, takeover: false, error: true, missingKey: missingKeyInfo(error, this.projectDir, this.homeDir) };
      this.window.webContents.send(ipcChannels.machineEvent, event);
      this.window.webContents.send(ipcChannels.doneEvent, done);
      await session.append("machine", event);
      await session.append("done", done);
      this.lastCheckpoint = undefined;
    } finally {
      this.controller = undefined;
    }
  }

  abort(): void {
    this.controller?.abort();
  }

  getConfig(): TandemConfig {
    return this.config;
  }

  async getAppState(): Promise<DesktopAppStateResponse> {
    return {
      projectDir: this.projectDir,
      lastProjectDir: this.lastProjectDir,
      config: this.config,
      projectSummary: await projectSummary(this.projectDir)
    };
  }

  async setConfig(patch: Partial<TandemConfig>): Promise<TandemConfig> {
    this.config = { ...this.config, ...patch };
    await saveGlobalConfigPatch(patch, this.homeDir);
    if (this.session) await saveProjectConfig(this.config, this.projectDir);
    return this.config;
  }

  listModels() {
    return modelRegistry(this.config.customModels).map((model) => ({
      id: model.id,
      provider: model.provider,
      modelName: model.modelName,
      envKey: model.envKey,
      available: Boolean(this.env[model.envKey]),
      media: model.media
    }));
  }

  async addAttachmentFiles(paths: string[]): Promise<AttachmentRef[]> {
    return Promise.all(paths.map((filePath) => copyAttachment(this.projectDir, filePath)));
  }

  addAttachmentData(name: string, data: Uint8Array): Promise<AttachmentRef> {
    return writeAttachmentData(this.projectDir, name, data);
  }

  listSessions(): Promise<SessionMetadata[]> {
    return listSessions(this.projectDir, this.homeDir);
  }

  async resumeSession(id: string): Promise<SessionResumeResponse> {
    let store: SessionLike;
    try {
      store = await (this.deps.openSession ?? ((sessionId, cwd) => SessionStore.open(sessionId, cwd, this.homeDir)))(id, this.projectDir);
    } catch (error) {
      if (/No session .*Run \/sessions to list sessions/.test(String(error))) {
        throw new Error("This session belongs to a different project folder - pick that folder to open it.");
      }
      throw error;
    }
    const events = await store.read();
    this.session = store;
    const checkpoint = this.findLastCheckpoint(events.map((event) => event.payload));
    this.lastCheckpoint = checkpoint?.phase === "DONE" ? undefined : checkpoint;
    return { id, events, checkpoint: this.lastCheckpoint };
  }

  async renameSession(id: string, title: string): Promise<SessionMetadata[]> {
    await renameSession(id, title, this.projectDir, this.homeDir);
    return this.listSessions();
  }

  async archiveSession(id: string, archived: boolean): Promise<SessionMetadata[]> {
    await archiveSession(id, archived, this.projectDir, this.homeDir);
    return this.listSessions();
  }

  async deleteSession(id: string): Promise<SessionDeleteResponse> {
    const wasActive = this.session?.id === id;
    if (wasActive) {
      this.session = undefined;
      this.lastCheckpoint = undefined;
    }
    await deleteSession(id, this.projectDir, this.homeDir);
    if (!wasActive) return { sessions: await this.listSessions() };
    const activeSession = await this.startSession({ projectDir: this.projectDir });
    return { sessions: await this.listSessions(), activeSession };
  }

  async recordCrash(error: unknown): Promise<void> {
    const event: MachineEvent = { type: "error", message: `Desktop process crash: ${String(error)}` };
    this.window.webContents.send(ipcChannels.machineEvent, event);
    await this.session?.append("crash", event);
  }

  listGoals() {
    return listGoals(this.projectDir);
  }

  async addGoal(text: string) {
    await addGoal(text, this.projectDir);
    return this.listGoals();
  }

  async completeGoal(id: number) {
    await completeGoal(id, this.projectDir);
    return this.listGoals();
  }

  async listMemory(): Promise<SessionMemoryNote[]> {
    if (!this.session) return [];
    return replaySessionMemory(await this.session.read());
  }

  async addMemory(text: string): Promise<SessionMemoryNote[]> {
    if (!this.session) await this.startSession({ projectDir: this.projectDir });
    await addNote(this.session as SessionLike, text, "user");
    return this.emitMemory();
  }

  async removeMemory(id: string): Promise<SessionMemoryNote[]> {
    if (!this.session) return [];
    await removeNote(this.session, id);
    return this.emitMemory();
  }

  listSchedules(): Promise<Schedule[]> {
    return listSchedules(this.projectDir);
  }

  async addSchedule(cronExpression: string, prompt: string): Promise<Schedule[]> {
    await addSchedule(cronExpression, prompt, this.projectDir);
    await this.refreshCronTasks();
    return this.listSchedules();
  }

  async removeSchedule(id: string): Promise<Schedule[]> {
    await removeSchedule(id, this.projectDir);
    await this.refreshCronTasks();
    return this.listSchedules();
  }

  async setSessionAutoApprove(mode: SessionAutoApproveMode): Promise<SessionAutoApproveMode> {
    this.sessionAutoApprove = mode;
    await this.session?.append("permission:auto-approve", { mode });
    return this.sessionAutoApprove;
  }

  private async emitText(role: "leader" | "worker", delta: string, thinking = false): Promise<void> {
    const event = { role, delta, thinking };
    this.window.webContents.send(ipcChannels.textEvent, event);
    this.window.webContents.send(ipcChannels.costEvent, this.costTotals());
    await this.session?.append(thinking ? "thinking" : "text", event);
    await this.session?.append("cost", this.costTotals());
  }

  private async emitMachine(event: MachineEvent): Promise<void> {
    if (event.type === "checkpoint") this.lastCheckpoint = event.checkpoint;
    this.window.webContents.send(ipcChannels.machineEvent, event);
    this.window.webContents.send(ipcChannels.costEvent, this.costTotals());
    await this.session?.append("machine", event);
    await this.session?.append("cost", this.costTotals());
  }

  private async emitTool(event: ToolActivityEvent): Promise<void> {
    this.window.webContents.send(ipcChannels.toolEvent, event);
    await this.session?.append("tool", event);
  }

  private async emitMemory(): Promise<SessionMemoryNote[]> {
    const notes = await this.listMemory();
    const event: MemoryEvent = { notes };
    this.window.webContents.send(ipcChannels.memoryEvent, event);
    return notes;
  }

  private async currentSessionNotes(): Promise<string> {
    return formatSessionNotes(await this.listMemory());
  }

  private async currentProjectInstructions(): Promise<string> {
    return formatProjectInstructions(await readProjectInstructions(this.projectDir));
  }

  private async rememberProjectNote(text: string, _by: "leader" | "worker"): Promise<string> {
    return appendProjectMemoryNote(this.projectDir, text);
  }

  private async rememberSessionNote(text: string, by: "leader" | "worker"): Promise<string> {
    if (!this.session) throw new Error("No active session for memory.");
    const result = await addNote(this.session, text, by);
    if (result.added) await this.emitMemory();
    return result.added ? `Remembered: ${result.note.text}` : `Already remembered: ${result.note.text}`;
  }

  private async recordLeaderCompaction(event: { summary: string; compactedTurns: number }): Promise<void> {
    await this.session?.append("memory:compaction", event);
    await this.emitMachine({ type: "notice", message: `compacted ${event.compactedTurns} earlier turns.` });
  }

  private async addSystemMemory(text: string, by: Extract<MemoryAuthor, "system">): Promise<void> {
    if (!this.session) return;
    const result = await addNote(this.session, text, by);
    if (result.added) await this.emitMemory();
  }

  private async removeMemoryByPrefix(prefix: string): Promise<void> {
    if (!this.session) return;
    const notes = await this.listMemory();
    const matching = notes.filter((note) => note.text.startsWith(prefix));
    for (const note of matching) await removeNote(this.session, note.id);
    if (matching.length > 0) await this.emitMemory();
  }

  private costTotals(): CostTotals {
    return this.ledger.totals();
  }

  private requestPermission(request: PermissionRequest): Promise<boolean> {
    if (this.sessionAutoApprove === "all") return Promise.resolve(true);
    if (this.sessionAutoApprove === "edits" && (request.action === "write" || request.action === "edit")) {
      return Promise.resolve(true);
    }
    const id = randomUUID();
    const event: PermissionRequestEvent = { id, ...request };
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.window.webContents.send(ipcChannels.permissionRequest, event);
    });
  }

  private confirmPlan(plan: PlanConfirmEvent["plan"]): Promise<boolean> {
    if (this.config.permissionMode !== "ask" || this.sessionAutoApprove === "all") return Promise.resolve(true);
    const id = randomUUID();
    const event: PlanConfirmEvent = { id, plan };
    return new Promise((resolve) => {
      this.pendingPlans.set(id, resolve);
      this.window.webContents.send(ipcChannels.planConfirm, event);
    });
  }

  private resolvePending(map: Map<string, PendingResolver>, id: string, approved: boolean): void {
    const resolve = map.get(id);
    if (!resolve) return;
    map.delete(id);
    resolve(approved);
  }

  private findLastCheckpoint(payloads: unknown[]): OrchestrationCheckpoint | undefined {
    for (const payload of [...payloads].reverse()) {
      const event = payload as MachineEvent;
      if (event?.type === "checkpoint") return event.checkpoint;
    }
    return undefined;
  }

  private loadProjectEnv(projectDir: string): NodeJS.ProcessEnv {
    return loadEnv(projectDir, this.homeDir, { ...(this.deps.baseEnv ?? process.env) });
  }

  private async refreshCronTasks(): Promise<void> {
    for (const task of this.cronTasks.values()) task.stop();
    this.cronTasks.clear();
    const schedules = await listSchedules(this.projectDir);
    for (const schedule of schedules) {
      if (!cron.validate(schedule.cron)) continue;
      const task = cron.schedule(schedule.cron, () => {
        void this.runScheduledPrompt(schedule);
      });
      this.cronTasks.set(schedule.id, task);
    }
  }

  private async runScheduledPrompt(schedule: Schedule): Promise<void> {
    if (this.controller) {
      const event: MachineEvent = { type: "error", message: `Skipped scheduled prompt ${schedule.id}; another run is active.` };
      await this.emitMachine(event);
      return;
    }
    await markScheduleRun(schedule.id, this.projectDir);
    await this.run(schedule.prompt);
  }
}
