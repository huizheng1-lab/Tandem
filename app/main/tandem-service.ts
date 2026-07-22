import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BrowserWindow, ipcMain } from "electron";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { loadConfig, loadConfigDetails, loadEnv, saveGlobalConfigPatch, saveProjectConfig } from "../../src/config/load.js";
import type { TandemConfig } from "../../src/config/schema.js";
import { createLiveAgents } from "../../src/agents/live.js";
import { locateCodexCli } from "../../src/agents/codex-cli/locate.js";
import { locateClaudeCli } from "../../src/agents/claude-code-cli/locate.js";
import { createDiffTracker } from "../../src/orchestrator/diff.js";
import { runOrchestration, type MachineEvent, type OrchestrationCheckpoint } from "../../src/orchestrator/machine.js";
import type { CompletionReport } from "../../src/orchestrator/artifacts.js";
import { createVerificationRunner } from "../../src/orchestrator/verification.js";
import { commitReciprocalCandidate, prepareReciprocalWorktree } from "../../src/reciprocal/candidate-commit.js";
import { modelRegistry } from "../../src/providers/registry.js";
import { withConfiguredCliModel } from "../../src/providers/cli-models.js";
import { tandemStateDir } from "../../src/paths.js";
import { RemoteBridge, type RemoteApprovalRequest, type RemoteControlState, type RemoteTransport } from "../../src/remote-control/bridge.js";
import type { PromptSubmissionInput, SessionPromptSubmissionResult } from "../../src/remote-control/prompt-submission.js";
import type { SessionEventSubscription, StreamingSessionEvent } from "../../src/remote-control/streaming-session.js";
import { FileTelegramOffsetStore, TelegramLongPollingTransport } from "../../src/remote-control/telegram.js";
import { CostLedger } from "../../src/session/cost.js";
import { copyAttachment, formatAttachmentBlock, writeAttachmentData } from "../../src/session/attachments.js";
import type { AttachmentRef } from "../../src/session/attachments.js";
import { addGoal, clearGoals, completeGoal, formatStandingGoals, listGoals } from "../../src/session/goals.js";
import { buildConversationHistory } from "../../src/session/history.js";
import { compactSessionHistory, isCliBackedLeader, type LeaderCompactionEvent } from "../../src/session/compaction.js";
import { rebuildLeaderThread } from "../../src/session/leader-thread.js";
import { addNote, formatSessionNotes, removeNote, replaySessionMemory } from "../../src/session/memory.js";
import type { MemoryAuthor, SessionMemoryNote } from "../../src/session/memory.js";
import { appendProjectMemoryNote, formatProjectInstructions, readProjectInstructions } from "../../src/session/project-memory.js";
import { archiveSession, deleteSession, findSessionProjectDir, listAllSessions, renameSession, sessionDir, SessionStore } from "../../src/session/store.js";
import type { SessionMetadata } from "../../src/session/store.js";
import { searchSessionsStream } from "../../src/session/search.js";
import { safeDefaultProjectDir } from "../../src/tools/protection.js";
import { readJsonFileSync } from "../../src/json.js";
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
  type SessionSearchBatchEvent,
  type SessionSearchRequest,
  type ToolActivityEvent,
  type SessionStartRequest,
  type SessionStartResponse
} from "../shared/ipc.js";

type PendingResolver = (approved: boolean, source?: "desktop" | "telegram" | "timeout") => void;
type DesktopWindow = Pick<BrowserWindow, "webContents">;
type SessionLike = Pick<SessionStore, "id" | "append" | "read"> & Partial<Pick<SessionStore, "readRecent">>;
const DESKTOP_RESUME_EVENT_LIMIT = 2500;

interface DesktopAppState {
  lastProjectDir?: string;
}

function desktopAppStatePath(homeDir?: string): string {
  return path.join(tandemStateDir(homeDir), "desktop-state.json");
}

