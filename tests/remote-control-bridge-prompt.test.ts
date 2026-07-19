import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemoteBridge,
  type RemoteInboundMessage,
  type RemoteTransport
} from "../src/remote-control/bridge.js";
import type { SessionPromptSubmissionResult } from "../src/remote-control/prompt-submission.js";
import type { StreamingSessionEvent } from "../src/remote-control/streaming-session.js";
import { TelegramLongPollingTransport } from "../src/remote-control/telegram.js";

class PromptTransport implements RemoteTransport {
  nextMessageId = 100;
  sent: Array<{ chatId: number; messageId: number; text: string }> = [];
  edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  start(): void {}
  stop(): void {}
  async sendMessage(chatId: number, text: string): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, messageId, text });
    return { messageId };
  }
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }
}

afterEach(() => vi.useRealTimers());

describe("RemoteBridge prompt routing", () => {
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
});

function message(text: string, replyToMessageId?: number): RemoteInboundMessage {
  return { updateId: Math.floor(Math.random() * 100_000), senderId: 42, chatId: 77, text, replyToMessageId };
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
