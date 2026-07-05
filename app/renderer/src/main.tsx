import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CostTotals, MachineEvent, SessionStartResponse, TextEvent } from "../../shared/ipc.js";
import "./styles.css";

type TranscriptEntry =
  | { id: number; kind: "system"; text: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "leader" | "worker"; text: string };

function App(): React.ReactElement {
  const [session, setSession] = useState<SessionStartResponse>();
  const [entries, setEntries] = useState<TranscriptEntry[]>([{ id: 1, kind: "system", text: "Starting desktop session..." }]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("IDLE");
  const [round, setRound] = useState("0/0");
  const [cost, setCost] = useState<CostTotals>();
  const nextId = useRef(2);

  const totalCost = useMemo(() => {
    if (!cost) return "$0.00";
    return `$${(cost.leader.dollars + cost.worker.dollars).toFixed(4)}`;
  }, [cost]);

  const append = (entry: Omit<TranscriptEntry, "id">) => {
    setEntries((current) => [...current, { ...entry, id: nextId.current++ }]);
  };

  const appendText = (event: TextEvent) => {
    setEntries((current) => {
      const last = current.at(-1);
      if (last?.kind === event.role) {
        return [...current.slice(0, -1), { ...last, text: `${last.text}${event.delta}` }];
      }
      return [...current, { id: nextId.current++, kind: event.role, text: event.delta }];
    });
  };

  const renderMachineEvent = (event: MachineEvent): string => {
    if (event.type === "transition") return `${event.phase}: ${event.message}`;
    if (event.type === "artifact") return `${event.name}: ${JSON.stringify(event.value, null, 2)}`;
    if (event.type === "checkpoint") return `checkpoint: ${event.checkpoint.phase} round ${event.checkpoint.round}`;
    return `error: ${event.message}`;
  };

  useEffect(() => {
    const removers = [
      window.tandem.onTextEvent(appendText),
      window.tandem.onMachineEvent((event) => {
        if (event.type === "transition") setPhase(event.phase);
        if (event.type === "checkpoint") setRound(`${event.checkpoint.round}/${session?.config.maxReviewRounds ?? "?"}`);
        append({ kind: "system", text: renderMachineEvent(event) });
      }),
      window.tandem.onCostEvent(setCost),
      window.tandem.onDoneEvent((event) => {
        setRunning(false);
        setPhase("DONE");
        append({ kind: "system", text: `DONE: ${event.summary}${event.takeover ? " (takeover)" : ""}` });
      }),
      window.tandem.onPermissionRequest((event) => {
        const approved = window.confirm(`Allow ${event.action}?\n\n${event.target}`);
        window.tandem.respondToPermission({ id: event.id, approved });
      }),
      window.tandem.onPlanConfirm((event) => {
        const approved = window.confirm(`Approve this build plan?\n\n${JSON.stringify(event.plan, null, 2)}`);
        window.tandem.respondToPlan({ id: event.id, approved });
      })
    ];

    void window.tandem
      .startSession({})
      .then((started) => {
        setSession(started);
        append({ kind: "system", text: `Session ${started.sessionId} started in ${started.projectDir}` });
      })
      .catch((error: unknown) => {
        append({ kind: "system", text: `Failed to start session: ${String(error)}` });
      });

    return () => {
      for (const remove of removers) remove();
    };
    // The listeners intentionally read the first session config for this D1 plain transcript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setPrompt("");
    setRunning(true);
    setPhase("PLANNING");
    append({ kind: "user", text });
    try {
      await window.tandem.runPipeline({ prompt: text });
    } catch (error) {
      setRunning(false);
      append({ kind: "system", text: `Run failed: ${String(error)}` });
    }
  };

  const stop = async () => {
    await window.tandem.abortPipeline();
    setRunning(false);
    append({ kind: "system", text: "Abort requested." });
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">Tandem</div>
        <div className="projectPath">{session?.projectDir ?? "No project loaded"}</div>
      </aside>
      <section className="workspace">
        <header className="statusBar">
          <span>{phase}</span>
          <span>Round {round}</span>
          <span>{totalCost}</span>
        </header>
        <section className="transcript">
          {entries.map((entry) => (
            <pre key={entry.id} className={`bubble ${entry.kind}`}>
              {entry.text}
            </pre>
          ))}
        </section>
        <footer className="composer">
          <textarea
            placeholder="Ask Tandem to build something..."
            rows={3}
            value={prompt}
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
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
