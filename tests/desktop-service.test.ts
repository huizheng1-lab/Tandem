import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TandemService } from "../app/main/tandem-service.js";
import { ipcChannels } from "../app/shared/ipc.js";
import type { AgentFns, RunOptions, RunResult } from "../src/orchestrator/machine.js";
import type { PermissionBridge } from "../src/tools/permissions.js";

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

describe("TandemService", () => {
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
