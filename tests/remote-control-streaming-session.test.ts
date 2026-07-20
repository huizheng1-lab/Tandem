import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StreamingSessionGateway,
  formatStreamingSnapshot,
  type StreamingSessionEvent,
  type StreamingSnapshot
} from "../src/remote-control/streaming-session.js";

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(patch: Partial<StreamingSnapshot> = {}): StreamingSnapshot {
  return {
    sessionId: "session-1",
    version: 1,
    role: "leader",
    phase: "implementation",
    elapsedMs: 12_000,
    health: "healthy",
    lastEventKind: "model-delta",
    recentText: ["Building the gateway"],
    ended: false,
    ...patch
  };
}

describe("streaming session formatting", () => {
  it("renders healthy, quiet, and stalled heartbeat states truthfully", () => {
    expect(formatStreamingSnapshot(snapshot())).toContain("leader / implementation / 12s\nhealthy");
    expect(formatStreamingSnapshot(snapshot({ health: "quiet" }))).toContain("quiet 12s - last event: model-delta");
    const stalled = formatStreamingSnapshot(snapshot({ health: "likely stalled", elapsedMs: 185_000, lastEventKind: "tool-call" }));
    expect(stalled).toContain("leader / implementation / 3m 5s");
    expect(stalled).toContain("likely stalled - last event: tool-call");
    expect(stalled).not.toContain("healthy");
  });

  it("keeps the live message within Telegram's text limit", () => {
    const text = formatStreamingSnapshot(snapshot({ recentText: ["x".repeat(5_000)] }));
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain("leader / implementation / 12s");
  });
});

describe("StreamingSessionGateway", () => {
  it("coalesces a ten-event burst into one versioned snapshot", async () => {
    vi.useFakeTimers();
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const emitted: StreamingSnapshot[] = [];
    const gateway = new StreamingSessionGateway({
      sessionId: "session-1",
      subscribe: (_sessionId, onEvent) => {
        receive = onEvent;
      },
      onSnapshot: (value) => emitted.push(value)
    });
    gateway.start();

    for (let index = 0; index < 10; index += 1) {
      receive?.({ role: "worker", phase: "testing", health: "healthy", lastEventKind: "model-delta", text: `chunk ${index}` });
    }
    await vi.advanceTimersByTimeAsync(1_499);
    expect(emitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ version: 1, role: "worker", phase: "testing" });
    expect(emitted[0]?.recentText).toEqual(["worker: chunk 0chunk 1chunk 2chunk 3chunk 4chunk 5chunk 6chunk 7chunk 8chunk 9"]);
  });

  it("keeps complete role responses while separating later system events", async () => {
    vi.useFakeTimers();
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const emitted: StreamingSnapshot[] = [];
    const gateway = new StreamingSessionGateway({
      sessionId: "session-1",
      subscribe: (_sessionId, onEvent) => { receive = onEvent; },
      onSnapshot: (value) => emitted.push(value),
      maxRecentLines: 4
    });
    gateway.start();

    receive?.({ role: "leader", lastEventKind: "text", text: "Here is " });
    receive?.({ role: "leader", lastEventKind: "text", text: "the full answer." });
    receive?.({ lastEventKind: "transition", text: "Reviewing" });
    receive?.({ lastEventKind: "transition", text: "Completed" });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(emitted[0]?.recentText).toEqual([
      "leader: Here is the full answer.",
      "system: Reviewing",
      "system: Completed"
    ]);
    expect(formatStreamingSnapshot(emitted[0] as StreamingSnapshot)).toContain("leader: Here is the full answer.");
  });

  it("releases a synchronous terminal subscription after it returns", () => {
    const unsubscribe = vi.fn();
    const onSnapshot = vi.fn();
    const onEnd = vi.fn();
    const gateway = new StreamingSessionGateway({
      sessionId: "session-1",
      subscribe: (_sessionId, onEvent) => {
        onEvent({ ended: true, phase: "completed" });
        return unsubscribe;
      },
      onSnapshot,
      onEnd
    });

    gateway.start();

    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the terminal snapshot inside the edit throttle window", async () => {
    vi.useFakeTimers();
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const emitted: StreamingSnapshot[] = [];
    const onEnd = vi.fn();
    const unsubscribe = vi.fn();
    const gateway = new StreamingSessionGateway({
      sessionId: "session-1",
      subscribe: (_sessionId, onEvent) => {
        receive = onEvent;
        return unsubscribe;
      },
      onSnapshot: (value) => emitted.push(value),
      onEnd
    });
    gateway.start();

    receive?.({ text: "running" });
    await vi.advanceTimersByTimeAsync(1_500);
    receive?.({ ended: true, phase: "completed" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(emitted).toHaveLength(1);
    expect(onEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ version: 2, phase: "completed", ended: true });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("cancels pending work and unsubscribes on stop", async () => {
    vi.useFakeTimers();
    let receive: ((event: StreamingSessionEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const onSnapshot = vi.fn();
    const gateway = new StreamingSessionGateway({
      sessionId: "session-1",
      subscribe: (_sessionId, onEvent) => {
        receive = onEvent;
        return unsubscribe;
      },
      onSnapshot
    });
    gateway.start();
    receive?.({ text: "pending" });
    gateway.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    receive?.({ text: "late" });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
