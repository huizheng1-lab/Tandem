import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CostTotals,
  DesktopAppStateResponse,
  Goal,
  AttachmentRef,
  MachineEvent,
  MissingKeyInfo,
  ModelListItem,
  PermissionRequestEvent,
  PlanConfirmEvent,
  Schedule,
  SessionAutoApproveMode,
  SessionMemoryNote,
  SessionMetadata,
  SessionStartResponse,
  ToolActivityEvent
} from "../../shared/ipc.js";
import type { PermissionMode, TandemConfig } from "../../../src/config/schema.js";
import { parseLoop } from "../../../src/commands/loop.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import "./styles.css";

type Role = "user" | "leader" | "worker" | "system";

type TranscriptEntry =
  | { id: number; kind: "message"; role: Role; text: string; thinking?: boolean }
  | { id: number; kind: "artifact"; name: string; value: unknown; open: boolean }
  | { id: number; kind: "tool"; event: ToolActivityEvent };

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function artifactSummary(name: string, value: unknown): string {
  const item = value as {
    tasks?: unknown[];
    feedback?: unknown[];
    verdict?: string;
    scores?: { correctness?: number; planAdherence?: number; codeQuality?: number };
    summary?: string;
  };
  if (name === "BuildPlan") return `${item.tasks?.length ?? 0} task(s)`;
  if (name === "ReviewVerdict") {
    const scores = item.scores ? ` ${item.scores.correctness}/${item.scores.planAdherence}/${item.scores.codeQuality}` : "";
    return `${item.verdict ?? "verdict"}${scores}`;
  }
  if (name.includes("Report")) return item.summary ?? "completion report";
  return "artifact";
}

function roleLabel(role: Role): string {
  if (role === "leader") return "LEADER";
  if (role === "worker") return "WORKER";
  if (role === "system") return "SYSTEM";
  return "YOU";
}

function missingKeyFromMessage(message: string): MissingKeyInfo | undefined {
  const match = /Missing\s+([A-Z0-9_]+)\s+for model\s+(.+?)(?:\.\s+Add|\.$)/.exec(message);
  if (!match) return undefined;
  return {
    key: match[1] ?? "",
    model: match[2] ?? "",
    projectEnvPath: "<projectDir>\\.env",
    globalEnvPath: "~\\.tandem\\.env"
  };
}

function sessionStartedText(session: SessionStartResponse): string {
  const permissionMode = session.projectConfigOverrides?.includes("permissionMode")
    ? `${session.config.permissionMode} (project override)`
    : session.config.permissionMode;
  const instructions = session.projectInstructions
    ? `, project instructions: ${session.projectInstructions.fileName} (${session.projectInstructions.chars} chars${session.projectInstructions.truncated ? ", truncated" : ""})`
    : "";
  return `Session ${session.sessionId} started; working in ${session.projectDir} (${session.projectSummary}) - leader ${session.config.leader}, worker ${session.config.worker}, permissions ${permissionMode}${instructions}`;
}

function displayPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? filePath;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitCommand(input: string): string[] {
  const matches = input.match(/"[^"]*"|\S+/g) ?? [];
  return matches.map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part));
}

function composerHelpText(): string {
  return [
    "Composer commands:",
    "/help",
    "/models",
    "/model leader <id>",
    "/model worker <id>",
    "/rounds <n>",
    "/status",
    "/cost",
    "/goal add <text>",
    "/goal list",
    "/goal done <n>",
    "/loop <30s|5m|2h> <prompt>",
    "/loop stop",
    "/schedule \"<cron>\" <prompt>",
    "/schedule list",
    "/schedule rm <id>"
  ].join("\n");
}

