import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { TandemConfig } from "../config/schema.js";
import { CostLedger } from "../session/cost.js";
import { dispatchCommand } from "../commands/index.js";
import { handleGoal } from "../commands/goal.js";
import { setModel } from "../commands/model.js";
import { modelRegistry } from "../providers/registry.js";
import { modelDisplayName } from "../providers/cli-models.js";
import { parseLoop } from "../commands/loop.js";
import { addSchedule, listSchedules, markScheduleRun, missedSchedule, removeSchedule, Schedule } from "../commands/schedule.js";
import { addGoal, appendGoalNote, formatStandingGoals, listGoals } from "../session/goals.js";
import { buildConversationHistory } from "../session/history.js";
import { compactSessionHistory, isCliBackedLeader } from "../session/compaction.js";
import { rebuildLeaderThread } from "../session/leader-thread.js";
import { appendProjectMemoryNote, formatProjectInstructions, readProjectInstructions } from "../session/project-memory.js";
import { SessionStore, listSessions } from "../session/store.js";
import { createLiveAgents, suggestGoalProgressNotes } from "../agents/live.js";
import { locateCodexCli } from "../agents/codex-cli/locate.js";
import { locateClaudeCli } from "../agents/claude-code-cli/locate.js";
import { runOrchestration, MachineEvent, OrchestrationCheckpoint } from "../orchestrator/machine.js";
import { BuildPlan, CompletionReport, ReviewVerdict } from "../orchestrator/artifacts.js";
import { createDiffTracker } from "../orchestrator/diff.js";
import { createVerificationRunner } from "../orchestrator/verification.js";
import { PermissionBridge, PermissionRequest } from "../tools/permissions.js";
import type { ToolActivityEvent } from "../tools/fs.js";
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
  const [pendingMissedSchedule, setPendingMissedSchedule] = useState<Schedule>();
  const [modelPicker, setModelPicker] = useState<{ stage: "role" | "model"; role: "leader" | "worker"; index: number }>();
  const ledger = useMemo(() => new CostLedger(), []);
  const modelOptions = useMemo(() => modelRegistry(config.customModels), [config.customModels]);
  const app = useApp();
  const abortRef = useRef<AbortController>();
  const storeRef = useRef<SessionStore>();
  const loopTimerRef = useRef<NodeJS.Timeout>();
  const loopRunningRef = useRef(false);
  const cronJobsRef = useRef<Map<string, ScheduledTask>>(new Map());
  const missedScheduleQueueRef = useRef<Schedule[]>([]);

  const addMessage = (role: TranscriptMessage["role"], text: string) => {
    setMessages((current) => [...current, { role, text }]);
    void storeRef.current?.append("message", { role, text });
  };

  const addArtifactMessage = (name: string, value: unknown) => {
    const message = artifactMessage(name, value);
    setMessages((current) => [...current, message]);
    void storeRef.current?.append("message", message);
  };

  const appendDelta = (role: "LEADER" | "WORKER", text: string) => {
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === role) return [...current.slice(0, -1), { ...last, text: `${last.text}${text}` }];
      if (!text.trim()) return current;
      return [...current, { role, text }];
    });
  };

  const trimTrailingAgentMessage = () => {
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role !== "LEADER" && last?.role !== "WORKER") return current;
      const text = last.text.trimEnd();
      if (!text) return current.slice(0, -1);
      if (text === last.text) return current;
      return [...current.slice(0, -1), { ...last, text }];
    });
  };

  const addToolMessage = (event: ToolActivityEvent) => {
    const status = event.phase === "start" ? "running" : event.ok ? `ok ${((event.ms ?? 0) / 1000).toFixed(1)}s` : `failed ${((event.ms ?? 0) / 1000).toFixed(1)}s`;
    addMessage("SYSTEM", `tool ${event.role} - ${event.tool}: ${event.target} - ${status}`);
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
    const task = cron.schedule(spec, async () => {
      await runSequential(prompt, `schedule ${id}`);
      await markScheduleRun(id, cwd);
    });
    cronJobsRef.current.set(id, task);
  };

  const promptNextMissedSchedule = () => {
    const next = missedScheduleQueueRef.current.shift();
    setPendingMissedSchedule(next);
    if (next) addMessage("SYSTEM", `Missed schedule ${next.id} (${next.cron}): run now? y/n`);
  };

  useEffect(() => {
    void SessionStore.create(cwd).then((store) => {
      storeRef.current = store;
      addMessage("SYSTEM", `Session ${store.id}`);
      void readProjectInstructions(cwd).then((instructions) => {
        if (instructions) addMessage("SYSTEM", `project instructions: ${instructions.fileName} (${instructions.chars} chars${instructions.truncated ? ", truncated" : ""})`);
      });
    });
    void listSchedules(cwd).then((schedules) => {
      for (const schedule of schedules) registerSchedule(schedule.id, schedule.cron, schedule.prompt);
      const missed = schedules.filter((schedule) => missedSchedule(schedule.cron, schedule.lastRunAt));
      missedScheduleQueueRef.current = missed;
      if (schedules.length > 0) addMessage("SYSTEM", `${schedules.length} schedule(s) loaded.`);
      if (missed.length > 0) promptNextMissedSchedule();
    });
    return () => {
      loopTimerRef.current && clearInterval(loopTimerRef.current);
      for (const task of cronJobsRef.current.values()) task.stop();
    };
  }, []);

  useInput((inputValue, key) => {
    if (modelPicker) {
      const count = modelPicker.stage === "role" ? 2 : modelOptions.length;
      if (key.upArrow) setModelPicker({ ...modelPicker, index: (modelPicker.index + count - 1) % count });
      if (key.downArrow) setModelPicker({ ...modelPicker, index: (modelPicker.index + 1) % count });
      if (key.return) {
        if (modelPicker.stage === "role") {
          setModelPicker({ stage: "model", role: modelPicker.index === 0 ? "leader" : "worker", index: 0 });
        } else {
          const selected = modelOptions[modelPicker.index];
          if (selected) {
            void setModel(config, modelPicker.role, selected.id, cwd).then((next) => {
              setConfig(next);
              addMessage("SYSTEM", `Set ${modelPicker.role} model to ${selected.id}.`);
            });
          }
          setModelPicker(undefined);
        }
      }
      if (key.escape) setModelPicker(undefined);
      return;
    }
    if (key.ctrl && inputValue === "e") {
      setMessages((current) => {
        let index = -1;
        for (let i = current.length - 1; i >= 0; i -= 1) {
          if (current[i]?.artifactDetails) {
            index = i;
            break;
          }
        }
        if (index < 0) return current;
        const next = [...current];
        const message = next[index] as TranscriptMessage;
        next[index] = { ...message, artifactExpanded: !message.artifactExpanded };
        return next;
      });
      return;
    }
    if (key.escape) {
      pendingApproval?.resolve(false);
      pendingPlan?.resolve(false);
      setPendingApproval(undefined);
      setPendingPlan(undefined);
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

  const compactCurrentSession = async (force: boolean) => {
    const events = (await storeRef.current?.read()) ?? [];
    const event = await compactSessionHistory({
      events,
      config,
      cwd,
      env,
      ledger,
      force,
      abortSignal: abortRef.current?.signal
    });
    if (event) {
      await storeRef.current?.append("memory:compaction", event);
      addMessage("SYSTEM", `compacted ${event.compactedTurns} earlier turns.`);
    }
    return event;
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
      addArtifactMessage(event.name, event.value);
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
      if (isCliBackedLeader(config)) await compactCurrentSession(false);
      const sessionEvents = (await storeRef.current?.read()) ?? [];
      const history = buildConversationHistory(sessionEvents);
      addMessage("SYSTEM", `context: ${history.priorTurns} prior turn${history.priorTurns === 1 ? "" : "s"}`);
      if (history.truncated) addMessage("SYSTEM", "including last 10 turns of context");
      await storeRef.current?.append("user", { prompt });
      const rememberSessionNote = async (text: string, _by: "leader" | "worker") => {
        return appendProjectMemoryNote(cwd, text);
      };
      const currentProjectInstructions = async () => formatProjectInstructions(await readProjectInstructions(cwd));
      const activeGoalObjects = (await listGoals(cwd)).filter((goal) => goal.status === "active");
      const activeGoals = formatStandingGoals(activeGoalObjects);
      const diffTracker = createDiffTracker(cwd);
      const agents = await createLiveAgents({
        config,
        cwd,
        env,
        ledger,
        permissionBridge,
        recordTouchedPath: (filePath) => diffTracker.recordTouchedPath(filePath),
        abortSignal: controller.signal,
        onLeaderText: (text) => appendDelta("LEADER", text),
        onWorkerText: (text) => appendDelta("WORKER", text),
        onLeaderThinking: config.showThinking ? (text) => appendDelta("LEADER", text) : undefined,
        onWorkerThinking: config.showThinking ? (text) => appendDelta("WORKER", text) : undefined,
        onToolEvent: addToolMessage,
        projectInstructions: currentProjectInstructions,
        rememberNote: rememberSessionNote,
        leaderThread: rebuildLeaderThread(sessionEvents),
        onLeaderCompaction: async (event) => {
          await storeRef.current?.append("memory:compaction", event);
          addMessage("SYSTEM", `compacted ${event.compactedTurns} earlier turns.`);
        },
        onTriage: (kind) => handleEvent({ type: "notice", message: `triage: ${kind}` }),
        confirmCodexWrite: (_role, message) => permissionBridge.approve({ action: "bash", target: message })
      });
      const result = await runOrchestration({
        request: prompt,
        config,
        agents,
        goals: activeGoals,
        history: history.text,
        diffProvider: diffTracker,
        verificationRunner: createVerificationRunner({
          cwd,
          permissionMode: config.permissionMode,
          permissionBridge,
          abortSignal: controller.signal
        }),
        confirmPlan,
        initialState,
        emit: handleEvent
      });
      trimTrailingAgentMessage();
      addMessage("LEADER", result.summary);
      await storeRef.current?.append("done", { summary: result.summary, takeover: result.takeover });
      const notes = await suggestGoalProgressNotes({
        config,
        cwd,
        env,
        ledger,
        abortSignal: controller.signal,
        onLeaderText: (text) => appendDelta("LEADER", text),
        onLeaderThinking: config.showThinking ? (text) => appendDelta("LEADER", text) : undefined,
        goals: activeGoalObjects,
        userSummary: result.summary
      });
      for (const note of notes) {
        await appendGoalNote(note.goalId, note.note, cwd);
        addMessage("SYSTEM", `Goal ${note.goalId} noted: ${note.note}`);
      }
      setPhase("DONE");
      void storeRef.current?.append("cost", ledger.totals());
    } finally {
      trimTrailingAgentMessage();
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
    if (pendingMissedSchedule) {
      const schedule = pendingMissedSchedule;
      setPendingMissedSchedule(undefined);
      setInput("");
      if (/^y(es)?$/i.test(value.trim())) {
        await runSequential(schedule.prompt, `missed schedule ${schedule.id}`);
        await markScheduleRun(schedule.id, cwd);
      } else {
        addMessage("SYSTEM", `Skipped missed schedule ${schedule.id}.`);
      }
      promptNextMissedSchedule();
      return;
    }
    if (!value.trim()) return;
    setInput("");
    addMessage("USER", value);
    setBusy(true);
    try {
      // /goal short-circuit: bare /goal lists, /goal add records-only, /goal done marks
      // complete, /goal clear (lone token) clears all, /goal <free-form text> records AND runs
      // through the same pipeline as a plain typed message (matches the user's Claude Code
      // "type it, work begins" workflow).
      if (value.startsWith("/goal")) {
        const goalArgs = value.match(/"[^"]*"|\S+/g)?.slice(1).map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part)) ?? [];
        const outcome = await handleGoal(goalArgs, cwd);
        if (outcome.kind === "handled") {
          addMessage("SYSTEM", outcome.message);
        } else {
          const goal = await addGoal(outcome.text, cwd);
          addMessage("SYSTEM", `Added goal ${goal.id}: ${goal.text}`);
          await runPipeline(outcome.text);
        }
        return;
      }
      if (value.trim() === "/model") {
        setModelPicker({ stage: "role", role: "leader", index: 0 });
        addMessage("SYSTEM", "Choose model role with arrows, then Enter.");
        return;
      }
      if (value.trim() === "/compact") {
        const event = await compactCurrentSession(true);
        if (!event) addMessage("SYSTEM", "No conversation history to compact yet.");
        return;
      }
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
      const commandResult =
        loopResult ??
        scheduleResult ??
        resumeResult ??
        (value === "/sessions"
          ? (await listSessions(cwd)).map((session) => `${session.id} ${session.archived ? "[archived] " : ""}${session.title}`).join("\n") || "No sessions yet."
          : await dispatchCommand(value, { config, env, cwd, ledger, setConfig }));
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
      {modelPicker ? (
        <Box borderStyle="single" flexDirection="column" paddingX={1}>
          <Text color="cyan">{modelPicker.stage === "role" ? "Choose role" : `Choose ${modelPicker.role} model`}</Text>
          {(modelPicker.stage === "role"
            ? ["leader", "worker"]
            : modelOptions.map((model) => {
                const status =
                  model.provider === "codex-cli"
                    ? locateCodexCli({ env, overridePath: config.codexCliPath })
                    : model.provider === "claude-code-cli"
                      ? locateClaudeCli({ env, overridePath: config.claudeCliPath })
                      : model.envKey && env[model.envKey];
                return `${status ? "ok " : "key"} ${modelDisplayName(model.id, config)}`;
              })
          ).map((item, index) => (
            <Text key={item} color={index === modelPicker.index ? "yellow" : undefined}>
              {index === modelPicker.index ? "> " : "  "}
              {item}
            </Text>
          ))}
        </Box>
      ) : null}
      <Approval action={pendingApproval?.request.action} target={pendingApproval?.request.target} />
      {pendingPlan ? <Text color="yellow">Plan approval pending</Text> : null}
      {pendingResume ? <Text color="yellow">Resume continuation pending</Text> : null}
      {pendingMissedSchedule ? <Text color="yellow">Missed schedule prompt pending</Text> : null}
      {busy ? <Text color="cyan"><Spinner type="dots" /> working</Text> : null}
      <StatusLine leader={modelDisplayName(config.leader, config)} worker={modelDisplayName(config.worker, config)} phase={phase} round={round} maxRounds={config.maxReviewRounds} cost={ledger.totalDollars()} />
      <InputBar value={input} onChange={setInput} onSubmit={submit} />
    </Box>
  );
}

function artifactMessage(name: string, value: unknown): TranscriptMessage {
  return {
    role: "SYSTEM",
    text: `${artifactSummary(name, value)} (ctrl+e to expand)`,
    artifactDetails: JSON.stringify(value, null, 2),
    artifactExpanded: false
  };
}

function artifactSummary(name: string, value: unknown): string {
  if (name === "BuildPlan") {
    const plan = value as BuildPlan;
    return `BuildPlan: ${plan.title} | ${plan.tasks.length} tasks | ${plan.acceptanceCriteria.length} criteria | ${plan.verification.length} checks`;
  }
  if (name === "CompletionReport" || name === "TakeoverReport") {
    const report = value as CompletionReport;
    return `${name}: ${report.status} | ${report.filesChanged.length} files | ${report.verificationResults.length} checks`;
  }
  if (name === "ReviewVerdict") {
    const verdict = value as ReviewVerdict;
    return `ReviewVerdict: ${verdict.verdict} | ${verdict.feedback.length} issues | scores ${verdict.scores.correctness}/${verdict.scores.planAdherence}/${verdict.scores.codeQuality}`;
  }
  return `${name} submitted`;
}
