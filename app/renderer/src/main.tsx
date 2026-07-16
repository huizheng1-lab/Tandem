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
  SessionResumeResponse,
  SessionStartResponse,
  ToolActivityEvent
} from "../../shared/ipc.js";
import { CodexCliReasoningEffortSchema, type DesktopTheme, type PermissionMode, type TandemConfig } from "../../../src/config/schema.js";
import { parseLoop } from "../../../src/commands/loop.js";
import { cliModelPatch, modelCommandUsage, modelDisplayName } from "../../../src/providers/cli-models.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { activityStripState } from "./activity-strip.js";
import { claudeCliModelOptions } from "./cli-model-options.js";
import { formatTotalCost } from "./cost-display.js";
import { MODEL_STALL_WARNING_SECONDS, effectiveRendererConfig, isSessionActionable, needsProjectPickForSession, sessionFromResume } from "./session-state.js";
import { boundedMessageTextForState, MessageText } from "./TranscriptText.js";
import { applyDesktopTheme, THEME_REFRESH_INTERVAL_MS } from "./theme.js";
import "./styles.css";

type Role = "user" | "leader" | "worker" | "system";
type PendingSessionActionKind = "rename" | "archive" | "unarchive" | "delete" | "switch";
const MAX_TRANSCRIPT_ENTRIES = 600;
const codexEffortOptions = CodexCliReasoningEffortSchema.options;
const cliDefaultOption = "default";

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
  return `Session ${session.sessionId} started; working in ${session.projectDir} (${session.projectSummary}) - leader ${modelDisplayName(session.config.leader, session.config)}, worker ${modelDisplayName(session.config.worker, session.config)}, permissions ${permissionMode}${instructions}`;
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
    "/model claude-cli <model|clear>",
    "/model codex-cli <model|clear>",
    "/model codex-effort <minimal|low|medium|high|clear>",
    "/rounds <n>",
    "/status",
    "/cost",
    "/compact",
    "/goal <text>            record AND start work on it now",
    "/goal add <text>        record only (does not run)",
    "/goal list              list standing goals",
    "/goal done <n>          mark a goal complete (kept in list)",
    "/goal clear             delete every goal (distinct from done)",
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

type ModelSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

function claudeCliSelectValue(model: string): string {
  return `claude-code/cli::model:${model}`;
}

function codexCliSelectValue(effort: string): string {
  return `codex/cli::effort:${effort}`;
}

function roleModelSelectValue(modelId: string | undefined, config: TandemConfig | undefined): string {
  if (modelId === "claude-code/cli") return claudeCliSelectValue(config?.claudeCliModel ?? cliDefaultOption);
  if (modelId === "codex/cli") return codexCliSelectValue(config?.codexCliReasoningEffort ?? cliDefaultOption);
  return modelId ?? "";
}

function cliLabel(modelId: "claude-code/cli" | "codex/cli", config: TandemConfig | undefined, patch: Partial<TandemConfig>): string {
  return modelDisplayName(modelId, config ? { ...config, ...patch } : config);
}

