import { describe, expect, it } from "vitest";
import { addNote, formatSessionNotes, removeNote, replaySessionMemory } from "../src/session/memory.js";
import type { SessionEvent } from "../src/session/store.js";

function event(type: string, payload: unknown): SessionEvent {
  return { type, payload, at: "2026-01-01T00:00:00.000Z" };
}

describe("session memory", () => {
  it("replays notes with exact-text deduplication", () => {
    const notes = replaySessionMemory([
      event("memory", { id: "a", text: "Use single quotes", by: "user" }),
      event("memory", { id: "b", text: "Use single quotes", by: "leader" }),
      event("memory", { id: "c", text: "Tests use Vitest", by: "system" })
    ]);

    expect(notes).toEqual([
      { id: "b", text: "Use single quotes", by: "leader" },
      { id: "c", text: "Tests use Vitest", by: "system" }
    ]);
  });

  it("removes notes by replaying memory:remove events", () => {
    const notes = replaySessionMemory([
      event("memory", { id: "a", text: "Keep me", by: "user" }),
      event("memory", { id: "b", text: "Remove me", by: "worker" }),
      event("memory:remove", { id: "b" })
    ]);

    expect(notes).toEqual([{ id: "a", text: "Keep me", by: "user" }]);
  });

  it("keeps the newest 40 notes", () => {
    const notes = replaySessionMemory(
      Array.from({ length: 45 }, (_, index) => event("memory", { id: String(index + 1), text: `note ${index + 1}`, by: "system" }))
    );

    expect(notes).toHaveLength(40);
    expect(notes[0]?.text).toBe("note 6");
    expect(notes.at(-1)?.text).toBe("note 45");
  });

  it("formats newest-last notes within a character budget", () => {
    const text = formatSessionNotes(
      [
        { id: "a", text: "a".repeat(80), by: "user" },
        { id: "b", text: "b".repeat(80), by: "worker" },
        { id: "c", text: "final", by: "system" }
      ],
      80
    );

    expect(text).toMatch(/^\(older notes omitted\)/);
    expect(text).toContain("[system] final");
    expect(text).not.toContain("[user]");
  });

  it("appends and rejects duplicate notes through the store API", async () => {
    const events: SessionEvent[] = [];
    const store = {
      append: async (type: string, payload: unknown) => {
        events.push(event(type, payload));
      },
      read: async () => events
    };

    await expect(addNote(store, " Use single quotes ", "user")).resolves.toMatchObject({ added: true });
    await expect(addNote(store, "Use single quotes", "worker")).resolves.toMatchObject({ added: false });
    expect(replaySessionMemory(events)).toHaveLength(1);
  });

  it("deletes through the store API", async () => {
    const events = [event("memory", { id: "a", text: "temporary", by: "user" })];
    const store = {
      append: async (type: string, payload: unknown) => {
        events.push(event(type, payload));
      }
    };

    await removeNote(store, "a");

    expect(replaySessionMemory(events)).toEqual([]);
  });
});