export function readDesktopAppState(homeDir?: string): DesktopAppState {
  const filePath = desktopAppStatePath(homeDir);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = readJsonFileSync<DesktopAppState>(filePath);
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
  findSessionProjectDir?: typeof findSessionProjectDir;
  searchSessionsStream?: typeof searchSessionsStream;
  remoteTransportFactory?: (token: string) => RemoteTransport;
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
  private paused = false;
  private pauseResolvers = new Set<() => void>();
  private lastCheckpoint?: OrchestrationCheckpoint;
  private readonly pendingPermissions = new Map<string, PendingResolver>();
  private readonly pendingPlans = new Map<string, PendingResolver>();
  private readonly cronTasks = new Map<string, ScheduledTask>();
  private readonly sessionSearchControllers = new Map<string, AbortController>();
  private sessionAutoApprove: SessionAutoApproveMode = "none";
  private lastPersistedCostKey?: string;
  private runBaselineTotals?: CostTotals;
  private currentPhase = "IDLE";
  private remoteBridge: RemoteBridge;
  private readonly remoteSessionSubscribers = new Map<string, Set<(event: StreamingSessionEvent) => void>>();
  constructor(
    private readonly window: DesktopWindow,
    private readonly deps: TandemServiceDeps = {}
  ) {
    this.homeDir = deps.homeDir;
    this.lastProjectDir = readDesktopAppState(this.homeDir).lastProjectDir;
    this.projectDir = this.lastProjectDir ?? safeDefaultProjectDir(this.homeDir);
    this.env = this.loadProjectEnv(this.projectDir);
    this.config = loadConfig({ cwd: this.projectDir, homeDir: this.homeDir, env: this.env });
    const remoteStateDir = tandemStateDir(this.homeDir);
    this.remoteBridge = new RemoteBridge({
      auditPath: path.join(remoteStateDir, "remote-control-audit.jsonl"),
      transportFactory: this.deps.remoteTransportFactory ?? ((token) => new TelegramLongPollingTransport(
        token,
        undefined,
        new FileTelegramOffsetStore(path.join(remoteStateDir, "remote-control-telegram-offset.json"))
      )),
      tokenProvider: () => this.env.TELEGRAM_BOT_TOKEN,
      statusProvider: () => this.remoteStatusSnapshot(),
      sessionsProvider: async () => (await this.listSessions()).map((session) => ({ id: session.id, title: session.title, projectDir: session.projectDir })),
      actions: {
        pause: () => this.pauseRemoteRun(),
        resume: () => this.resumeRemoteRun(),
        stop: () => this.stopRemoteRun(),
        useSession: (id) => this.useRemoteSession(id)
      },
      submitPrompt: (input) => this.submitRemotePrompt(input),
      subscribeSessionEvents: (sessionId, onEvent) => this.subscribeRemoteSessionEvents(sessionId, onEvent),
      saveConfig: (patch) => this.saveRemoteControlConfig(patch),
      onStateChange: (state) => this.window.webContents.send(ipcChannels.remoteControlEvent, state)
    });
    void this.remoteBridge.configure(this.config.remoteControl ?? {});
    void this.refreshCronTasks();
    if (deps.registerIpcResponses === false) return;
    ipcMain.on(ipcChannels.permissionRespond, (_event, response: PermissionResponse) => {
      this.resolvePending(this.pendingPermissions, response.id, response.approved);
    });
    ipcMain.on(ipcChannels.planRespond, (_event, response: PlanResponse) => {
      this.resolvePending(this.pendingPlans, response.id, response.approved);
    });
  }

  getAutomationState(): { projectDir: string; sessionId?: string; running: boolean } {
    return { projectDir: this.projectDir, sessionId: this.session?.id, running: Boolean(this.controller) };
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
    await this.remoteBridge.configure(this.config.remoteControl ?? {});
    this.ledger = new CostLedger();
    this.runBaselineTotals = this.ledger.totals();
    this.lastPersistedCostKey = undefined;
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
    await this.prepareReciprocalRun();
    this.controller = new AbortController();
    this.paused = false;
    this.currentPhase = "IDLE";
    this.runBaselineTotals = this.ledger.totals();
    try {
      let sessionEvents = await session.read();
      if (isCliBackedLeader(this.config)) {
        const compacted = await this.compactCurrentSession(sessionEvents, false);
        if (compacted) sessionEvents = await session.read();
      }
      const history = buildConversationHistory(sessionEvents);
      await this.emitMachine({ type: "notice", message: `context: ${history.priorTurns} prior turn${history.priorTurns === 1 ? "" : "s"}` });
      if (history.truncated) await this.emitMachine({ type: "notice", message: "including last 10 turns of context" });
      const attachmentBlock = formatAttachmentBlock(attachments);
      const promptWithAttachments = attachmentBlock ? `${prompt}\n\n${attachmentBlock}` : prompt;
      await session.append("user", { prompt: promptWithAttachments, attachments });
      const initialState = this.lastCheckpoint?.phase === "DONE" ? undefined : this.lastCheckpoint;
      this.lastCheckpoint = undefined;
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
        onTriage: (kind) => this.emitMachine({ type: "notice", message: `triage: ${kind}` }),
        confirmCodexWrite: (_role, message) => this.requestPermission({ action: "bash", target: message })
      });
      const goals = formatStandingGoals((await listGoals(this.projectDir)).filter((goal) => goal.status === "active"));
      let directLeaderAnswer = false;
      const result = await (this.deps.runOrchestration ?? runOrchestration)({
        request: promptWithAttachments,
        config: this.config,
        agents,
        goals,
        history: history.text,
        attachments,
        diffProvider: diffTracker,
        verificationRunner: createVerificationRunner({
          cwd: this.projectDir,
          permissionMode: this.config.permissionMode,
          permissionBridge,
          abortSignal: this.controller.signal
        }),
        postBuildReport: (report) => this.postBuildReport(report),
        initialState,
        confirmPlan: (plan) => this.confirmPlan(plan),
        waitIfPaused: () => this.waitIfPaused(),
        emit: (event) => {
          if (event.type === "transition" && event.message === "leader answered without build plan") {
            directLeaderAnswer = true;
          }
          void this.emitMachine(event);
        }
      });
      if (directLeaderAnswer) {
        this.emitRemoteSessionEvent({
          role: "leader",
          phase: "completed",
          health: "healthy",
          lastEventKind: "answer",
          text: result.summary,
          ended: true
        });
      }
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
      this.emitRemoteSessionEvent({
        phase: this.currentPhase === "IDLE" ? "completed" : this.currentPhase.toLowerCase(),
        health: "healthy",
        lastEventKind: "done",
        ended: true
      });
      this.controller = undefined;
      this.paused = false;
      this.releasePauseWaiters();
    }
  }

  abort(): void {
    this.controller?.abort();
  }

  async pauseRun(): Promise<{ ok: boolean; message: string }> {
    if (!this.controller) return { ok: false, message: "No active Tandem run to pause." };
    if (this.paused) return { ok: true, message: "Tandem run is already paused." };
    this.paused = true;
    await this.emitMachine({ type: "notice", message: "Remote control paused the current run." });
    return { ok: true, message: "Paused the current Tandem run. It will stop at the next orchestration boundary." };
  }

  async resumeRun(): Promise<{ ok: boolean; message: string }> {
    if (!this.paused) return { ok: false, message: "No paused Tandem run to resume." };
    this.paused = false;
    this.releasePauseWaiters();
    await this.emitMachine({ type: "notice", message: "Remote control resumed the current run." });
    return { ok: true, message: "Resumed the current Tandem run." };
  }

  async compactSession(): Promise<LeaderCompactionEvent | undefined> {
    if (!this.session) await this.startSession({ projectDir: this.projectDir });
    return this.compactCurrentSession(await (this.session as SessionLike).read(), true);
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
    if (patch.remoteControl) await this.remoteBridge.configure(this.config.remoteControl ?? {});
    return this.config;
  }

  listModels() {
    return modelRegistry(this.config.customModels).map((registryModel) => {
      const model = withConfiguredCliModel(registryModel, this.config);
      return {
      id: model.id,
      provider: model.provider,
      modelName: model.modelName,
      envKey: model.envKey,
      available:
        model.provider === "codex-cli"
          ? Boolean(locateCodexCli({ env: this.env, overridePath: this.config.codexCliPath }))
          : model.provider === "claude-code-cli"
            ? Boolean(locateClaudeCli({ env: this.env, overridePath: this.config.claudeCliPath }))
            : Boolean(model.envKey && this.env[model.envKey]),
      media: model.media,
      costHints: model.costHints
      };
    });
  }

  async addAttachmentFiles(paths: string[]): Promise<AttachmentRef[]> {
    return Promise.all(paths.map((filePath) => copyAttachment(this.projectDir, filePath)));
  }

  addAttachmentData(name: string, data: Uint8Array): Promise<AttachmentRef> {
    return writeAttachmentData(this.projectDir, name, data);
  }

  listSessions(): Promise<SessionMetadata[]> {
    return listAllSessions(this.homeDir);
  }

  async startSessionSearch(
    request: SessionSearchRequest,
    onBatch: (batch: SessionSearchBatchEvent) => void
  ): Promise<void> {
    this.cancelSessionSearch(request.searchId);
    const controller = new AbortController();
    this.sessionSearchControllers.set(request.searchId, controller);
    try {
      const stream = await (this.deps.searchSessionsStream ?? searchSessionsStream)(
        { query: request.query, limit: request.limit, homeDir: this.homeDir },
        controller.signal
      );
      for await (const batch of stream) {
        if (controller.signal.aborted) break;
        onBatch({ searchId: request.searchId, ...batch });
        if (batch.done) break;
      }
    } finally {
      if (this.sessionSearchControllers.get(request.searchId) === controller) {
        this.sessionSearchControllers.delete(request.searchId);
      }
    }
  }

  cancelSessionSearch(searchId: string): void {
    const controller = this.sessionSearchControllers.get(searchId);
    controller?.abort();
    if (controller) this.sessionSearchControllers.delete(searchId);
  }

  private async projectDirForSession(id: string): Promise<string> {
    const found = await (this.deps.findSessionProjectDir ?? findSessionProjectDir)(id, this.homeDir);
    if (found) return found;
    if (existsSync(path.join(sessionDir(this.projectDir, this.homeDir), `${id}.jsonl`))) return this.projectDir;
    throw new Error(`No session ${id} found.`);
  }

  async resumeSession(id: string): Promise<SessionResumeResponse> {
    if (this.controller) throw new Error("Cannot switch sessions while a Tandem run is active.");
    let store: SessionLike;
    let projectDir = this.projectDir;
    const openSession = this.deps.openSession ?? ((sessionId, cwd) => SessionStore.open(sessionId, cwd, this.homeDir));
    try {
      try {
        store = await openSession(id, projectDir);
      } catch (error) {
        if (!/No session .*Run \/sessions to list sessions/.test(String(error))) throw error;
        const foundProjectDir = await (this.deps.findSessionProjectDir ?? findSessionProjectDir)(id, this.homeDir);
        if (!foundProjectDir) throw error;
        projectDir = foundProjectDir;
        store = await openSession(id, projectDir);
      }
    } catch (error) {
      if (/No session .*Run \/sessions to list sessions/.test(String(error))) {
        throw new Error("This session belongs to a different project folder - pick that folder to open it.");
      }
      throw error;
    }
    this.projectDir = projectDir;
    this.lastProjectDir = projectDir;
    await writeDesktopAppState(this.homeDir, { lastProjectDir: projectDir });
    this.env = this.loadProjectEnv(projectDir);
    const loaded = loadConfigDetails({ cwd: projectDir, homeDir: this.homeDir, env: this.env });
    this.config = loaded.config;
    this.projectConfigOverrides = loaded.projectOverrides;
    await this.remoteBridge.configure(this.config.remoteControl ?? {});
    this.ledger = new CostLedger();
    this.lastPersistedCostKey = undefined;
    await this.refreshCronTasks();
    const recent = store.readRecent ? await store.readRecent(DESKTOP_RESUME_EVENT_LIMIT) : { events: await store.read(), truncated: false };
    const events = recent.events;
    this.session = store;
    const persistedCost = this.findLastCostTotals(events);
    if (persistedCost) this.ledger.hydrate(persistedCost);
    this.runBaselineTotals = this.ledger.totals();
    const checkpoint = this.findLastCheckpoint(events.map((event) => event.payload));
    this.lastCheckpoint = checkpoint?.phase === "DONE" ? undefined : checkpoint;
    const projectInstructions = await readProjectInstructions(projectDir);
    return {
      id,
      projectDir,
      config: this.config,
      defaultProject: false,
      projectSummary: await projectSummary(projectDir),
      projectConfigOverrides: this.projectConfigOverrides,
      projectInstructions: projectInstructions
        ? { fileName: projectInstructions.fileName, chars: projectInstructions.chars, truncated: projectInstructions.truncated }
        : undefined,
      events,
      eventsTruncated: recent.truncated || undefined,
      checkpoint: this.lastCheckpoint,
      cost: this.costEventTotals()
    };
  }

  async renameSession(id: string, title: string): Promise<SessionMetadata[]> {
    await renameSession(id, title, await this.projectDirForSession(id), this.homeDir);
    return this.listSessions();
  }

  async archiveSession(id: string, archived: boolean): Promise<SessionMetadata[]> {
    await archiveSession(id, archived, await this.projectDirForSession(id), this.homeDir);
    return this.listSessions();
  }

  async deleteSession(id: string): Promise<SessionDeleteResponse> {
    const wasActive = this.session?.id === id;
    if (wasActive) {
      this.session = undefined;
      this.lastCheckpoint = undefined;
    }
    await deleteSession(id, await this.projectDirForSession(id), this.homeDir);
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

  async clearGoals() {
    return clearGoals(this.projectDir);
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

  getRemoteControlState(): RemoteControlState {
    return this.remoteBridge.state();
  }

  enableRemoteControl(): Promise<RemoteControlState> {
    return this.remoteBridge.enablePairing();
  }

  revokeRemoteControl(): Promise<RemoteControlState> {
    return this.remoteBridge.revoke();
  }

  private pauseRemoteRun(): Promise<{ ok: boolean; message: string }> {
    return this.pauseRun();
  }

  private resumeRemoteRun(): Promise<{ ok: boolean; message: string }> {
    return this.resumeRun();
  }

  private async stopRemoteRun(): Promise<{ ok: boolean; message: string }> {
    if (!this.controller) return { ok: false, message: "No active Tandem run to stop." };
    this.abort();
    return { ok: true, message: "Emergency stop requested. Tandem is aborting the current run." };
  }

  private async useRemoteSession(id: string): Promise<{ ok: boolean; message: string }> {
    if (this.controller) return { ok: false, message: "Cannot switch sessions while a Tandem run is active." };
    const resumed = await this.resumeSession(id);
    return { ok: true, message: `Using session ${resumed.id.slice(0, 8)}.` };
  }

  private async submitRemotePrompt(input: PromptSubmissionInput): Promise<SessionPromptSubmissionResult> {
    if (this.controller) return { status: "rejected", message: "Cannot submit a remote prompt while a Tandem run is already active." };
    try {
      if (this.session?.id !== input.sessionId) await this.resumeSession(input.sessionId);
      if (this.controller) return { status: "rejected", message: "Cannot submit a remote prompt while a Tandem run is already active." };
      void this.run(input.text).catch((error) => {
        void this.emitMachine({ type: "error", message: String(error) });
      });
      return { status: "submitted" };
    } catch (error) {
      return { status: "rejected", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private subscribeRemoteSessionEvents(sessionId: string, onEvent: (event: StreamingSessionEvent) => void): ReturnType<SessionEventSubscription> {
    let subscribers = this.remoteSessionSubscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.remoteSessionSubscribers.set(sessionId, subscribers);
    }
    subscribers.add(onEvent);
    return () => {
      subscribers?.delete(onEvent);
      if (subscribers?.size === 0) this.remoteSessionSubscribers.delete(sessionId);
    };
  }

  private emitRemoteSessionEvent(event: StreamingSessionEvent): void {
    const sessionId = this.session?.id;
    if (!sessionId) return;
    const subscribers = this.remoteSessionSubscribers.get(sessionId);
    if (!subscribers) return;
    for (const subscriber of subscribers) subscriber(event);
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    const signal = this.controller?.signal;
    if (signal?.aborted) return Promise.reject(new Error("Run aborted while paused."));
    return new Promise((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", abort);
        this.pauseResolvers.delete(release);
        resolve();
      };
      const abort = () => {
        this.pauseResolvers.delete(release);
        reject(new Error("Run aborted while paused."));
      };
      this.pauseResolvers.add(release);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private releasePauseWaiters(): void {
    const waiters = [...this.pauseResolvers];
    this.pauseResolvers.clear();
    for (const waiter of waiters) waiter();
  }

  private async emitText(role: "leader" | "worker", delta: string, thinking = false): Promise<void> {
    const event = { role, delta, thinking };
    this.window.webContents.send(ipcChannels.textEvent, event);
    this.emitRemoteSessionEvent({
      role,
      phase: this.currentPhase.toLowerCase(),
      health: "healthy",
      lastEventKind: thinking ? "thinking" : "text",
      text: delta
    });
    const totals = this.costTotals();
    this.window.webContents.send(ipcChannels.costEvent, this.costEventTotals(totals));
    await this.session?.append(thinking ? "thinking" : "text", event);
    await this.persistCostSnapshot(totals);
  }

  private async emitMachine(event: MachineEvent): Promise<void> {
    if (event.type === "checkpoint") this.lastCheckpoint = event.checkpoint;
    if (event.type === "checkpoint") this.currentPhase = event.checkpoint.phase;
    if (event.type === "transition") this.currentPhase = event.phase;
    this.window.webContents.send(ipcChannels.machineEvent, event);
    this.emitRemoteSessionEvent({
      phase: this.currentPhase.toLowerCase(),
      health: event.type === "error" ? "likely stalled" : "healthy",
      lastEventKind: event.type,
      text: event.type === "notice" || event.type === "error" || event.type === "transition" ? event.message : undefined
    });
    const totals = this.costTotals();
    this.window.webContents.send(ipcChannels.costEvent, this.costEventTotals(totals));
    await this.session?.append("machine", event);
    await this.persistCostSnapshot(totals);
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

  private async postBuildReport(report: CompletionReport): Promise<CompletionReport> {
    return commitReciprocalCandidate({
      cwd: this.projectDir,
      role: this.env.TANDEM_INSTANCE_ID,
      report
    });
  }

  private async prepareReciprocalRun(): Promise<void> {
    await prepareReciprocalWorktree({
      cwd: this.projectDir,
      role: this.env.TANDEM_INSTANCE_ID
    });
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

  private async compactCurrentSession(events: Awaited<ReturnType<SessionLike["read"]>>, force: boolean): Promise<LeaderCompactionEvent | undefined> {
    const event = await compactSessionHistory({
      events,
      config: this.config,
      cwd: this.projectDir,
      env: this.env,
      ledger: this.ledger,
      force,
      abortSignal: this.controller?.signal
    });
    if (event) await this.recordLeaderCompaction(event);
    return event;
  }

  private async recordLeaderCompaction(event: LeaderCompactionEvent): Promise<void> {
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

  private remotePermissionRequest(event: PermissionRequestEvent): RemoteApprovalRequest {
    return {
      id: event.id,
      kind: "permission",
      title: `${event.action}: ${this.truncateRemoteText(event.target, 120)}`,
      body: this.truncateRemoteText(event.target, 1200),
      onResolve: (approved, source) => this.resolvePending(this.pendingPermissions, event.id, approved, source)
    };
  }

  private remotePlanRequest(event: PlanConfirmEvent): RemoteApprovalRequest {
    const tasks = event.plan.tasks.slice(0, 8).map((task) => `- ${task.id}: ${task.description}`).join("\n");
    const extra = event.plan.tasks.length > 8 ? `\n- ...${event.plan.tasks.length - 8} more task(s)` : "";
    const body = [
      `Objective: ${event.plan.objective}`,
      event.plan.constraints.length > 0 ? `Constraints: ${event.plan.constraints.join("; ")}` : "",
      `Tasks:\n${tasks}${extra}`
    ].filter(Boolean).join("\n");
    return {
      id: event.id,
      kind: "plan",
      title: this.truncateRemoteText(event.plan.title, 120),
      body: this.truncateRemoteText(body, 1200),
      onResolve: (approved, source) => this.resolvePending(this.pendingPlans, event.id, approved, source)
    };
  }

  private truncateRemoteText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}... [truncated]`;
  }

  private costEventTotals(currentTotals: CostTotals = this.ledger.totals()): CostTotals {
    const baseline = this.runBaselineTotals ?? {
      leader: { role: "leader" as const, inputTokens: 0, outputTokens: 0, dollars: 0 },
      worker: { role: "worker" as const, inputTokens: 0, outputTokens: 0, dollars: 0 }
    };
    const currentRunTick = (role: "leader" | "worker") => ({
      role,
      inputTokens: Math.max(0, currentTotals[role].inputTokens - baseline[role].inputTokens),
      outputTokens: Math.max(0, currentTotals[role].outputTokens - baseline[role].outputTokens),
      dollars: Math.max(0, currentTotals[role].dollars - baseline[role].dollars)
    });
    return {
      leader: currentRunTick("leader"),
      worker: currentRunTick("worker"),
      cumulative: {
        leader: { ...currentTotals.leader },
        worker: { ...currentTotals.worker }
      }
    };
  }

  private remoteStatusSnapshot() {
    return {
      sessionId: this.session?.id,
      phase: this.controller ? this.currentPhase : this.lastCheckpoint?.phase ?? "IDLE",
      activeRole: this.controller ? (this.currentPhase === "BUILDING" ? "worker" : "leader") : undefined,
      runHealth: this.paused ? "paused" : this.controller ? "running" : "idle",
      cost: this.costEventTotals()
    };
  }

  private async saveRemoteControlConfig(patch: { enabled?: boolean; telegramUserId?: number }): Promise<void> {
    const current = this.config.remoteControl ?? {};
    const remoteControl = { ...current, ...patch };
    if (remoteControl.telegramUserId === undefined) delete remoteControl.telegramUserId;
    this.config = { ...this.config, remoteControl };
    await saveGlobalConfigPatch({ remoteControl }, this.homeDir);
  }

  private findLastCostTotals(events: Array<{ type: string; payload: unknown }>): CostTotals | undefined {
    const isTick = (value: unknown, role: "leader" | "worker"): boolean => {
      if (!value || typeof value !== "object") return false;
      const tick = value as Record<string, unknown>;
      return tick.role === role
        && typeof tick.inputTokens === "number" && Number.isFinite(tick.inputTokens)
        && typeof tick.outputTokens === "number" && Number.isFinite(tick.outputTokens)
        && typeof tick.dollars === "number" && Number.isFinite(tick.dollars);
    };
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "cost" || !event.payload || typeof event.payload !== "object") continue;
      const totals = event.payload as Record<string, unknown>;
      const candidate = totals.cumulative && typeof totals.cumulative === "object" ? totals.cumulative as Record<string, unknown> : totals;
      if (isTick(candidate.leader, "leader") && isTick(candidate.worker, "worker")) {
        return { leader: candidate.leader, worker: candidate.worker } as CostTotals;
      }
    }
    return undefined;
  }

  private async persistCostSnapshot(totals: CostTotals): Promise<void> {
    const key = JSON.stringify(totals);
    if (key === this.lastPersistedCostKey) return;
    this.lastPersistedCostKey = key;
    await this.session?.append("cost", totals);
  }

  private requestPermission(request: PermissionRequest): Promise<boolean> {
    if (this.sessionAutoApprove === "all") return Promise.resolve(true);
    if (this.sessionAutoApprove === "edits" && (request.action === "write" || request.action === "edit")) {
      return Promise.resolve(true);
    }
    const id = randomUUID();
    const event: PermissionRequestEvent = { id, ...request };
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, (approved, source = "desktop") => {
        resolve(approved);
        void this.remoteBridge.resolveApproval(id, approved, source);
      });
      this.window.webContents.send(ipcChannels.permissionRequest, event);
      void this.remoteBridge.pushApproval(this.remotePermissionRequest(event));
    });
  }

  private confirmPlan(plan: PlanConfirmEvent["plan"]): Promise<boolean> {
    if (this.config.permissionMode !== "ask" || this.sessionAutoApprove === "all") return Promise.resolve(true);
    const id = randomUUID();
    const event: PlanConfirmEvent = { id, plan };
    return new Promise((resolve) => {
      this.pendingPlans.set(id, (approved, source = "desktop") => {
        resolve(approved);
        void this.remoteBridge.resolveApproval(id, approved, source);
      });
      this.window.webContents.send(ipcChannels.planConfirm, event);
      void this.remoteBridge.pushApproval(this.remotePlanRequest(event));
    });
  }

  private resolvePending(map: Map<string, PendingResolver>, id: string, approved: boolean, source: "desktop" | "telegram" | "timeout" = "desktop"): void {
    const resolve = map.get(id);
    if (!resolve) return;
    map.delete(id);
    resolve(approved, source);
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
