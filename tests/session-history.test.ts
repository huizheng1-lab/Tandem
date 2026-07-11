import { describe, expect, it } from "vitest";
import { buildConversationHistory } from "../src/session/history.js";
import type { SessionEvent } from "../src/session/store.js";

function event(type: string, payload: unknown): SessionEvent {
  return { type, payload, at: "2026-01-01T00:00:00.000Z" };
}

function turn(prompt: string, summary: string, error = false): SessionEvent[] {
  return [event("user", { prompt }), event("done", { summary, error })];
}

describe("buildConversationHistory", () => {
  it("formats prior turns in chronological order", () => {
    const history = buildConversationHistory([...turn("create colors.txt", "created colors.txt"), ...turn("add blue", "added blue")]);

    expect(history.priorTurns).toBe(2);
    expect(history.truncated).toBe(false);
    expect(history.text).toContain("Turn 1:\nUser: create colors.txt\nOutcome: created colors.txt");
    expect(history.text).toContain("Turn 2:\nUser: add blue\nOutcome: added blue");
    expect(history.text.indexOf("Turn 1")).toBeLessThan(history.text.indexOf("Turn 2"));
  });

  it("caps history to the latest turns", () => {
    const events = Array.from({ length: 12 }, (_, index) => turn(`prompt ${index + 1}`, `summary ${index + 1}`)).flat();

    const history = buildConversationHistory(events);

    expect(history.priorTurns).toBe(12);
    expect(history.truncated).toBe(true);
    expect(history.text).toMatch(/^\(earlier turns omitted\)/);
    expect(history.text).not.toMatch(/User: prompt 1\n/);
    expect(history.text).not.toMatch(/User: prompt 2\n/);
    expect(history.text).toContain("prompt 3");
    expect(history.text).toContain("prompt 12");
  });

  it("drops oldest turns to fit the character budget", () => {
    const events = [
      ...turn("one", "x".repeat(80)),
      ...turn("two", "y".repeat(80)),
      ...turn("three", "z".repeat(80))
    ];

    const history = buildConversationHistory(events, 10, 160);

    expect(history.priorTurns).toBe(3);
    expect(history.truncated).toBe(true);
    expect(history.text.length).toBeLessThanOrEqual(160);
    expect(history.text).toContain("three");
    expect(history.text).not.toContain("one");
  });

  it("includes error turn summaries", () => {
    const history = buildConversationHistory(turn("run it", "Error: missing API key", true));

    expect(history.text).toContain("Outcome (error): Error: missing API key");
  });

  it("uses plain leader text when a turn has no done event", () => {
    const history = buildConversationHistory([event("user", { prompt: "what changed?" }), event("text", { role: "leader", delta: "Only CSS changed." })]);

    expect(history.text).toContain("Outcome: Only CSS changed.");
  });

  it("prefers persisted compaction summaries over omitted older turns", () => {
    const history = buildConversationHistory([
      ...turn("old prompt", "old outcome"),
      event("memory:compaction", { summary: "User created colors.txt and needs a follow-up.", compactedTurns: 1 }),
      ...turn("new prompt", "new outcome")
    ]);

    expect(history.truncated).toBe(false);
    expect(history.text).toMatch(/^Conversation summary so far:/);
    expect(history.text).toContain("User created colors.txt");
    expect(history.text).toContain("new prompt");
    expect(history.text).not.toContain("old prompt");
    expect(history.text).not.toContain("(earlier turns omitted)");
  });
});
