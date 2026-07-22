import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteBridge, type RemoteInboundMessage, type RemoteTransport } from "../src/remote-control/bridge.js";
import { TelegramSessionStream } from "../src/remote-control/telegram-session-stream.js";
import type { StreamingSessionEvent } from "../src/remote-control/streaming-session.js";

afterEach(() => {
  vi.useRealTimers();
});

function subscription() {
  let receive: ((event: StreamingSessionEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    subscribe: (_sessionId: string, onEvent: (event: StreamingSessionEvent) => void) => {
      receive = onEvent;
      return unsubscribe;
    },
    emit: (event: StreamingSessionEvent) => receive?.(event),
    unsubscribe
  };
}

describe("TelegramSessionStream", () => {
  it("throttles a three-second burst of twenty events to at most two edits", async () => {
    vi.useFakeTimers();
    const source = subscription();
    const editMessage = vi.fn(async (_chatId: number, _messageId: number, _text: string) => {});
    const stream = new TelegramSessionStream({
      chatId: 10,
      messageId: 20,
      sessionId: "session-1",
      telegram: { editMessage },
      subscribe: source.subscribe
    });
    stream.start();

    for (let index = 0; index < 20; index += 1) {
      source.emit({ text: `delta ${index}`, health: "healthy", lastEventKind: "model-delta" });
      await vi.advanceTimersByTimeAsync(150);
    }
    await Promise.resolve();
    expect(editMessage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(editMessage.mock.calls.length).toBeGreaterThan(0);
  });

  it("cancels a pending edit when stopped mid-burst", async () => {
    vi.useFakeTimers();
    const source = subscription();
    const editMessage = vi.fn(async () => {});
    const stream = new TelegramSessionStream({ chatId: 10, messageId: 20, sessionId: "session-1", telegram: { editMessage }, subscribe: source.subscribe });
    stream.start();
    source.emit({ text: "pending" });
    stream.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(editMessage).not.toHaveBeenCalled();
    expect(source.unsubscribe).toHaveBeenCalledOnce();
  });

  it("edits the terminal response before stopping on session end", async () => {
    vi.useFakeTimers();
    const ended = subscription();
    const endedStop = vi.fn();
    const editMessage = vi.fn(async (_chatId: number, _messageId: number, _text: string) => {});
    const endedStream = new TelegramSessionStream({
      chatId: 10,
      messageId: 20,
      sessionId: "ended",
      telegram: { editMessage },
      subscribe: ended.subscribe,
      onStopped: endedStop
    });
    endedStream.start();
    ended.emit({ role: "leader", ended: true, phase: "completed", lastEventKind: "done", text: "Final answer" });
    await Promise.resolve();
    expect(editMessage).toHaveBeenCalledOnce();
    expect(editMessage.mock.calls[0]?.[2]).toContain("leader: Final answer");
    expect(endedStop).toHaveBeenCalledOnce();
    expect(ended.unsubscribe).toHaveBeenCalledOnce();
  });

  it("stops cleanly and reports transport failure", async () => {
    vi.useFakeTimers();
    const failed = subscription();
    const failedStop = vi.fn();
    const failedError = vi.fn();
    const error = new Error("transport unavailable");
    const failedStream = new TelegramSessionStream({
      chatId: 10,
      messageId: 21,
      sessionId: "failed",
      telegram: { editMessage: vi.fn(async () => { throw error; }) },
      subscribe: failed.subscribe,
      onError: failedError,
      onStopped: failedStop
    });
    failedStream.start();
    failed.emit({ text: "update" });
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    expect(failedError).toHaveBeenCalledWith(failedStream, error);
    expect(failedStop).toHaveBeenCalledOnce();
    expect(failed.unsubscribe).toHaveBeenCalledOnce();
  });
});

class StreamTransport implements RemoteTransport {
  editMessage = vi.fn(async (_chatId: number, _messageId: number, _text: string) => {});
  start(_onMessage: (message: RemoteInboundMessage) => void | Promise<void>): void {}
  stop(): void {}
  async sendMessage(): Promise<undefined> { return undefined; }
}

describe("RemoteBridge stream registry", () => {
  it("replaces an existing stream for the same session and removes stopped entries", async () => {
    vi.useFakeTimers();
    const sources: ReturnType<typeof subscription>[] = [];
    const transport = new StreamTransport();
    const auditDir = path.join(tmpdir(), `tandem-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(auditDir, { recursive: true });
    const bridge = new RemoteBridge({
      auditPath: path.join(auditDir, "audit.jsonl"),
      transportFactory: () => transport,
      tokenProvider: () => "token",
      statusProvider: () => ({ phase: "working", cost: { leader: { inputTokens: 0, outputTokens: 0, dollars: 0 }, worker: { inputTokens: 0, outputTokens: 0, dollars: 0 } } }),
      sessionsProvider: async () => [],
      saveConfig: async () => {},
      subscribeSessionEvents: (_sessionId, onEvent) => {
        const source = subscription();
        source.subscribe(_sessionId, onEvent);
        sources.push(source);
        return source.unsubscribe;
      }
    });
    await bridge.configure({ enabled: true, telegramUserId: 42 });

    expect(bridge.startSessionStream(42, 100, "session-1")).toBe(true);
    expect(bridge.startSessionStream(42, 101, "session-1")).toBe(true);
    expect(sources[0]?.unsubscribe).toHaveBeenCalledOnce();
    sources[0]?.emit({ text: "stale" });
    sources[1]?.emit({ text: "current" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    expect(transport.editMessage.mock.calls[0]?.[1]).toBe(101);

    bridge.stopSessionStream(42, 101);
    sources[1]?.emit({ text: "after stop" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
  });
});
