import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemoteBridge,
  type RemoteInboundMessage,
  type RemoteSendOptions,
  type RemoteTransport
} from "../src/remote-control/bridge.js";
import type { SessionPromptSubmissionResult } from "../src/remote-control/prompt-submission.js";
import type { StreamingSessionEvent } from "../src/remote-control/streaming-session.js";
import { TelegramLongPollingTransport, type TelegramOffsetStore } from "../src/remote-control/telegram.js";

class PromptTransport implements RemoteTransport {
  nextMessageId = 100;
  sent: Array<{ chatId: number; messageId: number; text: string; options?: RemoteSendOptions }> = [];
  edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  answered: Array<{ callbackId: string; text?: string }> = [];
  start(): void {}
  stop(): void {}
  async sendMessage(chatId: number, text: string, options?: RemoteSendOptions): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, messageId, text, options });
    return { messageId };
  }
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }
}

afterEach(() => vi.useRealTimers());

describe("RemoteBridge prompt routing", () => {
  it("subscribes before submission so synchronous leader output reaches Telegram", async () => {
    const transport = new PromptTransport();
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const bridge = await createBridge(transport, async () => {
      receive?.({ role: "leader", phase: "answering", lastEventKind: "text", text: "Visible answer", ended: true });
      return { status: "submitted" };
    }, (_sessionId, onEvent) => {
      receive = onEvent;
      return () => {};
    });

    await bridge.handleMessage(message("/use session"));
    await bridge.handleMessage(message("/prompt explain this"));

    expect(transport.edited.at(-1)?.text).toContain("leader: Visible answer");
  });

  it("selects the only current session with tap-to-use controls so plain messages work", async () => {
    const transport = new PromptTransport();
    const submissions: string[] = [];
    const bridge = await createBridge(transport, async (prompt) => {
      submissions.push(prompt.text);
      return { status: "submitted" };
    });

    await bridge.handleMessage(message("/sessions"));
    expect(transport.sent.at(-1)?.text).toContain("Send any message to prompt it.");
    const button = transport.sent.at(-1)?.options?.inlineKeyboard?.[0]?.[0];
    expect(button).toMatchObject({ text: "1. Session" });
    expect(button?.data).toMatch(/^session:[a-f0-9]{16}$/);

    await bridge.handleMessage(callback(button?.data ?? ""));
    expect(transport.answered.at(-1)?.text).toBe("Session selected.");
    await bridge.handleMessage(message("plain prompt without /prompt"));
    expect(submissions).toEqual(["plain prompt without /prompt"]);
  });

  it("delivers a selected-session Hi after command churn without removing prompt rate limits", async () => {
    const transport = new PromptTransport();
    const submissions: string[] = [];
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const bridge = await createBridge(transport, async (prompt) => {
      submissions.push(prompt.text);
      receive?.({
        role: "leader",
        phase: "answering",
        lastEventKind: "done",
        text: "Hi! How can I help?",
        ended: true
      });
      return { status: "submitted" };
    }, (_sessionId, onEvent) => {
      receive = onEvent;
      return () => {};
    });

    await bridge.handleMessage(message("/sessions"));
    const buttonData = transport.sent.at(-1)?.options?.inlineKeyboard?.[0]?.[0]?.data ?? "";
    await bridge.handleMessage(callback(buttonData));
    for (let index = 0; index < 8; index += 1) await bridge.handleMessage(message("/status"));
    await bridge.handleMessage(message("/status"));
    expect(transport.sent.at(-1)?.text).toMatch(/cooling down/i);

    await bridge.handleMessage(message("Hi"));
    expect(submissions).toEqual(["Hi"]);
    expect(transport.edited.at(-1)?.text).toContain("leader: Hi! How can I help?");

    for (let index = 0; index < 9; index += 1) await bridge.handleMessage(message(`prompt ${index}`));
    await bridge.handleMessage(message("one prompt too many"));
    expect(submissions).toHaveLength(10);
    expect(transport.sent.at(-1)?.text).toMatch(/cooling down/i);
  });

  it("routes /prompt and live-message replies to the /use session, reuses one stream, and cancels with a summary", async () => {
    vi.useFakeTimers();
    const transport = new PromptTransport();
    const submissions: Array<{ chatId: number; sessionId: string; text: string }> = [];
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const bridge = await createBridge(transport, async (prompt) => {
      submissions.push(prompt);
      return { status: "submitted" };
    }, (_sessionId, onEvent) => {
      receive = onEvent;
      return () => {};
    });

    await bridge.handleMessage(message("/use session"));
    await bridge.handleMessage(message("/prompt first prompt"));
    const liveMessageId = transport.sent.at(-1)?.messageId;
    expect(liveMessageId).toBe(101);
    expect(submissions).toEqual([{ chatId: 77, sessionId: "session-123", text: "first prompt" }]);

    await Promise.all([
      bridge.handleMessage(message("reply one", liveMessageId)),
      bridge.handleMessage(message("reply two", liveMessageId))
    ]);
    expect(submissions[0]?.text).toBe("first prompt");
    expect(submissions.slice(1).map((entry) => entry.text).sort()).toEqual(["reply one", "reply two"]);
    expect(transport.edited.at(-1)?.text).toContain("Submitting prompt");
    expect(new Set(transport.edited.map((edit) => edit.messageId))).toEqual(new Set([liveMessageId]));

    receive?.({ role: "leader", phase: "working", health: "quiet", lastEventKind: "tool-call", text: "Running checks" });
    await vi.advanceTimersByTimeAsync(1_500);
    await bridge.handleMessage(message("/cancel"));
    expect(transport.sent.at(-1)?.text).toMatch(/^Cancelled session-123: leader \/ working; quiet; last event tool-call\.$/);
  });

  it("falls back from an unknown reply target to the selected session and reports no active session otherwise", async () => {
    const transport = new PromptTransport();
    const submissions: string[] = [];
    const bridge = await createBridge(transport, async (prompt) => {
      submissions.push(prompt.text);
      return { status: "submitted" };
    });

    await bridge.handleMessage(message("unknown target", 999));
    expect(transport.sent.at(-1)?.text).toMatch(/No active session/i);
    await bridge.handleMessage(message("/use session"));
    await bridge.handleMessage(message("fallback reply", 999));
    expect(submissions).toEqual(["fallback reply"]);
  });

  it("keeps the live binding retryable when submission fails", async () => {
    const transport = new PromptTransport();
    let outcome: SessionPromptSubmissionResult = { status: "submitted" };
    const bridge = await createBridge(transport, async () => outcome);
    await bridge.handleMessage(message("/use session"));
    await bridge.handleMessage(message("/prompt works"));
    const liveMessageId = transport.sent.at(-1)?.messageId;

    outcome = { status: "rejected", message: "Session is busy\ntry later" };
    await bridge.handleMessage(message("retry", liveMessageId));
    expect(transport.edited.at(-1)).toMatchObject({ messageId: liveMessageId });
    expect(transport.edited.at(-1)?.text).toContain("Submission failed: Session is busy try later");

    outcome = { status: "submitted" };
    await bridge.handleMessage(message("retry again", liveMessageId));
    expect(transport.edited.at(-1)?.text).toContain("Submitting prompt");
  });
});

