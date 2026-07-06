import { describe, expect, it } from "vitest";
import { rebuildLeaderThread } from "../src/session/leader-thread.js";
import type { SessionEvent } from "../src/session/store.js";

function event(type: string, payload: unknown): SessionEvent {
  return { type, payload, at: "2026-01-01T00:00:00.000Z" };
}

describe("rebuildLeaderThread", () => {
  it("replays user prompts, leader answers, and submitted artifacts in order", () => {
    const thread = rebuildLeaderThread([
      event("user", { prompt: "create colors.txt with three colors" }),
      event("text", { role: "leader", delta: "I will plan it." }),
      event("machine", { type: "artifact", name: "BuildPlan", value: { title: "Colors" } }),
      event("done", { summary: "created colors.txt" }),
      event("user", { prompt: "add one more to that file" }),
      event("machine", { type: "artifact", name: "ReviewVerdict", value: { verdict: "approve" } })
    ]);

    expect(thread.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant", "user", "assistant"]);
    expect(thread[0]?.content).toContain("create colors.txt");
    expect(thread[4]?.content).toContain("add one more to that file");
    expect(thread.at(-1)?.content).toContain("Submitted ReviewVerdict");
  });

  it("resets older turns to a compaction summary event", () => {
    const thread = rebuildLeaderThread([
      event("user", { prompt: "old prompt" }),
      event("done", { summary: "old done" }),
      event("memory:compaction", { summary: "User created colors.txt.", compactedTurns: 2 }),
      event("user", { prompt: "follow-up" })
    ]);

    expect(thread).toEqual([
      { role: "assistant", content: "Conversation summary so far:\nUser created colors.txt." },
      { role: "user", content: "Request:\nfollow-up" }
    ]);
  });
});
