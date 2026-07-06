import { createHash, randomUUID } from "node:crypto";
import type { SessionEvent, SessionStore } from "./store.js";

export type MemoryAuthor = "leader" | "worker" | "system" | "user";

export interface SessionMemoryNote {
  id: string;
  text: string;
  by: MemoryAuthor;
}

export interface MemoryAppendResult {
  note: SessionMemoryNote;
  added: boolean;
}

const NOTE_LIMIT = 40;
const NOTE_TEXT_LIMIT = 300;
const NOTE_BUDGET = 2500;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fallbackId(note: Omit<SessionMemoryNote, "id">, index: number): string {
  return createHash("sha1").update(`${index}\0${note.by}\0${note.text}`).digest("hex").slice(0, 16);
}

function parseAuthor(value: unknown): MemoryAuthor {
  return value === "leader" || value === "worker" || value === "system" || value === "user" ? value : "system";
}

function parseNote(payload: unknown, index: number): SessionMemoryNote | undefined {
  const raw = payload as Record<string, unknown> | undefined;
  const text = typeof raw?.text === "string" ? normalizeText(raw.text) : "";
  if (!text) return undefined;
  const note = { text, by: parseAuthor(raw?.by) };
  const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId(note, index);
  return { id, ...note };
}

export function replaySessionMemory(events: SessionEvent[], limit = NOTE_LIMIT): SessionMemoryNote[] {
  const notes: SessionMemoryNote[] = [];
  const removed = new Set<string>();

  events.forEach((event, index) => {
    if (event.type === "memory:remove") {
      const raw = event.payload as Record<string, unknown> | undefined;
      if (typeof raw?.id === "string") removed.add(raw.id);
      if (typeof raw?.text === "string") {
        const text = normalizeText(raw.text);
        for (const note of notes) if (note.text === text) removed.add(note.id);
      }
      return;
    }
    if (event.type !== "memory") return;
    const note = parseNote(event.payload, index);
    if (!note || removed.has(note.id)) return;
    const duplicateIndex = notes.findIndex((item) => item.text === note.text);
    if (duplicateIndex >= 0) notes.splice(duplicateIndex, 1);
    notes.push(note);
  });

  return notes.filter((note) => !removed.has(note.id)).slice(-limit);
}

export function formatSessionNotes(notes: SessionMemoryNote[], budget = NOTE_BUDGET): string {
  let selected = [...notes];
  let omitted = false;
  while (selected.length > 0) {
    const body = selected.map((note) => `- [${note.by}] ${note.text}`).join("\n");
    const text = omitted ? `(older notes omitted)\n${body}` : body;
    if (text.length <= budget) return text;
    selected = selected.slice(1);
    omitted = true;
  }
  return omitted ? "(older notes omitted)" : "";
}

export async function addNote(store: Pick<SessionStore, "append" | "read">, text: string, by: MemoryAuthor): Promise<MemoryAppendResult> {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error("Memory note cannot be empty.");
  if (normalized.length > NOTE_TEXT_LIMIT) throw new Error(`Memory note is too long (${normalized.length}/${NOTE_TEXT_LIMIT}). Save one short fact, constraint, or decision.`);
  const existing = replaySessionMemory(await store.read()).find((note) => note.text === normalized);
  if (existing) return { note: existing, added: false };
  const note = { id: randomUUID(), text: normalized, by };
  await store.append("memory", note);
  return { note, added: true };
}

export async function removeNote(store: Pick<SessionStore, "append">, id: string): Promise<void> {
  await store.append("memory:remove", { id });
}
