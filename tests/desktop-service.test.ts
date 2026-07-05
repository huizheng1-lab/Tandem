import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TandemService } from "../app/main/tandem-service.js";
import { ipcChannels } from "../app/shared/ipc.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";
import type { AgentFns, RunOptions, RunResult } from "../src/orchestrator/machine.js";
import type { PermissionBridge } from "../src/tools/permissions.js";
import { safeDefaultProjectDir } from "../src/tools/protection.js";
import { SessionStore } from "../src/session/store.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function fakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    window: {
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload })
      }
    }
  };
}

const plan: BuildPlan = {
  title: "Test plan",
  objective: "Exercise desktop plan confirmation",
  constraints: [],
  tasks: [{ id: "T1", description: "Do the thing" }],
  acceptanceCriteria: ["The thing is done"],
  verification: ["npm test"]
};

function fakeAgents(): AgentFns {
  return {
    plan: async () => ({ kind: "answer", answer: "done" }),
    build: async () => ({}),
    review: async () => ({}),
    takeover: async () => {
      throw new Error("not used");
    }
  };
}

async function waitForPlanConfirm(sent: Array<{ channel: string; payload: unknown }>) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const event = sent.find((item) => item.channel === ipcChannels.planConfirm);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for plan confirmation");
}

function respondToPlan(service: TandemService, id: string, approved: boolean): void {
  const internals = service as unknown as {
    pendingPlans: Map<string, (approved: boolean) => void>;
    resolvePending(map: Map<string, (approved: boolean) => void>, id: string, approved: boolean): void;
  };
  internals.resolvePending(internals.pendingPlans, id, approved);
}

