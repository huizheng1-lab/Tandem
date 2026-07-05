import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { loadConfig, loadEnv, saveProjectConfig } from "../../src/config/load.js";
import type { TandemConfig } from "../../src/config/schema.js";
import { createLiveAgents } from "../../src/agents/live.js";
import { createDiffTracker } from "../../src/orchestrator/diff.js";
import { runOrchestration, type MachineEvent, type OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import { modelRegistry } from "../../src/providers/registry.js";
import { CostLedger } from "../../src/session/cost.js";
import { addGoal, completeGoal, listGoals } from "../../src/session/goals.js";
import { listSessions, SessionStore } from "../../src/session/store.js";
import type { PermissionBridge, PermissionRequest } from "../../src/tools/permissions.js";
import { addSchedule, listSchedules, markScheduleRun, removeSchedule } from "../../src/commands/schedule.js";
import type { Schedule } from "../../src/commands/schedule.js";
import {
  ipcChannels,
  type CostTotals,
  type PermissionRequestEvent,
  type PermissionResponse,
  type PlanConfirmEvent,
  type PlanResponse,
  type SessionResumeResponse,
  type SessionStartRequest,
  type SessionStartResponse
} from "../shared/ipc.js";

type PendingResolver = (approved: boolean) => void;
type DesktopWindow = Pick<BrowserWindow, "webContents">;
type SessionLike = Pick<SessionStore, "id" | "append" | "read">;

export interface TandemServiceDeps {
  createAgents?: typeof createLiveAgents;
  runOrchestration?: typeof runOrchestration;
  createSession?: (cwd: string) => Promise<SessionLike>;
  openSession?: (id: string, cwd: string) => Promise<SessionLike>;
  registerIpcResponses?: boolean;
}

export class TandemService {
  private projectDir = process.cwd();
  private env: NodeJS.ProcessEnv = {};
  private config: TandemConfig = loadConfig({ cwd: this.projectDir });
  private ledger = new CostLedger();
  private session?: SessionLike;
  private controller?: AbortController;
  private lastCheckpoint?: OrchestrationCheckpoint;
  private readonly pendingPermissions = new Map<string, PendingResolver>();
  private readonly pendingPlans = new Map<string, PendingResolver>();
  private readonly cronTasks = new Map<string, ScheduledTask>();

  constructor(
    private readonly window: DesktopWindow,
    private readonly deps: TandemServiceDeps = {}
  ) {
    if (deps.registerIpcResponses === false) return;
    ipcMain.on(ipcChannels.permissionRespond, (_event, response: PermissionResponse) => {
      this.resolvePending(this.pendingPermissions, response.id, response.approved);
    });
    ipcMain.on(ipcChannels.planRespond, (_event, response: PlanResponse) => {
      this.resolvePending(this.pendingPlans, response.id, response.approved);
    });
  }

  async startSession(request: SessionStartRequest): Promise<SessionStartResponse> {
    this.projectDir = request.projectDir || process.cwd();
    this.env = loadEnv(this.projectDir, undefined, { ...process.env });
    this.config = loadConfig({ cwd: this.projectDir, env: this.env });
    this.ledger = new CostLedger();
    this.lastCheckpoint = undefined;
    this.session = await (this.deps.createSession ?? ((cwd) => SessionStore.create(cwd)))(this.projectDir);
    await this.session.append("session:start", { projectDir: this.projectDir });
    await this.refreshCronTasks();
    return { projectDir: this.projectDir, sessionId: this.session.id, config: this.config };
  }

  async run(prompt: string): Promise<void> {
    if (this.controller) throw new Error("A Tandem run is already active.");
    if (!this.session) await this.startSession({ projectDir: this.projectDir });
    const session = this.session as SessionLike;
    this.controller = new AbortController();
    await session.append("user", { prompt });

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
        onWorkerText: (delta) => void this.emitText("worker", delta)
      });
      const goals = (await listGoals(this.projectDir)).filter((goal) => goal.status === "active").map((goal) => goal.text);
      const result = await (this.deps.runOrchestration ?? runOrchestration)({
        request: prompt,
        config: this.config,
        agents,
        goals,
        diffProvider: diffTracker,
        initialState: this.lastCheckpoint,
        confirmPlan: (plan) => this.confirmPlan(plan),
        emit: (event) => void this.emitMachine(event)
      });
      const done = { summary: result.summary, takeover: result.takeover };
      this.window.webContents.send(ipcChannels.doneEvent, done);
      await session.append("done", done);
    } catch (error) {
      const event: MachineEvent = { type: "error", message: String(error) };
      this.window.webContents.send(ipcChannels.machineEvent, event);
      await session.append("machine", event);
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

  async setConfig(patch: Partial<TandemConfig>): Promise<TandemConfig> {
    this.config = { ...this.config, ...patch };
    await saveProjectConfig(this.config, this.projectDir);
    return this.config;
  }

  listModels() {
    return modelRegistry(this.config.customModels).map((model) => ({
      id: model.id,
      provider: model.provider,
      modelName: model.modelName,
      envKey: model.envKey,
      available: Boolean(this.env[model.envKey])
    }));
  }

  listSessions(): Promise<string[]> {
    return listSessions(this.projectDir);
  }

  async resumeSession(id: string): Promise<SessionResumeResponse> {
    const store = await (this.deps.openSession ?? ((sessionId, cwd) => SessionStore.open(sessionId, cwd)))(id, this.projectDir);
    const events = await store.read();
    this.session = store;
    this.lastCheckpoint = this.findLastCheckpoint(events.map((event) => event.payload));
    return { id, events, checkpoint: this.lastCheckpoint };
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

  private async emitText(role: "leader" | "worker", delta: string): Promise<void> {
    const event = { role, delta };
    this.window.webContents.send(ipcChannels.textEvent, event);
    this.window.webContents.send(ipcChannels.costEvent, this.costTotals());
    await this.session?.append("text", event);
    await this.session?.append("cost", this.costTotals());
  }

  private async emitMachine(event: MachineEvent): Promise<void> {
    if (event.type === "checkpoint") this.lastCheckpoint = event.checkpoint;
    this.window.webContents.send(ipcChannels.machineEvent, event);
    this.window.webContents.send(ipcChannels.costEvent, this.costTotals());
    await this.session?.append("machine", event);
    await this.session?.append("cost", this.costTotals());
  }

  private costTotals(): CostTotals {
    return this.ledger.totals();
  }

  private requestPermission(request: PermissionRequest): Promise<boolean> {
    const id = randomUUID();
    const event: PermissionRequestEvent = { id, ...request };
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.window.webContents.send(ipcChannels.permissionRequest, event);
    });
  }

  private confirmPlan(plan: PlanConfirmEvent["plan"]): Promise<boolean> {
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
