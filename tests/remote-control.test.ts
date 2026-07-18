import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RemoteBridge,
  formatSessions,
  formatStatus,
  parseRemoteCommand,
  parseRemoteMessage,
  type RemoteBridgeConfig,
  type RemoteInboundMessage,
  type RemoteTransport
} from "../src/remote-control/bridge.js";

class FakeTransport implements RemoteTransport {
  started = false;
  stopped = false;
  sent: Array<{ chatId: number; text: string }> = [];
  onMessage?: (message: RemoteInboundMessage) => void | Promise<void>;

  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>): void {
    this.started = true;
    this.onMessage = onMessage;
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

async function tempAuditPath(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-remote-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return path.join(dir, "remote-control-audit.jsonl");
}

function message(senderId: number, text: string): RemoteInboundMessage {
  return { updateId: senderId, senderId, chatId: senderId + 1000, text };
}

describe("remote control command parser", () => {
  it("accepts only the scoped Telegram grammar", () => {
    expect(parseRemoteCommand("/status")).toEqual({ verb: "status", args: "" });
    expect(parseRemoteCommand("/sessions")).toEqual({ verb: "sessions", args: "" });
    expect(parseRemoteCommand("/use abc123")).toEqual({ verb: "use", args: "abc123" });
    expect(parseRemoteCommand("/pause")).toEqual({ verb: "pause", args: "" });
    expect(parseRemoteCommand("/resume")).toEqual({ verb: "resume", args: "" });
    expect(parseRemoteCommand("/stop")).toEqual({ verb: "stop", args: "" });
    expect(parseRemoteCommand("/revoke")).toEqual({ verb: "revoke", args: "" });
    expect(parseRemoteCommand("/pair 12345678")).toEqual({ verb: "pair", args: "12345678" });
    expect(parseRemoteMessage("Confirm STOP 123456")).toEqual({ verb: "confirm-stop", args: "123456" });
    expect(parseRemoteCommand("/status now").verb).toBe("unknown");
    expect(parseRemoteCommand("/pair abc").verb).toBe("unknown");
    expect(parseRemoteCommand("/prompt build something").verb).toBe("unknown");
    expect(parseRemoteCommand("hello").verb).toBe("unknown");
  });
});

describe("RemoteBridge", () => {
  it("stays inert when disabled or when the Telegram token is absent", async () => {
    const transports: FakeTransport[] = [];
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      saveConfig: async () => {}
    });

    await bridge.configure({ enabled: false });
    expect(transports).toHaveLength(0);

    const noTokenBridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      tokenProvider: () => undefined,
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      saveConfig: async () => {}
    });

    await noTokenBridge.configure({ enabled: true, telegramUserId: 42 });
    expect(transports).toHaveLength(0);
    expect(noTokenBridge.state()).toMatchObject({ configured: false, polling: false });
  });

  it("expires pairing codes and rejects wrong codes", async () => {
    let now = Date.now();
    const transport = new FakeTransport();
    const saves: RemoteBridgeConfig[] = [];
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      saveConfig: async (patch) => {
        saves.push(patch);
      },
      now: () => now
    });

    const first = await bridge.enablePairing();
    expect(first.pairingCode).toMatch(/^\d{8}$/);
    await bridge.handleMessage(message(7, "/pair 00000000"));
    expect(transport.sent.at(-1)?.text).toMatch(/invalid or expired/i);

    now += 6 * 60 * 1000;
    await bridge.handleMessage(message(7, `/pair ${first.pairingCode}`));
    expect(bridge.state().paired).toBe(false);
    expect(transport.sent.at(-1)?.text).toMatch(/invalid or expired/i);
    expect(saves).toEqual([{ enabled: true }]);
  });

  it("binds one Telegram sender, serves read-only commands, and silently drops others", async () => {
    const auditPath = await tempAuditPath();
    const transport = new FakeTransport();
    const saves: RemoteBridgeConfig[] = [];
    const bridge = new RemoteBridge({
      auditPath,
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [{ id: "abcdef123456", title: "Build feature", projectDir: "C:\\repo" }],
      saveConfig: async (patch) => {
        saves.push(patch);
      }
    });

    const state = await bridge.enablePairing();
    await bridge.handleMessage(message(101, `/pair ${state.pairingCode}`));
    expect(saves.at(-1)).toEqual({ enabled: true, telegramUserId: 101 });
    expect(bridge.state()).toMatchObject({ enabled: true, paired: true, pairedUserId: "...101" });

    await bridge.handleMessage(message(101, "/status"));
    expect(transport.sent.at(-1)?.text).toContain("Session: session-1");
    await bridge.handleMessage(message(101, "/sessions"));
    expect(transport.sent.at(-1)?.text).toContain("abcdef12 - Build feature - repo");

    const sentBeforeReject = transport.sent.length;
    await bridge.handleMessage(message(202, "/status"));
    expect(transport.sent).toHaveLength(sentBeforeReject);

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"event":"paired"');
    expect(audit).toContain('"event":"rejected-sender"');
    expect(audit).not.toContain(state.pairingCode ?? "missing-code");
  });

  it("revokes from the paired phone and stops polling", async () => {
    const transport = new FakeTransport();
    const saves: RemoteBridgeConfig[] = [];
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      saveConfig: async (patch) => {
        saves.push(patch);
      }
    });

    const state = await bridge.enablePairing();
    await bridge.handleMessage(message(55, `/pair ${state.pairingCode}`));
    await bridge.handleMessage(message(55, "/revoke"));

    expect(transport.sent.at(-1)?.text).toMatch(/revoked/i);
    expect(transport.stopped).toBe(true);
    expect(bridge.state()).toMatchObject({ enabled: false, paired: false, polling: false });
    expect(saves.at(-1)).toEqual({ enabled: false, telegramUserId: undefined });
  });

  it("confirms emergency stop with a single-use expiring nonce", async () => {
    let now = Date.now();
    let stops = 0;
    const transport = new FakeTransport();
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      actions: {
        pause: async () => ({ ok: true, message: "paused" }),
        resume: async () => ({ ok: true, message: "resumed" }),
        stop: async () => {
          stops += 1;
          return { ok: true, message: "stopped" };
        },
        useSession: async () => ({ ok: true, message: "using" })
      },
      saveConfig: async () => {},
      now: () => now
    });
    await bridge.configure({ enabled: true, telegramUserId: 101 });

    await bridge.handleMessage(message(101, "/stop"));
    const firstNonce = /Confirm STOP (\d{6})/.exec(transport.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect(firstNonce).toMatch(/^\d{6}$/);
    await bridge.handleMessage(message(101, "Confirm STOP 000000"));
    expect(transport.sent.at(-1)?.text).toMatch(/invalid/i);
    expect(stops).toBe(0);

    await bridge.handleMessage(message(101, "/stop"));
    const expiredNonce = /Confirm STOP (\d{6})/.exec(transport.sent.at(-1)?.text ?? "")?.[1] ?? "";
    now += 61_000;
    await bridge.handleMessage(message(101, `Confirm STOP ${expiredNonce}`));
    expect(transport.sent.at(-1)?.text).toMatch(/expired/i);
    expect(stops).toBe(0);

    await bridge.handleMessage(message(101, "/stop"));
    const nonce = /Confirm STOP (\d{6})/.exec(transport.sent.at(-1)?.text ?? "")?.[1] ?? "";
    await bridge.handleMessage(message(101, `Confirm STOP ${nonce}`));
    expect(transport.sent.at(-1)?.text).toBe("stopped");
    expect(stops).toBe(1);
    await bridge.handleMessage(message(101, `Confirm STOP ${nonce}`));
    expect(transport.sent.at(-1)?.text).toMatch(/invalid/i);
    expect(stops).toBe(1);
  });

  it("switches sessions by unique prefix and rejects ambiguous or missing matches", async () => {
    const transport = new FakeTransport();
    const used: string[] = [];
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [
        { id: "abcdef123456", title: "One", projectDir: "C:\\repo-one" },
        { id: "abcdef999999", title: "Two", projectDir: "C:\\repo-two" }
      ],
      actions: {
        pause: async () => ({ ok: true, message: "paused" }),
        resume: async () => ({ ok: true, message: "resumed" }),
        stop: async () => ({ ok: true, message: "stopped" }),
        useSession: async (id) => {
          used.push(id);
          return { ok: true, message: `Using ${id.slice(0, 8)}` };
        }
      },
      saveConfig: async () => {}
    });
    await bridge.configure({ enabled: true, telegramUserId: 101 });

    await bridge.handleMessage(message(101, "/use abcdef"));
    expect(transport.sent.at(-1)?.text).toMatch(/ambiguous/i);
    expect(transport.sent.at(-1)?.text).toContain("abcdef12");
    expect(used).toEqual([]);

    await bridge.handleMessage(message(101, "/use zzz"));
    expect(transport.sent.at(-1)?.text).toMatch(/No session matches/i);
    expect(used).toEqual([]);

    await bridge.handleMessage(message(101, "/use abcdef12"));
    expect(transport.sent.at(-1)?.text).toBe("Using abcdef12");
    expect(used).toEqual(["abcdef123456"]);
  });

  it("rate limits the new mutating verbs through the shared command bucket", async () => {
    const transport = new FakeTransport();
    let pauses = 0;
    const bridge = new RemoteBridge({
      auditPath: await tempAuditPath(),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => statusFixture(),
      sessionsProvider: async () => [],
      actions: {
        pause: async () => {
          pauses += 1;
          return { ok: true, message: "paused" };
        },
        resume: async () => ({ ok: true, message: "resumed" }),
        stop: async () => ({ ok: true, message: "stopped" }),
        useSession: async () => ({ ok: true, message: "using" })
      },
      saveConfig: async () => {}
    });
    await bridge.configure({ enabled: true, telegramUserId: 101 });

    for (let index = 0; index < 11; index += 1) await bridge.handleMessage(message(101, "/pause"));

    expect(pauses).toBe(10);
    expect(transport.sent.at(-1)?.text).toMatch(/cooling down/i);
  });

  it("formats compact status and session summaries", () => {
    expect(formatStatus(statusFixture())).toContain("Run health: unknown");
    expect(formatSessions([{ id: "1234567890", title: "", projectDir: undefined }])).toBe("12345678 - Untitled session - unknown project");
  });
});

function statusFixture() {
  return {
    sessionId: "session-1",
    phase: "IDLE",
    activeRole: "none",
    cost: {
      leader: { inputTokens: 1, outputTokens: 2, dollars: 0.01 },
      worker: { inputTokens: 3, outputTokens: 4, dollars: 0.02 }
    }
  };
}