describe("TandemService", () => {
  it("initializes launch context from the last project without starting a session", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await writeFile(path.join(home, ".tandem", ".env"), "GEMINI_API_KEY=gemini-test\nMINIMAX_API_KEY=minimax-test\n", "utf8");
    await writeFile(path.join(home, ".tandem", "desktop-state.json"), `${JSON.stringify({ lastProjectDir: cwd })}\n`, "utf8");
    const store = await SessionStore.create(cwd, home);
    await store.append("user", { prompt: "last project session" });

    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false, homeDir: home, baseEnv: {} });

    await expect(service.getAppState()).resolves.toMatchObject({ projectDir: cwd, lastProjectDir: cwd });
    expect(service.listModels().find((model) => model.id === "google/gemini-2.5-pro")?.available).toBe(true);
    expect(service.listModels().find((model) => model.id === "minimax/minimax-m2.7")?.available).toBe(true);
    expect((await service.listSessions()).map((session) => session.id)).toContain(store.id);

    const renamed = await service.renameSession(store.id, "Pre-pick rename");
    expect(renamed.find((session) => session.id === store.id)?.title).toBe("Pre-pick rename");
  });

  it("persists explicit desktop projects and pre-session config changes", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false, homeDir: home, baseEnv: {} });

    await service.setConfig({ permissionMode: "yolo" });
    const started = await service.startSession({ projectDir: cwd });

    expect(started.config.permissionMode).toBe("yolo");
    await expect(readFile(path.join(home, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ permissionMode: "yolo" });
    const next = new TandemService(window as never, { registerIpcResponses: false, homeDir: home, baseEnv: {} });
    await expect(next.getAppState()).resolves.toMatchObject({ projectDir: cwd, lastProjectDir: cwd });
    expect(next.getConfig().permissionMode).toBe("yolo");
  });

  it("reports when project permission mode overrides the global default", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await mkdir(path.join(cwd, ".tandem"), { recursive: true });
    await writeFile(path.join(home, ".tandem", "config.json"), JSON.stringify({ permissionMode: "yolo" }));
    await writeFile(path.join(cwd, ".tandem", "config.json"), JSON.stringify({ permissionMode: "ask" }));
    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false, homeDir: home, baseEnv: {} });

    const started = await service.startSession({ projectDir: cwd });

    expect(started.config.permissionMode).toBe("ask");
    expect(started.projectConfigOverrides).toContain("permissionMode");
  });

  it("persists active session config changes to global defaults and the current project", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false, homeDir: home, baseEnv: {} });
    await service.startSession({ projectDir: cwd });

    await service.setConfig({ permissionMode: "yolo", worker: "openai/gpt-5-mini" });

    await expect(readFile(path.join(home, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ permissionMode: "yolo", worker: "openai/gpt-5-mini" });
    await expect(readFile(path.join(cwd, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ permissionMode: "yolo", worker: "openai/gpt-5-mini" });
  });

  it("defaults new desktop sessions to the safe TandemProjects workspace", async () => {
    const home = await tempDir();
    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false, homeDir: home });

    const started = await service.startSession({});

    expect(started.projectDir).toBe(safeDefaultProjectDir(home));
    expect(started.defaultProject).toBe(true);
    expect(started.projectSummary).toMatch(/folder|project/);
  });

  it("runs orchestration through injected core dependencies and records session events", async () => {
    const cwd = await tempDir();
    const { window, sent } = fakeWindow();
    const appended: Array<{ type: string; payload: unknown }> = [];
    let agentCwd = "";
    let request = "";

    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async (type, payload) => {
          appended.push({ type, payload });
        },
        read: async () => []
      }),
      createAgents: async (options): Promise<AgentFns> => {
        agentCwd = options.cwd;
        return {
          plan: async () => ({ kind: "answer", answer: "done" }),
          build: async () => ({}),
          review: async () => ({}),
          takeover: async () => {
            throw new Error("not used");
          }
        };
      },
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        request = options.request;
        options.emit?.({ type: "transition", phase: "PLANNING", message: "planning" });
        return { phase: "DONE", summary: "finished", reports: [], verdicts: [], takeover: false };
      }
    });

    const started = await service.startSession({ projectDir: cwd });
    await service.run("build the thing");

    expect(started.sessionId).toBe("session-1");
    expect(agentCwd).toBe(cwd);
    expect(request).toBe("build the thing");
    expect(appended.some((event) => event.type === "user")).toBe(true);
    expect(appended.some((event) => event.type === "done")).toBe(true);
    expect(sent.some((event) => event.channel === ipcChannels.machineEvent)).toBe(true);
    expect(sent.some((event) => event.channel === ipcChannels.doneEvent)).toBe(true);
  });

  it("does not reuse a completed checkpoint for a follow-up prompt", async () => {
    const cwd = await tempDir();
    const { window } = fakeWindow();
    const initialStates: RunOptions["initialState"][] = [];
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async (): Promise<AgentFns> => ({
        plan: async () => ({ kind: "answer", answer: "done" }),
        build: async () => ({}),
        review: async () => ({}),
        takeover: async () => {
          throw new Error("not used");
        }
      }),
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        initialStates.push(options.initialState);
        options.emit?.({ type: "checkpoint", checkpoint: { phase: "DONE", round: 0, reports: [], verdicts: [], feedbackHistory: [] } });
        return { phase: "DONE", summary: "finished", reports: [], verdicts: [], takeover: false };
      }
    });

    await service.startSession({ projectDir: cwd });
    await service.run("first");
    await service.run("second");

    expect(initialStates).toEqual([undefined, undefined]);
  });

  it("consumes an interrupted resume checkpoint only once", async () => {
    const cwd = await tempDir();
    const { window } = fakeWindow();
    const checkpoint = { phase: "BUILDING" as const, round: 1, reports: [], verdicts: [], feedbackHistory: [] };
    const initialStates: RunOptions["initialState"][] = [];
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      openSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => [{ type: "machine", at: new Date().toISOString(), payload: { type: "checkpoint", checkpoint } }]
      }),
      createAgents: async (): Promise<AgentFns> => ({
        plan: async () => ({ kind: "answer", answer: "done" }),
        build: async () => ({}),
        review: async () => ({}),
        takeover: async () => {
          throw new Error("not used");
        }
      }),
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        initialStates.push(options.initialState);
        return { phase: "DONE", summary: "finished", reports: [], verdicts: [], takeover: false };
      }
    });

    await service.startSession({ projectDir: cwd });
    await service.resumeSession("session-1");
    await service.run("continue");
    await service.run("fresh");

    expect(initialStates).toEqual([checkpoint, undefined]);
  });

  it("records crashes to the active session", async () => {
    const cwd = await tempDir();
    const { window, sent } = fakeWindow();
    const appended: Array<{ type: string; payload: unknown }> = [];
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async (type, payload) => {
          appended.push({ type, payload });
        },
        read: async () => []
      })
    });

    await service.startSession({ projectDir: cwd });
    await service.recordCrash(new Error("boom"));

    expect(appended.some((event) => event.type === "crash")).toBe(true);
    expect(sent.at(-1)?.channel).toBe(ipcChannels.machineEvent);
  });

  it("emits a terminal event when pipeline setup fails", async () => {
    const cwd = await tempDir();
    const { window, sent } = fakeWindow();
    const appended: Array<{ type: string; payload: unknown }> = [];
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async (type, payload) => {
          appended.push({ type, payload });
        },
        read: async () => []
      }),
      createAgents: async () => {
        throw new Error("Missing TEST_API_KEY for model test/model.");
      }
    });

    await service.startSession({ projectDir: cwd });
    await service.run("build");

    const done = sent.find((event) => event.channel === ipcChannels.doneEvent);
    expect(done?.payload).toMatchObject({ error: true, takeover: false });
    expect(appended.some((event) => event.type === "done" && (event.payload as { error?: boolean }).error)).toBe(true);
  });

  it("includes missing key details on model env failures", async () => {
    const cwd = await tempDir();
    const { window, sent } = fakeWindow();
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async () => {
        throw new Error("Missing MINIMAX_API_KEY for model minimax/minimax-m2.7. Add it to .env or ~/.tandem/.env, then retry.");
      }
    });

    await service.startSession({ projectDir: cwd });
    await service.run("build");

    const done = sent.find((event) => event.channel === ipcChannels.doneEvent);
    expect(done?.payload).toMatchObject({
      error: true,
      missingKey: {
        key: "MINIMAX_API_KEY",
        model: "minimax/minimax-m2.7"
      }
    });
  });

  it("applies session-scoped auto-approval without disabling bash prompts in edit mode", async () => {
    const cwd = await tempDir();
    const { window, sent } = fakeWindow();
    let bridge: PermissionBridge | undefined;
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async (options): Promise<AgentFns> => {
        bridge = options.permissionBridge;
        return {
          plan: async () => ({ kind: "answer", answer: "done" }),
          build: async () => ({}),
          review: async () => ({}),
          takeover: async () => {
            throw new Error("not used");
          }
        };
      },
      runOrchestration: async (): Promise<RunResult> => ({ phase: "DONE", summary: "finished", reports: [], verdicts: [], takeover: false })
    });

    await service.startSession({ projectDir: cwd });
    await service.setSessionAutoApprove("edits");
    await service.run("build");

    await expect(bridge?.approve({ action: "write", target: "file.txt" })).resolves.toBe(true);
    const pendingBash = bridge?.approve({ action: "bash", target: "npm test" });
    expect(pendingBash).toBeInstanceOf(Promise);
    expect(sent.filter((event) => event.channel === ipcChannels.permissionRequest)).toHaveLength(1);

    await service.setSessionAutoApprove("all");
    await expect(bridge?.approve({ action: "bash", target: "npm test" })).resolves.toBe(true);
    expect(sent.filter((event) => event.channel === ipcChannels.permissionRequest)).toHaveLength(1);
  });

  it("auto-approves build plans outside ask permission mode", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const { window, sent } = fakeWindow();
    let confirmed: boolean | undefined;
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      homeDir: home,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async (): Promise<AgentFns> => fakeAgents(),
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        confirmed = await options.confirmPlan?.(plan);
        return { phase: "DONE", summary: confirmed ? "approved" : "rejected", plan, reports: [], verdicts: [], takeover: false };
      }
    });

    await service.setConfig({ permissionMode: "yolo" });
    await service.startSession({ projectDir: cwd });
    await service.run("build");

    expect(confirmed).toBe(true);
    expect(sent.some((event) => event.channel === ipcChannels.planConfirm)).toBe(false);
  });

  it("asks for build plan confirmation in ask mode and follows the response", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const { window, sent } = fakeWindow();
    let confirmed: boolean | undefined;
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      homeDir: home,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async (): Promise<AgentFns> => fakeAgents(),
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        confirmed = await options.confirmPlan?.(plan);
        return { phase: "DONE", summary: confirmed ? "approved" : "rejected", plan, reports: [], verdicts: [], takeover: false };
      }
    });

    await service.startSession({ projectDir: cwd });
    const run = service.run("build");
    const prompt = await waitForPlanConfirm(sent);
    respondToPlan(service, (prompt.payload as { id: string }).id, false);
    await run;

    expect(confirmed).toBe(false);
    expect(sent.filter((event) => event.channel === ipcChannels.planConfirm)).toHaveLength(1);
    expect(sent.find((event) => event.channel === ipcChannels.doneEvent)?.payload).toMatchObject({ summary: "rejected" });
  });

  it("auto-approves build plans when session auto-approve-all is active", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const { window, sent } = fakeWindow();
    let confirmed: boolean | undefined;
    const service = new TandemService(window as never, {
      registerIpcResponses: false,
      homeDir: home,
      createSession: async () => ({
        id: "session-1",
        append: async () => undefined,
        read: async () => []
      }),
      createAgents: async (): Promise<AgentFns> => fakeAgents(),
      runOrchestration: async (options: RunOptions): Promise<RunResult> => {
        confirmed = await options.confirmPlan?.(plan);
        return { phase: "DONE", summary: confirmed ? "approved" : "rejected", plan, reports: [], verdicts: [], takeover: false };
      }
    });

    await service.startSession({ projectDir: cwd });
    await service.setSessionAutoApprove("all");
    await service.run("build");

    expect(confirmed).toBe(true);
    expect(sent.some((event) => event.channel === ipcChannels.planConfirm)).toBe(false);
  });

  it("deletes the active session by rotating to a fresh session", async () => {
    const cwd = await tempDir();
    const { window } = fakeWindow();
    const service = new TandemService(window as never, { registerIpcResponses: false });

    const first = await service.startSession({ projectDir: cwd });
    const response = await service.deleteSession(first.sessionId);

    expect(response.activeSession?.sessionId).toBeTruthy();
    expect(response.activeSession?.sessionId).not.toBe(first.sessionId);
    expect(response.sessions.some((session) => session.id === first.sessionId)).toBe(false);
    expect(response.sessions.some((session) => session.id === response.activeSession?.sessionId)).toBe(true);
  });
});