describe("Telegram prompt reply metadata", () => {
  it("forwards reply_to_message.message_id to the bridge", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: [{
        update_id: 1,
        message: {
          message_id: 55,
          chat: { id: 77 },
          from: { id: 42 },
          text: "follow up",
          reply_to_message: { message_id: 101 }
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const transport = new TelegramLongPollingTransport("token", fetchImpl as typeof fetch);

    await new Promise<void>((resolve, reject) => {
      transport.start((inbound) => {
        try {
          expect(inbound.replyToMessageId).toBe(101);
          transport.stop();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, reject);
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("includes Telegram error descriptions when message edits fail", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      description: "Bad Request: message is not modified"
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const transport = new TelegramLongPollingTransport("token", fetchImpl as typeof fetch);

    await expect(transport.editMessage(77, 55, "unchanged")).rejects.toThrow("Bad Request: message is not modified");
  });

  it("loads and persists the polling offset around processed updates", async () => {
    const offsetStore = new MemoryOffsetStore(40);
    const fetchImpl = vi.fn(async (input) => {
      expect(new URL(String(input)).searchParams.get("offset")).toBe("40");
      return new Response(JSON.stringify({
        ok: true,
        result: [{ update_id: 41, message: { message_id: 1, chat: { id: 77 }, from: { id: 42 }, text: "/status" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = new TelegramLongPollingTransport("token", fetchImpl as typeof fetch, offsetStore);
    await new Promise<void>((resolve, reject) => {
      transport.start(() => {
        transport.stop();
        setTimeout(resolve, 0);
      }, reject);
    });

    expect(offsetStore.writes).toEqual([42]);
  });
});

class MemoryOffsetStore implements TelegramOffsetStore {
  writes: number[] = [];
  constructor(private value: number) {}
  async read(): Promise<number> { return this.value; }
  async write(offset: number): Promise<void> {
    this.value = offset;
    this.writes.push(offset);
  }
}

function message(text: string, replyToMessageId?: number): RemoteInboundMessage {
  return { updateId: Math.floor(Math.random() * 100_000), senderId: 42, chatId: 77, text, replyToMessageId };
}

function callback(callbackData: string): RemoteInboundMessage {
  return { updateId: Math.floor(Math.random() * 100_000), senderId: 42, chatId: 77, text: "", callbackData, callbackId: "session-callback", messageId: 100 };
}

async function createBridge(
  transport: PromptTransport,
  submitPrompt: NonNullable<ConstructorParameters<typeof RemoteBridge>[0]["submitPrompt"]>,
  subscribeSessionEvents: NonNullable<ConstructorParameters<typeof RemoteBridge>[0]["subscribeSessionEvents"]> = () => () => {}
): Promise<RemoteBridge> {
  const auditDir = path.join(tmpdir(), `tandem-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(auditDir, { recursive: true });
  const bridge = new RemoteBridge({
    auditPath: path.join(auditDir, "audit.jsonl"),
    transportFactory: () => transport,
    tokenProvider: () => "token",
    statusProvider: () => ({
      phase: "working",
      cost: {
        leader: { inputTokens: 0, outputTokens: 0, dollars: 0 },
        worker: { inputTokens: 0, outputTokens: 0, dollars: 0 }
      }
    }),
    sessionsProvider: async () => [{ id: "session-123", title: "Session" }],
    actions: {
      pause: async () => ({ ok: true, message: "paused" }),
      resume: async () => ({ ok: true, message: "resumed" }),
      stop: async () => ({ ok: true, message: "stopped" }),
      useSession: async () => ({ ok: true, message: "Using session" })
    },
    saveConfig: async () => {},
    subscribeSessionEvents,
    submitPrompt
  });
  await bridge.configure({ enabled: true, telegramUserId: 42 });
  return bridge;
}
