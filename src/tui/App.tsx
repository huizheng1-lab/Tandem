import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { TandemConfig } from "../config/schema.js";
import { CostLedger } from "../session/cost.js";
import { dispatchCommand } from "../commands/index.js";
import { parseLoop } from "../commands/loop.js";
import { addSchedule, listSchedules, removeSchedule } from "../commands/schedule.js";
import { listGoals } from "../session/goals.js";
import { SessionStore, listSessions } from "../session/store.js";
import { createLiveAgents } from "../agents/live.js";
import { runOrchestration, MachineEvent, OrchestrationCheckpoint } from "../orchestrator/machine.js";
import { BuildPlan, ReviewVerdict } from "../orchestrator/artifacts.js";
import { workingTreeDiff } from "../orchestrator/diff.js";
import { PermissionBridge, PermissionRequest } from "../tools/permissions.js";
import { Transcript, TranscriptMessage } from "./Transcript.js";
import { InputBar } from "./InputBar.js";
import { StatusLine } from "./StatusLine.js";
import { Approval } from "./Approval.js";
import { PlanView } from "./PlanView.js";

export function App({ config: initialConfig, env, cwd, initialError }: { config: TandemConfig; env: NodeJS.ProcessEnv; cwd: string; initialError?: string }) {
  const [config, setConfig] = useState(initialConfig);
  const [messages, setMessages] = useState<TranscriptMessage[]>([
    { role: "SYSTEM", text: initialError ?? "Tandem ready. Run /help or ask for a build." }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("IDLE");
  const [round, setRound] = useState(0);
  const [plan, setPlan] = useState<BuildPlan | undefined>();
  const [verdict, setVerdict] = useState<ReviewVerdict | undefined>();
  const [pendingApproval, setPendingApproval] = useState<{ request: PermissionRequest; resolve: (approved: boolean) => void }>();
  const [pendingPlan, setPendingPlan] = useState<{ plan: BuildPlan; resolve: (approved: boolean) => void }>();
  const [pendingResume, setPendingResume] = useState<{ request: string; checkpoint: OrchestrationCheckpoint }>();
  const ledger = useMemo(() => new CostLedger(), []);
  const app = useApp();
  const abortRef = useRef<AbortController>();
  const storeRef = useRef<SessionStore>();
  const loopTimerRef = useRef<NodeJS.Timeout>();
  const loopRunningRef = useRef(false);
  const cronJobsRef = useRef<Map<string, ScheduledTask>>(new Map());

  const addMessage = (role: TranscriptMessage["role"], text: string) => {
    setMessages((current) => [...current, { role, text }]);
    void storeRef.current?.append("message", { role, text });
  };

  const appendDelta = (role: "LEADER" | "WORKER", text: string) => {
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === role) return [...current.slice(0, -1), { ...last, text: `${last.text}${text}` }];
      return [...current, { role, text }];
    });
  };

  const permissionBridge: PermissionBridge = {
    approve: (request) =>
      new Promise((resolve) => {
        setPendingApproval({ request, resolve });
        addMessage("SYSTEM", `Permission requested: ${request.action} ${request.target}`);
      })
  };

  const registerSchedule = (id: string, spec: string, prompt: string) => {
    cronJobsRef.current.get(id)?.stop();
    const task = cron.schedule(spec, () => {
      void runSequential(prompt, `schedule ${id}`);
    });
    cronJobsRef.current.set(id, task);
  };

  useEffect(() => {
    void SessionStore.create(cwd).then((store) => {
      storeRef.current = store;
      addMessage("SYSTEM", `Session ${store.id}`);
    });
    void listSchedules(cwd).then((schedules) => {
      for (const schedule of schedules) registerSchedule(schedule.id, schedule.cron, schedule.prompt);
      if (schedules.length > 0) addMessage("SYSTEM", `${schedules.length} schedule(s) loaded. If any were missed while Tandem was closed, submit the prompt now to run it.`);
    });
    return () => {
      loopTimerRef.current && clearInterval(loopTimerRef.current);
      for (const task of cronJobsRef.current.values()) task.stop();
    };
  }, []);

  useInput((inputValue, key) => {
    if (key.escape) {
      abortRef.current?.abort();
      setBusy(false);
      addMessage("SYSTEM", "Interrupted current turn.");
    }
    if (key.ctrl && inputValue === "c") app.exit();
  });

  const confirmPlan = (nextPlan: BuildPlan): Promise<boolean> => {
    if (config.permissionMode !== "ask") return Promise.resolve(true);
    setPlan(nextPlan);
    addMessage("SYSTEM", "Build plan ready. Press Enter to proceed, or type anything else to reject.");
    return new Promise((resolve) => setPendingPlan({ plan: nextPlan, resolve }));
  };

  const handleEvent = (event: MachineEvent) => {
    void storeRef.current?.append(event.type, event);
    if (event.type === "transition") {
      setPhase(event.phase);
      const match = /round (\d+)\//.exec(event.message);
      if (match) setRound(Number(match[1]));
      addMessage("SYSTEM", event.message);
    } else if (event.type === "artifact") {
      if (event.name === "BuildPlan") setPlan(event.value as BuildPlan);
      if (event.name === "ReviewVerdict") setVerdict(event.value as ReviewVerdict);
      addMessage("SYSTEM", `${event.name} submitted.`);
    } else if (event.type === "checkpoint") {
      setPhase(event.checkpoint.phase);
      setRound(event.checkpoint.round);
      setPlan(event.checkpoint.plan);
      setVerdict(event.checkpoint.verdicts.at(-1));
    } else {
      addMessage("SYSTEM", event.message);
    }
  };

  const runPipeline = async (prompt: string, initialState?: OrchestrationCheckpoint) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setPhase("PLANNING");
    setRound(0);
    setPlan(undefined);
    setVerdict(undefined);
    try {
      const activeGoals = (await listGoals(cwd)).filter((goal) => goal.status === "active").map((goal) => goal.text);
      const agents = await createLiveAgents({
        config,
        cwd,
        env,
        ledger,
        permissionBridge,
        abortSignal: controller.signal,
        onLeaderText: (text) => appendDelta("LEADER", text),
        onWorkerText: (text) => appendDelta("WORKER", text)
      });
      const result = await runOrchestration({
        request: prompt,
        config,
        agents,
        goals: activeGoals,
        diffProvider: () => workingTreeDiff(cwd),
        confirmPlan,
        initialState,
        emit: handleEvent
      });
      addMessage("LEADER", result.summary);
      setPhase("DONE");
      void storeRef.current?.append("cost", ledger.totals());
    } finally {
      setBusy(false);
      abortRef.current = undefined;
    }
  };

  const runSequential = async (prompt: string, source: string) => {
    if (loopRunningRef.current) {
      addMessage("SYSTEM", `${source} skipped; previous run still active.`);
      return;
    }
    loopRunningRef.current = true;
    try {
      addMessage("SYSTEM", `${source} running.`);
      await runPipeline(prompt);
    } catch (error) {
      addMessage("SYSTEM", String(error));
    } finally {
      loopRunningRef.current = false;
    }
  };

  const handleLoop = async (value: string): Promise<string | undefined> => {
    if (!value.startsWith("/loop")) return undefined;
    const args = value.match(/"[^"]*"|\S+/g)?.slice(1).map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part)) ?? [];
    const spec = parseLoop(args);
    if (spec === "stop") {
      if (loopTimerRef.current) clearInterval(loopTimerRef.current);
      loopTimerRef.current = undefined;
      return "Loop stopped.";
    }
    if (loopTimerRef.current) clearInterval(loopTimerRef.current);
    loopTimerRef.current = setInterval(() => void runSequential(spec.prompt, "loop"), spec.intervalMs);
    void runSequential(spec.prompt, "loop");
    return `Loop started every ${spec.intervalMs}ms.`;
  };

  const handleSchedule = async (value: string): Promise<string | undefined> => {
    if (!value.startsWith("/schedule")) return undefined;
    const args = value.match(/"[^"]*"|\S+/g)?.slice(1).map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part)) ?? [];
    if (args[0] === "list") {
      const schedules = await listSchedules(cwd);
      return schedules.map((item) => `${item.id} ${item.cron} ${item.prompt}`).join("\n") || "No schedules.";
    }
    if (args[0] === "rm" && args[1]) {
      cronJobsRef.current.get(args[1])?.stop();
      cronJobsRef.current.delete(args[1]);
      await removeSchedule(args[1], cwd);
      return `Removed schedule ${args[1]}.`;
    }
    if (args.length >= 2) {
      const schedule = await addSchedule(args[0] ?? "", args.slice(1).join(" "), cwd);
      registerSchedule(schedule.id, schedule.cron, schedule.prompt);
      return `Added schedule ${schedule.id}. Schedules run only while Tandem is open.`;
    }
    return 'Usage: /schedule "<cron>" <prompt>';
  };

  const submit = async (value: string) => {
    if (pendingApproval) {
      pendingApproval.resolve(/^y(es)?$/i.test(value.trim()));
      setPendingApproval(undefined);
      setInput("");
      return;
    }
    if (pendingPlan) {
      pendingPlan.resolve(value.trim() === "" || /^y(es)?$/i.test(value.trim()));
      setPendingPlan(undefined);
      setInput("");
      return;
    }
    if (pendingResume) {
      const shouldResume = value.trim() === "" || /^y(es)?$/i.test(value.trim());
      const resume = pendingResume;
      setPendingResume(undefined);
      setInput("");
      if (shouldResume) await runPipeline(resume.request, resume.checkpoint);
      else addMessage("SYSTEM", "Resume continuation cancelled.");
      return;
    }
    if (!value.trim()) return;
    setInput("");
    addMessage("USER", value);
    setBusy(true);
    try {
      const loopResult = await handleLoop(value);
      const scheduleResult = loopResult === undefined ? await handleSchedule(value) : undefined;
      let resumeResult: string | undefined;
      if (value.startsWith("/resume ")) {
        const id = value.split(/\s+/)[1];
        const store = await SessionStore.open(id ?? "", cwd);
        const events = await store.read();
        storeRef.current = store;
        const restored = events
          .filter((event) => event.type === "message")
          .map((event) => event.payload as TranscriptMessage);
        setMessages(restored.length > 0 ? restored : [{ role: "SYSTEM", text: `Resumed session ${id}.` }]);
        const checkpoints = events
          .filter((event) => event.type === "checkpoint")
          .map((event) => (event.payload as { checkpoint: OrchestrationCheckpoint }).checkpoint);
        const checkpoint = checkpoints.at(-1);
        const userMessages = restored.filter((message) => message.role === "USER");
        const request = userMessages.at(-1)?.text ?? "";
        if (checkpoint && checkpoint.phase !== "DONE" && request) {
          setPhase(checkpoint.phase);
          setRound(checkpoint.round);
          setPlan(checkpoint.plan);
          setVerdict(checkpoint.verdicts.at(-1));
          setPendingResume({ request, checkpoint });
          resumeResult = `Resumed session ${id}. Press Enter to continue from ${checkpoint.phase}, or type anything else to cancel.`;
        } else {
          resumeResult = `Resumed session ${id}.`;
        }
      }
      const commandResult = loopResult ?? scheduleResult ?? resumeResult ?? (value === "/sessions" ? (await listSessions(cwd)).join("\n") || "No sessions yet." : await dispatchCommand(value, { config, env, cwd, ledger, setConfig }));
      if (commandResult !== undefined) {
        addMessage("SYSTEM", commandResult);
      } else {
        await runPipeline(value);
      }
    } catch (error) {
      addMessage("SYSTEM", String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Transcript messages={messages} />
      <PlanView plan={plan} verdict={verdict} />
      <Approval action={pendingApproval?.request.action} target={pendingApproval?.request.target} />
      {pendingPlan ? <Text color="yellow">Plan approval pending</Text> : null}
      {pendingResume ? <Text color="yellow">Resume continuation pending</Text> : null}
      {busy ? <Text color="cyan"><Spinner type="dots" /> working</Text> : null}
      <StatusLine leader={config.leader} worker={config.worker} phase={phase} round={round} maxRounds={config.maxReviewRounds} cost={ledger.totalDollars()} />
      <InputBar value={input} onChange={setInput} onSubmit={submit} />
    </Box>
  );
}
