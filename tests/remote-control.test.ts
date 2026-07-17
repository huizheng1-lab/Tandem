import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RemoteBridge,
  formatSessions,
  formatStatus,
  parseRemoteCommand,
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
  it("accepts only the read-only Telegram grammar plus pair and revoke", () => {
    expect(parseRemoteCommand("/status")).toEqual({ verb: "status", args: "" });
    expect(parseRemoteCommand("/sessions")).toEqual({ verb: "sessions", args: "" });
    expect(parseRemoteCommand("/revoke")).toEqual({ verb: "revoke", args: "" });
    expect(parseRemoteCommand("/pair 12345678")).toEqual({ verb: "pair", args: "12345678" });
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