function modelSelectOptions(models: ModelListItem[], config: TandemConfig | undefined): ModelSelectOption[] {
  return models.flatMap((model) => {
    const suffix = `${mediaBadge(model)}${unavailableModelText(model)}`;
    if (model.id === "claude-code/cli") {
      return [
        {
          value: claudeCliSelectValue(cliDefaultOption),
          label: `${cliLabel("claude-code/cli", config, { claudeCliModel: undefined })}${suffix}`,
          disabled: !model.available
        },
        ...claudeCliModelOptions.map((variant) => ({
          value: claudeCliSelectValue(variant),
          label: `${cliLabel("claude-code/cli", config, { claudeCliModel: variant })}${suffix}`,
          disabled: !model.available
        }))
      ];
    }
    if (model.id === "codex/cli") {
      return [
        {
          value: codexCliSelectValue(cliDefaultOption),
          label: `${cliLabel("codex/cli", config, { codexCliReasoningEffort: undefined })}${suffix}`,
          disabled: !model.available
        },
        ...codexEffortOptions.map((effort) => ({
          value: codexCliSelectValue(effort),
          label: `${cliLabel("codex/cli", config, { codexCliReasoningEffort: effort })}${suffix}`,
          disabled: !model.available
        }))
      ];
    }
    return [{ value: model.id, label: `${modelDisplayName(model.id, config)}${suffix}`, disabled: !model.available }];
  });
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
  const [startupError, setStartupError] = useState<{ title: string; message: string }>();
  const needsProjectPick = needsProjectPickForSession(session);
  const [config, setConfig] = useState<TandemConfig>();
  const [appState, setAppState] = useState<DesktopAppStateResponse>();
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>([{ id: 1, kind: "message", role: "system", text: "Choose a project folder to start Tandem." }]);
  const [transcriptTruncated, setTranscriptTruncated] = useState(false);
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
  const [pendingSessionAction, setPendingSessionAction] = useState<{ id: string; kind: PendingSessionActionKind }>();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [memoryNotes, setMemoryNotes] = useState<SessionMemoryNote[]>([]);
  const [showMemory, setShowMemory] = useState(true);
  const [memoryText, setMemoryText] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [goalText, setGoalText] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  // D59: last-copied entry id; used to swap the copy button label to "Copied" briefly.
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const nextId = useRef(2);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showThinkingRef = useRef(false);
  const thinkingTimers = useRef<Partial<Record<"leader" | "worker", ReturnType<typeof setTimeout>>>>({});
  const loopTimerRef = useRef<ReturnType<typeof setInterval>>();
  const loopRunningRef = useRef(false);
  const sessionSwitchRef = useRef<{ id: string; token: number }>();

  const effectiveConfig = effectiveRendererConfig(session, config);
  const desktopTheme = effectiveConfig?.desktopTheme ?? "auto";
  const roleModelOptions = useMemo(() => modelSelectOptions(models, effectiveConfig), [models, effectiveConfig]);
  const contextProjectDir = session?.projectDir ?? appState?.lastProjectDir ?? appState?.projectDir;
  const totalCost = useMemo(() => {
    return formatTotalCost(cost, effectiveConfig, models);
  }, [cost, effectiveConfig, models]);

  const costTitle = cost
    ? `Leader: ${cost.leader.inputTokens}/${cost.leader.outputTokens} tokens, $${cost.leader.dollars.toFixed(4)}${effectiveConfig?.leader === "codex/cli" ? " (billed via your Codex CLI account, not by token price)" : ""}${effectiveConfig?.leader === "claude-code/cli" ? " (reported directly by Claude Code CLI)" : ""}\nWorker: ${cost.worker.inputTokens}/${cost.worker.outputTokens} tokens, $${cost.worker.dollars.toFixed(4)}${effectiveConfig?.worker === "codex/cli" ? " (billed via your Codex CLI account, not by token price)" : ""}${effectiveConfig?.worker === "claude-code/cli" ? " (reported directly by Claude Code CLI)" : ""}`
    : "No usage yet";

  const limitEntries = (items: TranscriptEntry[]): TranscriptEntry[] => items.slice(Math.max(0, items.length - MAX_TRANSCRIPT_ENTRIES));

  const setBoundedEntries = (updater: (current: TranscriptEntry[]) => TranscriptEntry[]) => {
    setEntries((current) => {
      const next = updater(current);
      if (next.length > MAX_TRANSCRIPT_ENTRIES) queueMicrotask(() => setTranscriptTruncated(true));
      return limitEntries(next);
    });
  };

  const replaceTranscript = (items: TranscriptEntry[], truncated: boolean) => {
    setTranscriptTruncated(truncated || items.length > MAX_TRANSCRIPT_ENTRIES);
    setEntries(limitEntries(items));
  };

  const appendMessage = (role: Role, text: string) => {
    setBoundedEntries((current) => [...current, { id: nextId.current++, kind: "message", role, text: boundedMessageTextForState(text) }]);
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
    setBoundedEntries((current) => [...current, { id: nextId.current++, kind: "tool", event }]);
    setRunActivityCount((count) => count + 1);
  };

  const appendStream = (role: "leader" | "worker", delta: string) => {
    if (delta) markActivity(role, "writing");
    setBoundedEntries((current) => {
      const last = current.at(-1);
      if (last?.kind === "message" && last.role === role && !last.thinking) {
        return [...current.slice(0, -1), { ...last, text: boundedMessageTextForState(`${last.text}${delta}`) }];
      }
      if (!delta.trim()) return current;
      return [...current, { id: nextId.current++, kind: "message", role, text: boundedMessageTextForState(delta) }];
    });
  };

  const trimTrailingAgentBubble = () => {
    setBoundedEntries((current) => {
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
        return [...current.slice(0, -1), { ...last, text: boundedMessageTextForState(`${last.text}${delta}`) }];
      }
      return [...current, { id: nextId.current++, kind: "message", role, text: boundedMessageTextForState(delta), thinking: true }];
    });
  };

  const handleMachineEvent = (event: MachineEvent) => {
    setLastActivityAt(Date.now());
    if (event.type === "transition") {
      setPhase(event.phase);
      appendMessage("system", event.message);
    } else if (event.type === "artifact") {
      setBoundedEntries((current) => [...current, { id: nextId.current++, kind: "artifact", name: event.name, value: event.value, open: false }]);
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
    if (resetTranscript) replaceTranscript([startEntry], false);
    else setBoundedEntries((current) => [...current, startEntry]);
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
    if (sessionSwitchRef.current) return;
    const token = Date.now();
    sessionSwitchRef.current = { id, token };
    setPendingSessionAction({ id, kind: "switch" });
    let resumed: SessionResumeResponse;
    try {
      resumed = await tandem.resumeSession({ id });
    } catch (error) {
      if (sessionSwitchRef.current?.token === token) {
        appendMessage("system", `Resume session failed: ${errorText(error)}`);
        await refreshSidebar();
      }
      return;
    } finally {
      if (sessionSwitchRef.current?.token === token) {
        sessionSwitchRef.current = undefined;
        setPendingSessionAction((current) => (current?.id === id && current.kind === "switch" ? undefined : current));
      }
    }
    if (sessionSwitchRef.current && sessionSwitchRef.current.token !== token) return;
    const resumedSession = sessionFromResume(resumed);
    setSession(resumedSession);
    setConfig(resumed.config);
    setAppState({ projectDir: resumed.projectDir, lastProjectDir: resumed.projectDir, config: resumed.config, projectSummary: resumed.projectSummary });
    setShowThinking(resumed.config.showThinking);
    showThinkingRef.current = resumed.config.showThinking;
    const replayed: TranscriptEntry[] = [];
    for (const stored of resumed.events) {
      const payload = stored.payload as { prompt?: string; role?: "leader" | "worker"; delta?: string; summary?: string; takeover?: boolean } | MachineEvent;
      if (stored.type === "user" && "prompt" in payload) replayed.push({ id: nextId.current++, kind: "message", role: "user", text: boundedMessageTextForState(payload.prompt ?? "") });
      if (stored.type === "text" && "role" in payload && "delta" in payload) {
        const last = replayed.at(-1);
        if (last?.kind === "message" && last.role === payload.role) last.text = boundedMessageTextForState(`${last.text}${payload.delta ?? ""}`);
        else replayed.push({ id: nextId.current++, kind: "message", role: payload.role ?? "system", text: boundedMessageTextForState(payload.delta ?? "") });
      }
      if (stored.type === "thinking" && showThinking && "role" in payload && "delta" in payload) {
        const last = replayed.at(-1);
        if (last?.kind === "message" && last.role === payload.role && last.thinking) last.text = boundedMessageTextForState(`${last.text}${payload.delta ?? ""}`);
        else replayed.push({ id: nextId.current++, kind: "message", role: payload.role ?? "system", text: boundedMessageTextForState(payload.delta ?? ""), thinking: true });
      }
      if (stored.type === "machine") {
        const event = payload as MachineEvent;
        if (event.type === "artifact") replayed.push({ id: nextId.current++, kind: "artifact", name: event.name, value: event.value, open: false });
        if (event.type === "transition") replayed.push({ id: nextId.current++, kind: "message", role: "system", text: boundedMessageTextForState(event.message) });
        if (event.type === "error") replayed.push({ id: nextId.current++, kind: "message", role: "system", text: boundedMessageTextForState(event.message) });
        if (event.type === "checkpoint") {
          setPhase(event.checkpoint.phase);
          setRound(event.checkpoint.round);
        }
      }
      if (stored.type === "done" && "summary" in payload) {
        replayed.push({ id: nextId.current++, kind: "message", role: "system", text: boundedMessageTextForState(`${payload.summary}${payload.takeover ? " (takeover)" : ""}`) });
      }
    }
    replayed.push({ id: nextId.current++, kind: "message", role: "system", text: `Resumed session ${id}. The next prompt will continue from its latest checkpoint.` });
    replaceTranscript(replayed.length > 1 ? replayed : [{ id: nextId.current++, kind: "message", role: "system", text: `Session ${id} has no transcript events.` }], Boolean(resumed.eventsTruncated));
    await refreshSidebar();
  };

  const handleToolEvent = (event: ToolActivityEvent) => {
    const now = Date.now();
    setLastActivityAt(now);
    setActivityPulse((current) => (current && current.role !== event.role ? undefined : current));
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
    const refreshTheme = () => applyDesktopTheme(desktopTheme);
    refreshTheme();
    const timer = window.setInterval(refreshTheme, THEME_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshTheme);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshTheme);
    };
  }, [desktopTheme]);

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
        setActivityPulse(undefined);
        setActiveTool(undefined);
        trimTrailingAgentBubble();
        appendMessage("system", `${event.summary}${event.takeover ? " (takeover)" : ""}`);
      }),
      tandem.onPermissionRequest((event) => {
        setPermissionModal(event);
      }),
      tandem.onPlanConfirm(setPlanModal)
    ];

    void tandem.getStartupError()
      .then(async (error) => {
        if (error) {
          setStartupError(error);
          return;
        }
        const [state, modelItems] = await Promise.all([tandem.getAppState(), tandem.listModels(), refreshSidebar()]);
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

  const updateRoleModelSelection = async (role: "leader" | "worker", value: string) => {
    if (value.startsWith("claude-code/cli::model:")) {
      const variant = value.slice("claude-code/cli::model:".length);
      const pin = cliModelPatch("claude-cli", variant === cliDefaultOption ? "clear" : variant);
      const nextConfig = await tandem.setConfig({ [role]: "claude-code/cli", ...pin.patch });
      setConfig(nextConfig);
      setSession((current) => (current ? { ...current, config: nextConfig } : current));
      return;
    }
    if (value.startsWith("codex/cli::effort:")) {
      const effort = value.slice("codex/cli::effort:".length);
      const pin = cliModelPatch("codex-effort", effort === cliDefaultOption ? "clear" : effort);
      const nextConfig = await tandem.setConfig({ [role]: "codex/cli", ...pin.patch });
      setConfig(nextConfig);
      setSession((current) => (current ? { ...current, config: nextConfig } : current));
      return;
    }
    await updateModel(role, value);
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
    setPendingSessionAction({ id: renamingSession, kind: "rename" });
    try {
      setSessions(await tandem.renameSession({ id: renamingSession, title: renameTitle }));
      setRenamingSession(undefined);
      setRenameTitle("");
    } catch (error) {
      appendMessage("system", `Rename session failed: ${errorText(error)}`);
      await refreshSidebar();
    } finally {
      setPendingSessionAction((current) => (current?.id === renamingSession && current.kind === "rename" ? undefined : current));
    }
  };

  const updateDesktopTheme = async (desktopTheme: DesktopTheme) => {
    applyDesktopTheme(desktopTheme);
    const nextConfig = await tandem.setConfig({ desktopTheme });
    setConfig(nextConfig);
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const archiveSession = async (id: string, archived: boolean) => {
    const kind = archived ? "archive" : "unarchive";
    setPendingSessionAction({ id, kind });
    try {
      setSessions(await tandem.archiveSession({ id, archived }));
      appendMessage("system", archived ? "Session moved to Archived." : "Session restored to active sessions.");
    } catch (error) {
      appendMessage("system", `${archived ? "Archive" : "Unarchive"} session failed: ${errorText(error)}`);
      await refreshSidebar();
    } finally {
      setPendingSessionAction((current) => (current?.id === id && current.kind === kind ? undefined : current));
    }
  };

  const requestDeleteSession = (item: SessionMetadata) => {
    setDeleteTarget(item);
  };

  const confirmDeleteSession = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setPendingSessionAction({ id: targetId, kind: "delete" });
    try {
      const response = await tandem.deleteSession({ id: targetId });
      setDeleteTarget(undefined);
      setSessions(response.sessions);
      if (response.activeSession) await applyStartedSession(response.activeSession, false);
    } catch (error) {
      appendMessage("system", `Delete session failed: ${errorText(error)}`);
      await refreshSidebar();
    } finally {
      setPendingSessionAction((current) => (current?.id === targetId && current.kind === "delete" ? undefined : current));
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
      `leader: ${modelDisplayName(effectiveConfig?.leader, effectiveConfig)}`,
      `worker: ${modelDisplayName(effectiveConfig?.worker, effectiveConfig)}`,
      `parallel: ${effectiveConfig?.maxParallelWorkers ?? 1} worker(s) per round`,
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
        appendMessage("system", items.map((model) => `${model.available ? "ok" : "key"} ${modelDisplayName(model.id, effectiveConfig)}${mediaBadge(model)}${unavailableModelText(model)}`).join("\n") || "No models.");
        return;
      }
      if (command === "/model") {
        const role = args[0];
        const id = args[1];
        if (role === "claude-cli" || role === "codex-cli" || role === "codex-effort") {
          const result = cliModelPatch(role, id);
          if (result.usage || !result.patch) {
            appendMessage("system", result.usage ?? modelCommandUsage);
            return;
          }
          const nextConfig = await tandem.setConfig(result.patch);
          setConfig(nextConfig);
          setSession((current) => (current ? { ...current, config: nextConfig } : current));
          appendMessage("system", result.message ?? "Updated CLI model config.");
          return;
        }
        if ((role !== "leader" && role !== "worker") || !id) {
          appendMessage("system", modelCommandUsage);
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
      if (command === "/compact") {
        const result = await tandem.compactSession();
        if (!result) appendMessage("system", "No conversation history to compact yet.");
        return;
      }
      if (command === "/goal") {
        const sub = args[0];
        // /goal list (lone exact token): list goals. Otherwise free-form text starting with "list"
        // must still run as a goal (don't swallow `/goal list the foo` as a list-subcommand).
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
        if (args.length === 1 && sub === "list") {
          const nextGoals = await tandem.listGoals();
          setGoals(nextGoals);
          appendMessage("system", nextGoals.length > 0 ? nextGoals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n") : "No goals yet. Add one with /goal add <text>.");
          return;
        }
if (args.length === 1 && sub === "clear") {
  const removed = await tandem.clearGoals();
  setGoals([]);
  appendMessage("system", `Cleared ${removed} goal(s).`);
  return;
}
        if (args.length === 0) {
          const nextGoals = await tandem.listGoals();
          setGoals(nextGoals);
          appendMessage("system", nextGoals.length > 0 ? nextGoals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n") : "No goals yet. Add one with /goal add <text>.");
          return;
        }
        // Free-form /goal <text>: add as a standing goal AND immediately run through the same
        // pipeline as a plain typed message (matches the user's Claude Code workflow).
        const text = args.join(" ").trim();
        if (!text) {
          const nextGoals = await tandem.listGoals();
          setGoals(nextGoals);
          appendMessage("system", nextGoals.length > 0 ? nextGoals.map((goal) => `${goal.id}. [${goal.status}] ${goal.text}`).join("\n") : "No goals yet. Add one with /goal add <text>.");
          return;
        }
        if (needsProjectPick) {
          appendMessage("system", "Choose a project folder before running Tandem. The default workspace is only a safe holding area.");
          return;
        }
        const nextGoals = await tandem.addGoal({ text });
        setGoals(nextGoals);
        const added = nextGoals.at(-1);
        appendMessage("system", added ? `Added goal ${added.id}: ${added.text}` : "Goal added.");
        appendMessage("user", text);
        setRunning(true);
        setActiveTool(undefined);
        setActivityPulse(undefined);
        setPhase("PLANNING");
        try {
          await tandem.runPipeline({ prompt: text, attachments: [] });
        } catch (error) {
          setRunning(false);
          setPhase("IDLE");
          appendMessage("system", `Run failed: ${errorText(error)}`);
        }
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
  const switchingSessionId = pendingSessionAction?.kind === "switch" ? pendingSessionAction.id : undefined;
  const visibleEntries = useMemo(() => (showActivity ? entries : entries.filter((entry) => entry.kind !== "tool")), [entries, showActivity]);
  const fallbackRole: "leader" | "worker" = phase === "BUILDING" ? "worker" : "leader";
  const noActivitySeconds = secondsSince(lastActivityAt, activityTick);
  const strip = activityStripState({ activeTool, activityPulse, fallbackRole, noActivitySeconds, activityTick, secondsSince });
  const stripRole = strip.role;
  const stripText = strip.text;

  if (startupError) {
    return (
      <main className="errorBoundary">
        <h1>{startupError.title}</h1>
        <p>Tandem could not load its local state. Fix the file named below, then restart the app.</p>
        <pre>{startupError.message}</pre>
      </main>
    );
  }

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
          <div className="sideLabel">Sessions</div>
          <div className="sideList">
            {activeSessions.map((item) => {
              const pendingKind = pendingSessionAction?.id === item.id ? pendingSessionAction.kind : undefined;
              const actionPending = pendingKind !== undefined;
              const switchPending = switchingSessionId !== undefined;
              const isActionable = isSessionActionable(item);
              return (
                <div key={item.id} className="sessionRow">
                  {renamingSession === item.id ? (
                    <input
                      className="renameInput"
                      value={renameTitle}
                      autoFocus
                      disabled={actionPending}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRenameTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !actionPending) void saveRenameSession();
                        if (event.key === "Escape" && !actionPending) setRenamingSession(undefined);
                      }}
                    />
                  ) : (
                    <button type="button" className="sessionTitle" disabled={actionPending || switchPending || !isActionable} onClick={() => void replaySession(item.id)}>
                      <span>{item.title || item.id.slice(0, 8)}</span>
                      <small>
                        {pendingKind === "switch"
                          ? "Switching..."
                          : `${relativeTime(item.lastActiveAt)}${item.id === session?.sessionId ? " (current)" : ""}${item.projectDir ? ` - ${displayPath(item.projectDir)}` : " - unresolved project - cannot resume from global list"}`}
                      </small>
                    </button>
                  )}
                  <div className="sessionActions">
                    {renamingSession === item.id ? (
                      <button type="button" disabled={actionPending || !isActionable} onClick={() => void saveRenameSession()}>{pendingKind === "rename" ? "Renaming..." : "Save"}</button>
                    ) : (
                      <button type="button" disabled={actionPending || !isActionable} onClick={() => beginRenameSession(item)}>Rename</button>
                    )}
                    <button type="button" disabled={actionPending || !isActionable} onClick={() => void archiveSession(item.id, true)}>{pendingKind === "archive" ? "Archiving..." : "Archive"}</button>
                    <button type="button" className="dangerAction" disabled={actionPending || !isActionable} onClick={() => requestDeleteSession(item)}>{pendingKind === "delete" ? "Deleting..." : "Delete"}</button>
                  </div>
                </div>
              );
            })}
          </div>
          <button type="button" className="linkButton" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide" : "Show"} Archived ({archivedSessions.length})
          </button>
          {showArchived ? (
            <div className="sideList">
              {archivedSessions.map((item) => {
                const pendingKind = pendingSessionAction?.id === item.id ? pendingSessionAction.kind : undefined;
                const actionPending = pendingKind !== undefined;
                const switchPending = switchingSessionId !== undefined;
                const isActionable = isSessionActionable(item);
                return (
                  <div key={item.id} className="sessionRow archived">
                    <button type="button" className="sessionTitle" disabled={actionPending || switchPending || !isActionable} onClick={() => void replaySession(item.id)}>
                      <span>{item.title || item.id.slice(0, 8)}</span>
                      <small>
                        {pendingKind === "switch"
                          ? "Switching..."
                          : `${relativeTime(item.lastActiveAt)}${item.id === session?.sessionId ? " (current)" : ""}${item.projectDir ? ` - ${displayPath(item.projectDir)}` : " - unresolved project - cannot resume from global list"}`}
                      </small>
                    </button>
                    <div className="sessionActions">
                      <button type="button" disabled={actionPending || !isActionable} onClick={() => void archiveSession(item.id, false)}>{pendingKind === "unarchive" ? "Unarchiving..." : "Unarchive"}</button>
                      <button type="button" className="dangerAction" disabled={actionPending || !isActionable} onClick={() => requestDeleteSession(item)}>{pendingKind === "delete" ? "Deleting..." : "Delete"}</button>
                    </div>
                  </div>
                );
              })}
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
            <select value={roleModelSelectValue(effectiveConfig?.leader, effectiveConfig)} onChange={(event) => void updateRoleModelSelection("leader", event.target.value)}>
              {roleModelOptions.map((option) => (
                <option key={`leader-${option.value}`} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worker
            <select value={roleModelSelectValue(effectiveConfig?.worker, effectiveConfig)} onChange={(event) => void updateRoleModelSelection("worker", event.target.value)}>
              {roleModelOptions.map((option) => (
                <option key={`worker-${option.value}`} value={option.value} disabled={option.disabled}>
                  {option.label}
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
          <label>
            Theme
            <select value={desktopTheme} onChange={(event) => void updateDesktopTheme(event.target.value as DesktopTheme)}>
              <option value="auto">Auto</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
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
          {transcriptTruncated ? (
            <aside className="noticeBanner">
              <strong>Recent transcript window</strong>
              <span>Older transcript history remains saved on disk; the desktop UI keeps only recent entries in memory.</span>
            </aside>
          ) : null}
          {visibleEntries.map((entry) =>
            entry.kind === "message" ? (
              <article
                key={entry.id}
                className={`bubble ${entry.role}${entry.thinking ? " thinking" : ""}${(entry.role === "leader" || entry.role === "worker") && thinkingRoles.has(entry.role) ? " thinkingActive" : ""}`}
              >
                <div className="roleBadge">{roleLabel(entry.role)}</div>
                <MessageText text={entry.text} />
                <button
                  type="button"
                  className={`copyButton${copiedId === entry.id ? " copied" : ""}`}
                  aria-label="Copy message"
                  title="Copy message"
                  onClick={async (event) => {
                    event.stopPropagation();
                    try {
                      await navigator.clipboard.writeText(entry.text);
                      setCopiedId(entry.id);
                      window.setTimeout(() => {
                        setCopiedId((current) => (current === entry.id ? null : current));
                      }, 1500);
                    } catch (error) {
                      appendMessage("system", `Copy failed: ${errorText(error)}`);
                    }
                  }}
                >
                  {copiedId === entry.id ? "Copied" : "Copy"}
                </button>
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
          <section className={`activityStrip ${stripRole}${strip.stalled ? " stalled" : ""}`}>
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
              <button type="button" className="secondary" disabled={pendingSessionAction?.id === deleteTarget.id} onClick={() => setDeleteTarget(undefined)}>
                Cancel
              </button>
              <button type="button" className="dangerButton" disabled={pendingSessionAction?.id === deleteTarget.id} onClick={() => void confirmDeleteSession()}>
                {pendingSessionAction?.id === deleteTarget.id && pendingSessionAction.kind === "delete" ? "Deleting..." : "Yes, delete"}
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
