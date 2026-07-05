import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CostTotals, MachineEvent, ModelListItem, PermissionRequestEvent, PlanConfirmEvent, SessionStartResponse } from "../../shared/ipc.js";
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
    scores?: { correctness?: number; completeness?: number; safety?: number };
    summary?: string;
  };
  if (name === "BuildPlan") return `${item.tasks?.length ?? 0} task(s)`;
  if (name === "ReviewVerdict") {
    const scores = item.scores ? ` ${item.scores.correctness}/${item.scores.completeness}/${item.scores.safety}` : "";
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

function App(): React.ReactElement {
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
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const autoAllowedActions = useRef(new Set<string>());
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

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  useEffect(() => {
    const removers = [
      window.tandem.onTextEvent((event) => appendStream(event.role, event.delta)),
      window.tandem.onMachineEvent(handleMachineEvent),
      window.tandem.onCostEvent(setCost),
      window.tandem.onDoneEvent((event) => {
        setRunning(false);
        setPhase("DONE");
        appendMessage("system", `${event.summary}${event.takeover ? " (takeover)" : ""}`);
      }),
      window.tandem.onPermissionRequest((event) => {
        if (autoAllowedActions.current.has(event.action)) {
          window.tandem.respondToPermission({ id: event.id, approved: true });
          return;
        }
        setAlwaysAllow(false);
        setPermissionModal(event);
      }),
      window.tandem.onPlanConfirm(setPlanModal)
    ];

    void window.tandem
      .startSession({})
      .then(async (started) => {
        setSession(started);
        appendMessage("system", `Session ${started.sessionId} started in ${started.projectDir}`);
        setModels(await window.tandem.listModels());
      })
      .catch((error: unknown) => {
        appendMessage("system", `Failed to start session: ${String(error)}`);
      });

    return () => {
      for (const remove of removers) remove();
    };
  }, []);

  const updateModel = async (role: "leader" | "worker", modelId: string) => {
    const nextConfig = await window.tandem.setConfig({ [role]: modelId });
    setSession((current) => (current ? { ...current, config: nextConfig } : current));
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setPrompt("");
    setRunning(true);
    setPhase("PLANNING");
    appendMessage("user", text);
    try {
      await window.tandem.runPipeline({ prompt: text });
    } catch (error) {
      setRunning(false);
      appendMessage("system", `Run failed: ${String(error)}`);
    }
  };

  const stop = async () => {
    await window.tandem.abortPipeline();
    appendMessage("system", "Abort requested.");
  };

  const respondToPermission = (approved: boolean) => {
    if (!permissionModal) return;
    if (approved && alwaysAllow) autoAllowedActions.current.add(permissionModal.action);
    window.tandem.respondToPermission({ id: permissionModal.id, approved });
    setPermissionModal(undefined);
  };

  const respondToPlan = (approved: boolean) => {
    if (!planModal) return;
    window.tandem.respondToPlan({ id: planModal.id, approved });
    setPlanModal(undefined);
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">Tandem</div>
        <div className="projectPath">{session?.projectDir ?? "No project loaded"}</div>
        <div className="sideSection">
          <div className="sideLabel">Session</div>
          <div className="sideValue">{session?.sessionId ?? "starting"}</div>
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
          <span className="phaseChip">{phase}</span>
          <span>Round {round}/{session?.config.maxReviewRounds ?? 0}</span>
          <span title={costTitle}>{totalCost}</span>
        </header>
        <section className="transcript">
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
            <label className="checkRow">
              <input type="checkbox" checked={alwaysAllow} onChange={(event) => setAlwaysAllow(event.target.checked)} />
              Always allow this action for this session
            </label>
            <div className="modalActions">
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

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
