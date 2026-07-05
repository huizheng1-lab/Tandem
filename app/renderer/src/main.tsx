import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CostTotals,
  Goal,
  MachineEvent,
  MissingKeyInfo,
  ModelListItem,
  PermissionRequestEvent,
  PlanConfirmEvent,
  Schedule,
  SessionAutoApproveMode,
  SessionMetadata,
  SessionStartResponse
} from "../../shared/ipc.js";
import type { PermissionMode } from "../../../src/config/schema.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import "./styles.css";

type Role = "user" | "leader" | "worker" | "system";

type TranscriptEntry =
  | { id: number; kind: "message"; role: Role; text: string }
  | { id: number; kind: "artifact"; name: string; value: unknown; open: boolean };

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
  return `Session ${session.sessionId} started in ${session.projectDir} - leader ${session.config.leader}, worker ${session.config.worker}, permissions ${session.config.permissionMode}`;
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
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>([{ id: 1, kind: "message", role: "system", text: "Starting desktop session..." }]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("IDLE");
  const [round, setRound] = useState(0);
  const [cost, setCost] = useState<CostTotals>();
  const [permissionModal, setPermissionModal] = useState<PermissionRequestEvent>();
  const [planModal, setPlanModal] = useState<PlanConfirmEvent>();
  const [missingKey, setMissingKey] = useState<MissingKeyInfo>();
  const [sessionAutoApprove, setSessionAutoApprove] = useState<SessionAutoApproveMode>("none");
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingSession, setRenamingSession] = useState<string>();
  const [renameTitle, setRenameTitle] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [goalText, setGoalText] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const nextId = useRef(2);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const totalCost = useMemo(() => {
    if (!cost) return "$0.0000";
    return `$${(cost.leader.dollars + cost.worker.dollars).toFixed(4)}`;
  }, [cost]);

  const costTitle = cost
    ? `Leader: ${cost.leader.inputTokens}/${cost.leader.outputTokens} tokens, $${cost.leader.dollars.toFixed(4)}\nWorker: ${cost.worker.inputTokens}/${cost.worker.outputTokens} tokens, $${cost.worker.dollars.toFixed(4)}`
    : "No usage yet";

  const appendMessage = (role: Role, text: string) => {
    setEntries((current) => [...current, { id: nextId.current++, kind: "message", role, text }]);
  };

  const appendStream = (role: "leader" | "worker", delta: string) => {
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.kind === "message" && last.role === role) {
        return [...current.slice(0, -1), { ...last, text: `${last.text}${delta}` }];
      }
      return [...current, { id: nextId.current++, kind: "message", role, text: delta }];
    });
  };

  const handleMachineEvent = (event: MachineEvent) => {
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
    const [sessionIds, goalItems, scheduleItems] = await Promise.all([tandem.listSessions(), tandem.listGoals(), tandem.listSchedules()]);
    setSessions(sessionIds);
    setGoals(goalItems);
    setSchedules(scheduleItems);
  };

  const startProjectSession = async (projectDir?: string) => {
    const started = await tandem.startSession({ projectDir });
    setSession(started);
    setEntries([{ id: nextId.current++, kind: "message", role: "system", text: sessionStartedText(started) }]);
    setPhase("IDLE");
    setRound(0);
    setCost(undefined);
    setSessionAutoApprove("none");
    setModels(await tandem.listModels());
    await refreshSidebar();
  };

  const replaySession = async (id: string) => {
    const resumed = await tandem.resumeSession({ id });
    const replayed: TranscriptEntry[] = [];
    for (const stored of resumed.events) {
      const payload = stored.payload as { prompt?: string; role?: "leader" | "worker"; delta?: string; summary?: string; takeover?: boolean } | MachineEvent;
      if (stored.type === "user" && "prompt" in payload) replayed.push({ id: nextId.current++, kind: "message", role: "user", text: payload.prompt ?? "" });
      if (stored.type === "text" && "role" in payload && "delta" in payload) {
        const last = replayed.at(-1);
        if (last?.kind === "message" && last.role === payload.role) last.text += payload.delta ?? "";
        else replayed.push({ id: nextId.current++, kind: "message", role: payload.role ?? "system", text: payload.delta ?? "" });
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
  };

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  useEffect(() => {
    const removers = [
      tandem.onTextEvent((event) => appendStream(event.role, event.delta)),
      tandem.onMachineEvent(handleMachineEvent),
      tandem.onCostEvent(setCost),
      tandem.onDoneEvent((event) => {
        setRunning(false);
        setPhase(event.error ? "IDLE" : "DONE");
        setMissingKey(event.missingKey);
        appendMessage("system", `${event.summary}${event.takeover ? " (takeover)" : ""}`);
      }),
      tandem.onPermissionRequest((event) => {
        setPermissionModal(event);
      }),
      tandem.onPlanConfirm(setPlanModal)
    ];

    void tandem
      .startSession({})
      .then(async (started) => {
        setSession(started);
        appendMessage("system", sessionStartedText(started));
        setModels(await tandem.listModels());
        await refreshSidebar();
      })
      .catch((error: unknown) => {
        const message = String(error);
        setMissingKey(missingKeyFromMessage(message));
        appendMessage("system", `Failed to start session: ${message}`);
      });

    return () => {
      for (const remove of removers) remove();
    };
  }, []);

  const updateModel = async (role: "leader" | "worker", modelId: string) => {
    const nextConfig = await tandem.setConfig({ [role]: modelId });
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const updatePermissionMode = async (permissionMode: PermissionMode) => {
    const nextConfig = await tandem.setConfig({ permissionMode });
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const pickProject = async () => {
    const folder = await tandem.pickFolder();
    if (folder) await startProjectSession(folder);
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
    setSessions(await tandem.renameSession({ id: renamingSession, title: renameTitle }));
    setRenamingSession(undefined);
    setRenameTitle("");
  };

  const archiveSession = async (id: string, archived: boolean) => {
    setSessions(await tandem.archiveSession({ id, archived }));
  };

  const deleteSession = async (id: string) => {
    if (id === session?.sessionId) {
      window.alert("Cannot delete the active session. Start or resume another session first.");
      return;
    }
    if (!window.confirm("Delete this session log permanently? Project files will not be touched.")) return;
    setSessions(await tandem.deleteSession({ id }));
  };

  const setSessionAutoApproveMode = async (mode: SessionAutoApproveMode) => {
    setSessionAutoApprove(await tandem.setSessionAutoApprove({ mode }));
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setPrompt("");
    setRunning(true);
    setPhase("PLANNING");
    setMissingKey(undefined);
    appendMessage("user", text);
    try {
      await tandem.runPipeline({ prompt: text });
    } catch (error) {
      setRunning(false);
      setPhase("IDLE");
      const message = String(error);
      setMissingKey(missingKeyFromMessage(message));
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

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">Tandem</div>
        <div className="projectPath">{session?.projectDir ?? "No project loaded"}</div>
        <button type="button" className="sidebarButton" onClick={() => void pickProject()}>
          Pick Folder
        </button>
        <div className="sideSection">
          <div className="sideLabel">Session</div>
          <div className="sideValue">{session?.sessionId ?? "starting"}</div>
        </div>
        <div className="sideSection">
          <div className="sideLabel">Sessions</div>
          <div className="sideList">
            {activeSessions.map((item) => (
              <div key={item.id} className="sessionRow">
                {renamingSession === item.id ? (
                  <input className="renameInput" value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") void saveRenameSession();
                    if (event.key === "Escape") setRenamingSession(undefined);
                  }} />
                ) : (
                  <button type="button" className="sessionTitle" onClick={() => void replaySession(item.id)}>
                    <span>{item.title || item.id.slice(0, 8)}</span>
                    <small>{relativeTime(item.lastActiveAt)}</small>
                  </button>
                )}
                <div className="sessionActions">
                  {renamingSession === item.id ? (
                    <button type="button" onClick={() => void saveRenameSession()}>Save</button>
                  ) : (
                    <button type="button" onClick={() => beginRenameSession(item)}>Rename</button>
                  )}
                  <button type="button" onClick={() => void archiveSession(item.id, true)}>Archive</button>
                  <button type="button" onClick={() => void deleteSession(item.id)}>Delete</button>
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
                    <small>{relativeTime(item.lastActiveAt)}</small>
                  </button>
                  <div className="sessionActions">
                    <button type="button" onClick={() => void archiveSession(item.id, false)}>Unarchive</button>
                    <button type="button" onClick={() => void deleteSession(item.id)}>Delete</button>
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
            <select value={session?.config.leader ?? ""} onChange={(event) => void updateModel("leader", event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.id}
                  {model.available ? "" : ` (${model.envKey} missing)`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Worker
            <select value={session?.config.worker ?? ""} onChange={(event) => void updateModel("worker", event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.id}
                  {model.available ? "" : ` (${model.envKey} missing)`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permissions
            <select value={session?.config.permissionMode ?? "ask"} onChange={(event) => void updatePermissionMode(event.target.value as PermissionMode)}>
              <option value="ask">Ask</option>
              <option value="auto-edit">Auto-edit</option>
              <option value="yolo">Auto</option>
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
          <span>Round {round}/{session?.config.maxReviewRounds ?? 0}</span>
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
          {entries.map((entry) =>
            entry.kind === "message" ? (
              <article key={entry.id} className={`bubble ${entry.role}`}>
                <div className="roleBadge">{roleLabel(entry.role)}</div>
                <div className="messageText">{entry.text}</div>
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
        <footer className="composer">
          <textarea
            placeholder="Ask Tandem to build something..."
            rows={3}
            value={prompt}
            disabled={running}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" onClick={() => void (running ? stop() : send())}>
            {running ? "Stop" : "Send"}
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
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