function relativeTime(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function secondsSince(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatToolLine(event: ToolActivityEvent): string {
  const status = event.phase === "start" ? "running" : event.ok ? `ok ${((event.ms ?? 0) / 1000).toFixed(1)}s` : `failed ${((event.ms ?? 0) / 1000).toFixed(1)}s`;
  return `tool ${event.role} - ${event.tool}: ${event.target} - ${status}`;
}

function mediaBadge(model: Pick<ModelListItem, "media">): string {
  const values = [model.media?.images ? "img" : "", model.media?.pdf ? "pdf" : ""].filter(Boolean);
  return values.length > 0 ? ` [${values.join("+")}]` : "";
}

function unavailableModelText(model: ModelListItem): string {
  if (model.available) return "";
  if (model.provider === "codex-cli") return " (Codex CLI missing)";
  if (model.provider === "claude-code-cli") return " (Claude Code CLI missing)";
  return ` (${model.envKey} missing)`;
}

function App(): React.ReactElement {
  const tandem = window.tandem;
  if (!tandem) {
    return (
      <main className="errorBoundary">
        <h1>Preload bridge failed to load</h1>
        <pre>preload bridge failed to load - see main process logs</pre>
      </main>
    );
  }

  const [session, setSession] = useState<SessionStartResponse>();
  const needsProjectPick = !session || Boolean(session.defaultProject);
  const [config, setConfig] = useState<TandemConfig>();
  const [appState, setAppState] = useState<DesktopAppStateResponse>();
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>([{ id: 1, kind: "message", role: "system", text: "Choose a project folder to start Tandem." }]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("IDLE");
  const [round, setRound] = useState(0);
  const [cost, setCost] = useState<CostTotals>();
  const [permissionModal, setPermissionModal] = useState<PermissionRequestEvent>();
  const [planModal, setPlanModal] = useState<PlanConfirmEvent>();
  const [missingKey, setMissingKey] = useState<MissingKeyInfo>();
  const [sessionAutoApprove, setSessionAutoApprove] = useState<SessionAutoApproveMode>("none");
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingRoles, setThinkingRoles] = useState<Set<"leader" | "worker">>(new Set());
  const [activityPulse, setActivityPulse] = useState<{ role: "leader" | "worker"; kind: "thinking" | "writing"; startedAt: number }>();
  const [activeTool, setActiveTool] = useState<(ToolActivityEvent & { startedAt: number }) | undefined>();
  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const [activityTick, setActivityTick] = useState(Date.now());
  const [showActivity, setShowActivity] = useState(false);
  const [runActivityCount, setRunActivityCount] = useState(0);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingSession, setRenamingSession] = useState<string>();
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionMetadata>();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [memoryNotes, setMemoryNotes] = useState<SessionMemoryNote[]>([]);
  const [showMemory, setShowMemory] = useState(true);
  const [memoryText, setMemoryText] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [goalText, setGoalText] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const nextId = useRef(2);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showThinkingRef = useRef(false);
  const thinkingTimers = useRef<Partial<Record<"leader" | "worker", ReturnType<typeof setTimeout>>>>({});
  const loopTimerRef = useRef<ReturnType<typeof setInterval>>();
  const loopRunningRef = useRef(false);

  const effectiveConfig = session?.config ?? config;
  const contextProjectDir = session?.projectDir ?? appState?.lastProjectDir ?? appState?.projectDir;
  const totalCost = useMemo(() => {
    if (!cost) return "$0.0000";
    return `$${(cost.leader.dollars + cost.worker.dollars).toFixed(4)}`;
  }, [cost]);

  const costTitle = cost
    ? `Leader: ${cost.leader.inputTokens}/${cost.leader.outputTokens} tokens, $${cost.leader.dollars.toFixed(4)}${effectiveConfig?.leader === "codex/cli" ? " (billed via your Codex CLI account, not by token price)" : ""}${effectiveConfig?.leader === "claude-code/cli" ? " (reported directly by Claude Code CLI)" : ""}\nWorker: ${cost.worker.inputTokens}/${cost.worker.outputTokens} tokens, $${cost.worker.dollars.toFixed(4)}${effectiveConfig?.worker === "codex/cli" ? " (billed via your Codex CLI account, not by token price)" : ""}${effectiveConfig?.worker === "claude-code/cli" ? " (reported directly by Claude Code CLI)" : ""}`
    : "No usage yet";

  const appendMessage = (role: Role, text: string) => {
    setEntries((current) => [...current, { id: nextId.current++, kind: "message", role, text }]);
  };

  const addAttachmentsFromFiles = async (files: FileList | File[]) => {
    const fileItems = Array.from(files);
    const paths = fileItems.map((file) => (file as unknown as { path?: string }).path).filter((value): value is string => Boolean(value));
    try {
      const added: AttachmentRef[] = [];
      if (paths.length > 0) added.push(...(await tandem.addAttachmentFiles({ paths })));
      for (const file of fileItems) {
        const filePath = (file as unknown as { path?: string }).path;
        if (filePath) continue;
        const fallbackName = file.name || `pasted-${Date.now()}.png`;
        added.push(await tandem.addAttachmentData({ name: fallbackName, data: new Uint8Array(await file.arrayBuffer()) }));
      }
      setAttachments((current) => [...current, ...added]);
    } catch (error) {
      appendMessage("system", `Attach file failed: ${errorText(error)}`);
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    try {
      const saved: AttachmentRef[] = [];
      const pastedAt = Date.now();
      for (let index = 0; index < imageFiles.length; index += 1) {
        const file = imageFiles[index] as File;
        saved.push(await tandem.addAttachmentData({ name: `pasted-${pastedAt}${index === 0 ? "" : `-${index + 1}`}.png`, data: new Uint8Array(await file.arrayBuffer()) }));
      }
      setAttachments((current) => [...current, ...saved]);
    } catch (error) {
      appendMessage("system", `Attach pasted image failed: ${errorText(error)}`);
    }
  };

  const removeAttachment = (filePath: string) => {
    setAttachments((current) => current.filter((item) => item.path !== filePath));
  };

  const markActivity = (role: "leader" | "worker", kind: "thinking" | "writing") => {
    const now = Date.now();
    setLastActivityAt(now);
    setActivityPulse({ role, kind, startedAt: now });
  };

  const appendToolActivity = (event: ToolActivityEvent) => {
    setEntries((current) => [...current, { id: nextId.current++, kind: "tool", event }]);
    setRunActivityCount((count) => count + 1);
  };

  const appendStream = (role: "leader" | "worker", delta: string) => {
    if (delta) markActivity(role, "writing");
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.kind === "message" && last.role === role && !last.thinking) {
        return [...current.slice(0, -1), { ...last, text: `${last.text}${delta}` }];
      }
      if (!delta.trim()) return current;
      return [...current, { id: nextId.current++, kind: "message", role, text: delta }];
    });
  };

  const trimTrailingAgentBubble = () => {
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.kind !== "message" || (last.role !== "leader" && last.role !== "worker") || last.thinking) return current;
      const text = last.text.trimEnd();
      if (!text) return current.slice(0, -1);
      if (text === last.text) return current;
      return [...current.slice(0, -1), { ...last, text }];
    });
  };

  const markThinking = (role: "leader" | "worker") => {
    markActivity(role, "thinking");
    setThinkingRoles((current) => new Set(current).add(role));
    const existing = thinkingTimers.current[role];
    if (existing) clearTimeout(existing);
    thinkingTimers.current[role] = setTimeout(() => {
      setThinkingRoles((current) => {
        const next = new Set(current);
        next.delete(role);
        return next;
      });
    }, 1200);
  };

  const appendThinking = (role: "leader" | "worker", delta: string) => {
    if (delta) markActivity(role, "thinking");
    if (!showThinkingRef.current) {
      markThinking(role);
      return;
    }
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.kind === "message" && last.role === role && last.thinking) {
        return [...current.slice(0, -1), { ...last, text: `${last.text}${delta}` }];
      }
      return [...current, { id: nextId.current++, kind: "message", role, text: delta, thinking: true }];
    });
  };

  const handleMachineEvent = (event: MachineEvent) => {
    setLastActivityAt(Date.now());
    if (event.type === "transition") {
      setPhase(event.phase);
      appendMessage("system", event.message);
    } else if (event.type === "artifact") {
      setEntries((current) => [...current, { id: nextId.current++, kind: "artifact", name: event.name, value: event.value, open: false }]);
    } else if (event.type === "checkpoint") {
      setPhase(event.checkpoint.phase);
      setRound(event.checkpoint.round);
    } else {
      appendMessage("system", event.message);
    }
  };

  const refreshSidebar = async () => {
    const [sessionIds, goalItems, memoryItems, scheduleItems] = await Promise.all([tandem.listSessions(), tandem.listGoals(), tandem.listMemory(), tandem.listSchedules()]);
    setSessions(sessionIds);
    setGoals(goalItems);
    setMemoryNotes(memoryItems);
    setSchedules(scheduleItems);
  };

  const applyStartedSession = async (started: SessionStartResponse, resetTranscript: boolean) => {
    if (loopTimerRef.current) {
      clearInterval(loopTimerRef.current);
      loopTimerRef.current = undefined;
      appendMessage("system", "Loop cleared: project/session changed.");
    }
    loopRunningRef.current = false;
    setSession(started);
    setConfig(started.config);
    setAppState({ projectDir: started.projectDir, lastProjectDir: started.defaultProject ? appState?.lastProjectDir : started.projectDir, config: started.config, projectSummary: started.projectSummary });
    setShowThinking(started.config.showThinking);
    showThinkingRef.current = started.config.showThinking;
    const startEntry = { id: nextId.current++, kind: "message" as const, role: "system" as const, text: sessionStartedText(started) };
    if (resetTranscript) setEntries([startEntry]);
    else setEntries((current) => [...current, startEntry]);
    setPhase("IDLE");
    setRound(0);
    setCost(undefined);
    setActiveTool(undefined);
    setActivityPulse(undefined);
    setLastActivityAt(Date.now());
    setActivityTick(Date.now());
    setShowActivity(false);
    setRunActivityCount(0);
    setSessionAutoApprove("none");
    setModels(await tandem.listModels());
    await refreshSidebar();
  };

  const startProjectSession = async (projectDir?: string) => {
    try {
      await applyStartedSession(await tandem.startSession({ projectDir }), true);
    } catch (error) {
      appendMessage("system", `Start session failed: ${errorText(error)}`);
    }
  };

  const replaySession = async (id: string) => {
    let resumed;
    try {
      resumed = await tandem.resumeSession({ id });
    } catch (error) {
      appendMessage("system", `Resume session failed: ${errorText(error)}`);
      await refreshSidebar();
      return;
    }
    setSession((current) => (current ? { ...current, sessionId: id, defaultProject: false } : current));
    const replayed: TranscriptEntry[] = [];
    for (const stored of resumed.events) {
      const payload = stored.payload as { prompt?: string; role?: "leader" | "worker"; delta?: string; summary?: string; takeover?: boolean } | MachineEvent;
      if (stored.type === "user" && "prompt" in payload) replayed.push({ id: nextId.current++, kind: "message", role: "user", text: payload.prompt ?? "" });
      if (stored.type === "text" && "role" in payload && "delta" in payload) {
        const last = replayed.at(-1);
        if (last?.kind === "message" && last.role === payload.role) last.text += payload.delta ?? "";
        else replayed.push({ id: nextId.current++, kind: "message", role: payload.role ?? "system", text: payload.delta ?? "" });
      }
      if (stored.type === "thinking" && showThinking && "role" in payload && "delta" in payload) {
        const last = replayed.at(-1);
        if (last?.kind === "message" && last.role === payload.role && last.thinking) last.text += payload.delta ?? "";
        else replayed.push({ id: nextId.current++, kind: "message", role: payload.role ?? "system", text: payload.delta ?? "", thinking: true });
      }
      if (stored.type === "machine") {
        const event = payload as MachineEvent;
        if (event.type === "artifact") replayed.push({ id: nextId.current++, kind: "artifact", name: event.name, value: event.value, open: false });
        if (event.type === "transition") replayed.push({ id: nextId.current++, kind: "message", role: "system", text: event.message });
        if (event.type === "error") replayed.push({ id: nextId.current++, kind: "message", role: "system", text: event.message });
        if (event.type === "checkpoint") {
          setPhase(event.checkpoint.phase);
          setRound(event.checkpoint.round);
        }
      }
      if (stored.type === "done" && "summary" in payload) {
        replayed.push({ id: nextId.current++, kind: "message", role: "system", text: `${payload.summary}${payload.takeover ? " (takeover)" : ""}` });
      }
    }
    replayed.push({ id: nextId.current++, kind: "message", role: "system", text: `Resumed session ${id}. The next prompt will continue from its latest checkpoint.` });
    setEntries(replayed.length > 1 ? replayed : [{ id: nextId.current++, kind: "message", role: "system", text: `Session ${id} has no transcript events.` }]);
    await refreshSidebar();
  };

  const handleToolEvent = (event: ToolActivityEvent) => {
    const now = Date.now();
    setLastActivityAt(now);
    if (event.phase === "start") {
      setActiveTool({ ...event, startedAt: now });
    } else {
      appendToolActivity(event);
      setActiveTool((current) => (current?.role === event.role && current.tool === event.tool && current.target === event.target ? undefined : current));
    }
  };

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  useEffect(() => {
    showThinkingRef.current = showThinking;
  }, [showThinking]);

  useEffect(() => {
    const removers = [
      tandem.onTextEvent((event) => (event.thinking ? appendThinking(event.role, event.delta) : appendStream(event.role, event.delta))),
      tandem.onToolEvent(handleToolEvent),
      tandem.onMemoryEvent((event) => setMemoryNotes(event.notes)),
      tandem.onMachineEvent(handleMachineEvent),
      tandem.onCostEvent(setCost),
      tandem.onDoneEvent((event) => {
        setRunning(false);
        setPhase(event.error ? "IDLE" : "DONE");
        setMissingKey(event.missingKey);
        trimTrailingAgentBubble();
        appendMessage("system", `${event.summary}${event.takeover ? " (takeover)" : ""}`);
      }),
      tandem.onPermissionRequest((event) => {
        setPermissionModal(event);
      }),
      tandem.onPlanConfirm(setPlanModal)
    ];

    void Promise.all([tandem.getAppState(), tandem.listModels(), refreshSidebar()])
      .then(([state, modelItems]) => {
        setAppState(state);
        setConfig(state.config);
        setShowThinking(state.config.showThinking);
        showThinkingRef.current = state.config.showThinking;
        setModels(modelItems);
      })
      .catch((error: unknown) => {
        appendMessage("system", `Failed to initialize desktop data: ${errorText(error)}`);
      });

    return () => {
      for (const remove of removers) remove();
      for (const timer of Object.values(thinkingTimers.current)) {
        if (timer) clearTimeout(timer);
      }
      if (loopTimerRef.current) clearInterval(loopTimerRef.current);
      loopTimerRef.current = undefined;
      loopRunningRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setActivityTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const updateModel = async (role: "leader" | "worker", modelId: string) => {
    const nextConfig = await tandem.setConfig({ [role]: modelId });
    setConfig(nextConfig);
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const updatePermissionMode = async (permissionMode: PermissionMode) => {
    const nextConfig = await tandem.setConfig({ permissionMode });
    setConfig(nextConfig);
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
    if (running) appendMessage("system", "permission mode applies from the next run.");
  };

  const updateShowThinking = async (value: boolean) => {
    setShowThinking(value);
    showThinkingRef.current = value;
    const nextConfig = await tandem.setConfig({ showThinking: value });
    setConfig(nextConfig);
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const pickProject = async () => {
    const folder = await tandem.pickFolder();
    if (folder) await startProjectSession(folder);
  };

  const createNewSession = async () => {
    if (!session || session.defaultProject) {
      await pickProject();
      return;
    }
    await startProjectSession(session.projectDir);
  };

  const continueLastProject = async () => {
    const projectDir = appState?.lastProjectDir ?? appState?.projectDir;
    if (projectDir) await startProjectSession(projectDir);
  };

  const addGoal = async () => {
    const text = goalText.trim();
    if (!text) return;
    setGoals(await tandem.addGoal({ text }));
    setGoalText("");
  };

  const completeGoal = async (id: number) => {
    setGoals(await tandem.completeGoal({ id }));
  };

  const addMemory = async () => {
    const text = memoryText.trim();
    if (!text) return;
    try {
      setMemoryNotes(await tandem.addMemory({ text }));
      setMemoryText("");
    } catch (error) {
      appendMessage("system", `Add note failed: ${errorText(error)}`);
    }
  };

  const removeMemory = async (id: string) => {
    try {
      setMemoryNotes(await tandem.removeMemory({ id }));
    } catch (error) {
      appendMessage("system", `Delete note failed: ${errorText(error)}`);
    }
  };

  const addSchedule = async () => {
    if (!scheduleCron.trim() || !schedulePrompt.trim()) return;
    setSchedules(await tandem.addSchedule({ cron: scheduleCron.trim(), prompt: schedulePrompt.trim() }));
    setScheduleCron("");
    setSchedulePrompt("");
  };

  const removeSchedule = async (id: string) => {
    setSchedules(await tandem.removeSchedule({ id }));
  };

  const beginRenameSession = (item: SessionMetadata) => {
    setRenamingSession(item.id);
    setRenameTitle(item.title);
  };

  const saveRenameSession = async () => {
    if (!renamingSession) return;
    try {
      setSessions(await tandem.renameSession({ id: renamingSession, title: renameTitle }));
      setRenamingSession(undefined);
      setRenameTitle("");
    } catch (error) {
      appendMessage("system", `Rename session failed: ${errorText(error)}`);
      await refreshSidebar();
    }
  };

  const archiveSession = async (id: string, archived: boolean) => {
    try {
      setSessions(await tandem.archiveSession({ id, archived }));
      appendMessage("system", archived ? "Session moved to Archived." : "Session restored to active sessions.");
    } catch (error) {
      appendMessage("system", `${archived ? "Archive" : "Unarchive"} session failed: ${errorText(error)}`);
      await refreshSidebar();
    }
  };

  const requestDeleteSession = (item: SessionMetadata) => {
    setDeleteTarget(item);
  };

  const confirmDeleteSession = async () => {
    if (!deleteTarget) return;
    try {
      const response = await tandem.deleteSession({ id: deleteTarget.id });
      setDeleteTarget(undefined);
      setSessions(response.sessions);
      if (response.activeSession) await applyStartedSession(response.activeSession, false);
    } catch (error) {
      appendMessage("system", `Delete session failed: ${errorText(error)}`);
      await refreshSidebar();
    }
  };

  const setSessionAutoApproveMode = async (mode: SessionAutoApproveMode) => {
    setSessionAutoApprove(await tandem.setSessionAutoApprove({ mode }));
  };

  const costText = () => {
    const totals = cost ?? { leader: { inputTokens: 0, outputTokens: 0, dollars: 0 }, worker: { inputTokens: 0, outputTokens: 0, dollars: 0 } };
    return [
      `leader: ${totals.leader.inputTokens} in / ${totals.leader.outputTokens} out / $${totals.leader.dollars.toFixed(4)}`,
      `worker: ${totals.worker.inputTokens} in / ${totals.worker.outputTokens} out / $${totals.worker.dollars.toFixed(4)}`,
      `total: $${(totals.leader.dollars + totals.worker.dollars).toFixed(4)}`
    ].join("\n");
  };

  const statusText = () =>
    [
      `phase: ${phase}`,
      `round: ${round}/${effectiveConfig?.maxReviewRounds ?? 0}`,
      `leader: ${effectiveConfig?.leader ?? "unknown"}`,
      `worker: ${effectiveConfig?.worker ?? "unknown"}`,
      `session: ${session?.sessionId ?? "starting"}`
    ].join("\n");

  const handleComposerCommand = async (input: string): Promise<void> => {
    const [command, ...args] = splitCommand(input);
    try {
      if (command === "/help") {
        appendMessage("system", composerHelpText());
        return;
      }
      if (command === "/models") {
        const items = await tandem.listModels();
        setModels(items);
        appendMessage("system", items.map((model) => `${model.available ? "ok" : "key"} ${model.id}${mediaBadge(model)}${unavailableModelText(model)}`).join("\n") || "No models.");
        return;
      }
      if (command === "/model") {
        const role = args[0];
        const id = args[1];
        if ((role !== "leader" && role !== "worker") || !id) {
          appendMessage("system", "Usage: /model leader <id> or /model worker <id>");
          return;
        }
        const nextConfig = await tandem.setConfig({ [role]: id });
        setConfig(nextConfig);
        setSession((current) => (current ? { ...current, config: nextConfig } : current));
        appendMessage("system", `Set ${role} model to ${id}.`);
        return;
      }
      if (command === "/rounds") {
        const rounds = Number(args[0]);
        if (!Number.isInteger(rounds) || rounds < 0) {
          appendMessage("system", "Usage: /rounds <n>");
          return;
        }
        const nextConfig = await tandem.setConfig({ maxReviewRounds: rounds });
        setConfig(nextConfig);
        setSession((current) => (current ? { ...current, config: nextConfig } : current));
        appendMessage("system", `Set maxReviewRounds to ${rounds}.`);
        return;
      }
      if (command === "/status") {
        appendMessage("system", statusText());
        return;
      }
      if (command === "/cost") {
        appendMessage("system", costText());
        return;
      }
      if (command === "/goal") {
        const sub = args[0];
        if (sub === "add") {
          const text = args.slice(1).join(" ").trim();
          if (!text) {
            appendMessage("system", "Usage: /goal add <text>");
            return;
          }
          const nextGoals = await tandem.addGoal({ text });
          setGoals(nextGoals);
          const added = nextGoals.at(-1);
          appendMessage("system", added ? `Added goal ${added.id}: ${added.text}` : "Goal added.");
          return;
        }
        if (sub === "done") {
          const id = Number(args[1]);
          if (!Number.isInteger(id)) {
            appendMessage("system", "Usage: /goal done <n>");
            return;
          }
          const nextGoals = await tandem.completeGoal({ id });
          setGoals(nextGoals);
          const completed = nextGoals.find((goal) => goal.id === id);
          appendMessage("system", completed ? `Completed goal ${completed.id}: ${completed.text}` : `Completed goal ${id}.`);
          return;
        }
        const nextGoals = await tandem.listGoals();
        setGoals(nextGoals);
        appendMessage("system", nextGoals.length > 0 ? nextGoals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n") : "No goals yet. Add one with /goal add <text>.");
        return;
      }
      if (command === "/loop") {
        const spec = parseLoop(args);
        if (spec === "stop") {
          if (loopTimerRef.current) clearInterval(loopTimerRef.current);
          loopTimerRef.current = undefined;
          appendMessage("system", "Loop stopped.");
          return;
        }
        if (loopTimerRef.current) clearInterval(loopTimerRef.current);
        loopTimerRef.current = setInterval(() => {
          void runSequential(spec.prompt, "loop");
        }, spec.intervalMs);
        void runSequential(spec.prompt, "loop");
        appendMessage("system", `Loop started every ${Math.round(spec.intervalMs / 1000)}s.`);
        return;
      }
      if (command === "/schedule") {
        const sub = args[0];
        if (sub === "list") {
          const items = await tandem.listSchedules();
          appendMessage(
            "system",
            items.map((item) => `${item.id} ${item.cron} ${item.prompt}`).join("\n") || "No schedules."
          );
          return;
        }
        if (sub === "rm") {
          if (!args[1]) {
            appendMessage("system", "Usage: /schedule rm <id>");
            return;
          }
          const next = await tandem.removeSchedule({ id: args[1] });
          setSchedules(next);
          appendMessage("system", `Removed schedule ${args[1]}.`);
          return;
        }
        const cron = args[0];
        const text = args.slice(1).join(" ").trim();
        if (!cron || !text) {
          appendMessage("system", 'Usage: /schedule "<cron>" <prompt>');
          return;
        }
        const next = await tandem.addSchedule({ cron, prompt: text });
        setSchedules(next);
        const added = next.find((item) => item.cron === cron && item.prompt === text);
        appendMessage("system", added ? `Added schedule ${added.id}.` : "Schedule added.");
        return;
      }
      appendMessage("system", "Unknown command - try /help");
    } catch (error) {
      appendMessage("system", `Command failed: ${errorText(error)}`);
    }
  };

  const runSequential = async (prompt: string, source: string): Promise<void> => {
    if (loopRunningRef.current) {
      appendMessage("system", `${source} skipped; previous run still active.`);
      return;
    }
    loopRunningRef.current = true;
    try {
      appendMessage("system", `${source} running.`);
      if (needsProjectPick) {
        appendMessage("system", "Choose a project folder before running Tandem. The default workspace is only a safe holding area.");
        return;
      }
      setRunning(true);
      setActiveTool(undefined);
      setActivityPulse(undefined);
      setPhase("PLANNING");
      try {
        await tandem.runPipeline({ prompt, attachments: [] });
      } catch (error) {
        setRunning(false);
        setPhase("IDLE");
        appendMessage("system", `${source} failed: ${errorText(error)}`);
      }
    } finally {
      loopRunningRef.current = false;
    }
  };

  const send = async () => {
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || running) return;
    setPrompt("");
    if (attachments.length === 0 && text.startsWith("/")) {
      await handleComposerCommand(text);
      return;
    }
    if (needsProjectPick) {
      appendMessage("system", "Choose a project folder before running Tandem. The default workspace is only a safe holding area.");
      return;
    }
    setRunning(true);
    setActiveTool(undefined);
    setActivityPulse(undefined);
    setLastActivityAt(Date.now());
    setActivityTick(Date.now());
    setShowActivity(false);
    setRunActivityCount(0);
    setPhase("PLANNING");
    setMissingKey(undefined);
    const sentAttachments = attachments;
    setAttachments([]);
    const attachmentBlock = sentAttachments.length > 0 ? `\n\n[Attached files: ${sentAttachments.map((item) => item.path).join(", ")}]` : "";
    appendMessage("user", `${text}${attachmentBlock}`);
    try {
      await tandem.runPipeline({ prompt: text, attachments: sentAttachments });
    } catch (error) {
      setRunning(false);
      setPhase("IDLE");
      const message = String(error);
      setMissingKey(missingKeyFromMessage(message));
      trimTrailingAgentBubble();
      appendMessage("system", `Run failed: ${message}`);
    }
  };

  const stop = async () => {
    await tandem.abortPipeline();
    setRunning(false);
    setPhase("IDLE");
    appendMessage("system", "Abort requested.");
  };

  const respondToPermission = (approved: boolean) => {
    if (!permissionModal) return;
    tandem.respondToPermission({ id: permissionModal.id, approved });
    setPermissionModal(undefined);
  };

  const allowEditsForSession = async () => {
    if (!permissionModal) return;
    await setSessionAutoApproveMode("edits");
    if (permissionModal.action === "write" || permissionModal.action === "edit") {
      tandem.respondToPermission({ id: permissionModal.id, approved: true });
      setPermissionModal(undefined);
    }
  };

  const allowAllForSession = async () => {
    if (!permissionModal) return;
    await setSessionAutoApproveMode("all");
    tandem.respondToPermission({ id: permissionModal.id, approved: true });
    setPermissionModal(undefined);
  };

  const respondToPlan = (approved: boolean) => {
    if (!planModal) return;
    tandem.respondToPlan({ id: planModal.id, approved });
    setPlanModal(undefined);
  };

  const activeSessions = sessions.filter((item) => !item.archived);
  const archivedSessions = sessions.filter((item) => item.archived);
  const sessionScopeLabel = contextProjectDir ? displayPath(contextProjectDir) : "current folder";
  const visibleEntries = showActivity ? entries : entries.filter((entry) => entry.kind !== "tool");
  const fallbackRole: "leader" | "worker" = phase === "BUILDING" ? "worker" : "leader";
  const noActivitySeconds = secondsSince(lastActivityAt, activityTick);
  const stripRole = activeTool?.role ?? activityPulse?.role ?? fallbackRole;
  const activityText = activeTool
    ? `running: ${activeTool.target} (${secondsSince(activeTool.startedAt, activityTick)}s)`
    : activityPulse
      ? `${activityPulse.kind === "thinking" ? "thinking" : "writing"}... (${secondsSince(activityPulse.startedAt, activityTick)}s)`
      : `waiting for model... (${noActivitySeconds}s)`;
  const stripText = noActivitySeconds > 60 ? `no activity for ${noActivitySeconds}s - the model call may be stalled (Stop to abort)` : activityText;

  return (
    <main
      className="shell"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!needsProjectPick) void addAttachmentsFromFiles(event.dataTransfer.files);
      }}
    >
      <aside className="sidebar">
        <div className="brand">Tandem</div>
        <div className="projectPath">{contextProjectDir ?? "No project loaded"}</div>
        <button type="button" className="sidebarButton" onClick={() => void pickProject()}>
          Pick Folder
        </button>
        <button type="button" className="sidebarButton" onClick={() => void createNewSession()}>
          New session
        </button>
        <div className="sideSection">
          <div className="sideLabel">Session</div>
          <div className="sideValue">{session?.sessionId ?? "not started"}</div>
        </div>
        <div className="sideSection">
          <div className="sideLabel">Sessions - {sessionScopeLabel}</div>
          <div className="sideList">
            {activeSessions.map((item) => (
              <div key={item.id} className="sessionRow">
                {renamingSession === item.id ? (
                  <input
                    className="renameInput"
                    value={renameTitle}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setRenameTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveRenameSession();
                      if (event.key === "Escape") setRenamingSession(undefined);
                    }}
                  />
                ) : (
                  <button type="button" className="sessionTitle" onClick={() => void replaySession(item.id)}>
                    <span>{item.title || item.id.slice(0, 8)}</span>
                    <small>{relativeTime(item.lastActiveAt)}{item.id === session?.sessionId ? " (current)" : ""}</small>
                  </button>
                )}
                <div className="sessionActions">
                  {renamingSession === item.id ? (
                    <button type="button" onClick={() => void saveRenameSession()}>Save</button>
                  ) : (
                    <button type="button" onClick={() => beginRenameSession(item)}>Rename</button>
                  )}
                  <button type="button" onClick={() => void archiveSession(item.id, true)}>Archive</button>
                  <button type="button" className="dangerAction" onClick={() => requestDeleteSession(item)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="linkButton" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide" : "Show"} Archived ({archivedSessions.length})
          </button>
          {showArchived ? (
            <div className="sideList">
              {archivedSessions.map((item) => (
                <div key={item.id} className="sessionRow archived">
                  <button type="button" className="sessionTitle" onClick={() => void replaySession(item.id)}>
                    <span>{item.title || item.id.slice(0, 8)}</span>
                    <small>{relativeTime(item.lastActiveAt)}{item.id === session?.sessionId ? " (current)" : ""}</small>
                  </button>
                  <div className="sessionActions">
                    <button type="button" onClick={() => void archiveSession(item.id, false)}>Unarchive</button>
                    <button type="button" className="dangerAction" onClick={() => requestDeleteSession(item)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="sideSection">
          <div className="sideLabel">Goals</div>
          <div className="compactForm">
            <input value={goalText} placeholder="Add goal" onChange={(event) => setGoalText(event.target.value)} />
            <button type="button" onClick={() => void addGoal()}>
              Add
            </button>
          </div>
          <div className="sideList">
            {goals.map((goal) => (
              <button key={goal.id} type="button" className={goal.status === "done" ? "linkButton done" : "linkButton"} onClick={() => void completeGoal(goal.id)}>
                {goal.id}. {goal.text}
              </button>
            ))}
          </div>
        </div>
        <div className="sideSection">
          <button type="button" className="sideHeaderButton" onClick={() => setShowMemory((value) => !value)}>
            <span>Session notes</span>
            <small>{showMemory ? "Hide" : "Show"} ({memoryNotes.length})</small>
          </button>
          {showMemory ? (
            <>
              <div className="compactForm">
                <input
                  value={memoryText}
                  placeholder="Add note"
                  maxLength={300}
                  onChange={(event) => setMemoryText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addMemory();
                  }}
                />
                <button type="button" onClick={() => void addMemory()}>
                  Add
                </button>
              </div>
              <div className="sideList">
                {memoryNotes.map((note) => (
                  <div key={note.id} className="memoryRow">
                    <span className={`memoryBadge ${note.by}`}>{note.by}</span>
                    <span className="memoryText">{note.text}</span>
                    <button type="button" aria-label={`Delete note ${note.text}`} onClick={() => void removeMemory(note.id)}>
                      X
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="sideSection">
          <div className="sideLabel">Schedules</div>
          <div className="scheduleForm">
            <input value={scheduleCron} placeholder="*/30 * * * *" onChange={(event) => setScheduleCron(event.target.value)} />
            <input value={schedulePrompt} placeholder="Prompt" onChange={(event) => setSchedulePrompt(event.target.value)} />
            <button type="button" onClick={() => void addSchedule()}>
              Add
            </button>
          </div>
          <div className="sideList">
            {schedules.map((schedule) => (
              <button key={schedule.id} type="button" className="linkButton" onClick={() => void removeSchedule(schedule.id)}>
                {schedule.cron} {schedule.prompt}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="statusBar">
          <label>
            Leader
            <select value={effectiveConfig?.leader ?? ""} onChange={(event) => void updateModel("leader", event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.id}
                  {mediaBadge(model)}
                  {unavailableModelText(model)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worker
            <select value={effectiveConfig?.worker ?? ""} onChange={(event) => void updateModel("worker", event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.id}
                  {mediaBadge(model)}
                  {unavailableModelText(model)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permissions
            <select value={effectiveConfig?.permissionMode ?? "ask"} onChange={(event) => void updatePermissionMode(event.target.value as PermissionMode)}>
              <option value="ask">Ask</option>
              <option value="auto-edit">Auto-edit</option>
              <option value="yolo">Auto</option>
            </select>
          </label>
          <label className="checkRow">
            <input type="checkbox" checked={showThinking} onChange={(event) => void updateShowThinking(event.target.checked)} />
            Show thinking
          </label>
          <span className="phaseChip">{phase}</span>
          {sessionAutoApprove !== "none" ? (
            <span className="autoApproveChip">
              auto-approving: {sessionAutoApprove === "edits" ? "edits" : "all"}
              <button type="button" aria-label="Revoke session auto-approval" onClick={() => void setSessionAutoApproveMode("none")}>
                x
              </button>
            </span>
          ) : null}
          <span>Round {round}/{effectiveConfig?.maxReviewRounds ?? 0}</span>
          <span title={costTitle}>{totalCost}</span>
        </header>
        <section className="transcript">
          {missingKey ? (
            <aside className="noticeBanner">
              <strong>Missing API key: {missingKey.key}</strong>
              <span>
                Model {missingKey.model} needs this key. Add it to <code>{missingKey.projectEnvPath}</code> for this project or <code>{missingKey.globalEnvPath}</code> globally, then start the run again.
              </span>
            </aside>
          ) : null}
          {needsProjectPick ? (
            <aside className="noticeBanner chooseProject">
              <strong>Choose your project folder</strong>
              <span>
                Tandem will not modify files until you pick the folder for this session.
              </span>
              <div className="noticeActions">
                {appState?.lastProjectDir ? (
                  <button type="button" onClick={() => void continueLastProject()}>
                    Continue in {displayPath(appState.lastProjectDir)}
                  </button>
                ) : null}
                <button type="button" onClick={() => void pickProject()}>
                  Pick Folder
                </button>
              </div>
            </aside>
          ) : null}
          {runActivityCount > 0 ? (
            <button type="button" className="activityToggle" onClick={() => setShowActivity((value) => !value)}>
              {showActivity ? "hide" : "show"} activity ({runActivityCount})
            </button>
          ) : null}
          {visibleEntries.map((entry) =>
            entry.kind === "message" ? (
              <article
                key={entry.id}
                className={`bubble ${entry.role}${entry.thinking ? " thinking" : ""}${(entry.role === "leader" || entry.role === "worker") && thinkingRoles.has(entry.role) ? " thinkingActive" : ""}`}
              >
                <div className="roleBadge">{roleLabel(entry.role)}</div>
                <div className="messageText">{entry.text}</div>
              </article>
            ) : entry.kind === "tool" ? (
              <article key={entry.id} className="toolLine">
                {formatToolLine(entry.event)}
              </article>
            ) : (
              <article key={entry.id} className="artifactCard">
                <button
                  type="button"
                  className="artifactHeader"
                  onClick={() => {
                    setEntries((current) => current.map((item) => (item.id === entry.id && item.kind === "artifact" ? { ...item, open: !item.open } : item)));
                  }}
                >
                  <span>{entry.name}</span>
                  <span>{artifactSummary(entry.name, entry.value)}</span>
                </button>
                {entry.open ? <pre className="artifactBody">{pretty(entry.value)}</pre> : null}
              </article>
            )
          )}
          <div ref={transcriptEnd} />
        </section>
        {running ? (
          <section className={`activityStrip ${stripRole}${noActivitySeconds > 60 ? " stalled" : ""}`}>
            <span className="activityDot" />
            <strong>{stripRole.toUpperCase()}</strong>
            <span>{stripText}</span>
          </section>
        ) : null}
        <footer className="composer">
          {attachments.length > 0 ? (
            <div className="attachmentTray">
              {attachments.map((attachment) => (
                <button key={attachment.path} type="button" className="attachmentChip" onClick={() => removeAttachment(attachment.path)}>
                  {attachment.name} <span>{formatAttachmentSize(attachment.size)}</span> <strong>x</strong>
                </button>
              ))}
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hiddenFileInput"
            onChange={(event) => {
              if (event.currentTarget.files) void addAttachmentsFromFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button type="button" className="attachButton" disabled={running || needsProjectPick} onClick={() => fileInputRef.current?.click()}>
            Attach
          </button>
          <textarea
            placeholder="Ask Tandem to build something..."
            rows={3}
            value={prompt}
            disabled={running || needsProjectPick}
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={(event) => void handlePaste(event)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" onClick={() => void (running ? stop() : needsProjectPick ? pickProject() : send())}>
            {running ? "Stop" : needsProjectPick ? "Pick Folder" : "Send"}
          </button>
        </footer>
      </section>

      {planModal ? (
        <div className="modalShade">
          <section className="modal">
            <h2>Approve Plan</h2>
            <pre className="modalBody">{pretty(planModal.plan)}</pre>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => respondToPlan(false)}>
                Reject
              </button>
              <button type="button" onClick={() => respondToPlan(true)}>
                Approve
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {permissionModal ? (
        <div className="modalShade">
          <section className="modal">
            <h2>Permission Request</h2>
            <div className="permissionTarget">
              <strong>{permissionModal.action}</strong>
              <code>{permissionModal.target}</code>
            </div>
            <div className="modalActions">
              <button type="button" className="secondary" disabled={permissionModal.action === "bash"} onClick={() => void allowEditsForSession()}>
                Allow all edits this session
              </button>
              <button type="button" className="secondary" onClick={() => void allowAllForSession()}>
                Allow everything this session
              </button>
              <button type="button" className="secondary" onClick={() => respondToPermission(false)}>
                Deny
              </button>
              <button type="button" onClick={() => respondToPermission(true)}>
                Allow
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modalShade">
          <section className="modal">
            <h2>Delete Session</h2>
            <p className="modalText">
              Delete session "{deleteTarget.title || deleteTarget.id.slice(0, 8)}"? This permanently removes its transcript. The project files are not affected.
            </p>
            <div className="modalActions">
              <button type="button" className="secondary" onClick={() => setDeleteTarget(undefined)}>
                Cancel
              </button>
              <button type="button" className="dangerButton" onClick={() => void confirmDeleteSession()}>
                Yes, delete
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
