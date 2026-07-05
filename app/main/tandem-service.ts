import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import { loadConfig, loadEnv, saveProjectConfig } from "../../src/config/load.js";
import type { TandemConfig } from "../../src/config/schema.js";
import { createLiveAgents } from "../../src/agents/live.js";
import { createDiffTracker } from "../../src/orchestrator/diff.js";
import { runOrchestration, type MachineEvent, type OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import { modelRegistry } from "../../src/providers/registry.js";
import { CostLedger } from "../../src/session/cost.js";
import { listGoals } from "../../src/session/goals.js";
import { listSessions, SessionStore } from "../../src/session/store.js";
import type { PermissionBridge, PermissionRequest } from "../../src/tools/permissions.js";
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

export class TandemService {
  private projectDir = process.cwd();
  private env: NodeJS.ProcessEnv = {};
  private config: TandemConfig = loadConfig({ cwd: this.projectDir });
  private ledger = new CostLedger();
  private session?: SessionStore;
  private controller?: AbortController;
  private lastCheckpoint?: OrchestrationCheckpoint;
  private readonly pendingPermissions = new Map<string, PendingResolver>();
  private readonly pendingPlans = new Map<string, PendingResolver>();

  constructor(private readonly window: BrowserWindow) {
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
    this.session = await SessionStore.create(this.projectDir);
    await this.session.append("session:start", { projectDir: this.projectDir });
    return { projectDir: this.projectDir, sessionId: this.session.id, config: this.config };
  }

  async run(prompt: string): Promise<void> {
    if (this.controller) throw new Error("A Tandem run is already active.");
    if (!this.session) await this.startSession({ projectDir: this.projectDir });
    const session = this.session as SessionStore;
    this.controller = new AbortController();
    await session.append("user", { prompt });

    try {
      const diffTracker = createDiffTracker(this.projectDir);
      const permissionBridge: PermissionBridge = {
        approve: (request) => this.requestPermission(request)
      };
      const agents = await createLiveAgents({
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
      const result = await runOrchestration({
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
    const store = await SessionStore.open(id, this.projectDir);
    const events = await store.read();
    this.session = store;
    this.lastCheckpoint = this.findLastCheckpoint(events.map((event) => event.payload));
    return { id, events, checkpoint: this.lastCheckpoint };
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
}
