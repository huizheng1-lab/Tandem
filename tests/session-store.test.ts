import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveSession,
  deleteSession,
  findSessionProjectDir,
  listSessions,
  renameSession,
  readSessionStartEvent,
  SESSION_EVENT_JSON_MAX_BYTES,
  SessionStore,
  sessionDir,
  sessionIndexPath,
  truncateTitle
} from "../src/session/store.js";

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function tempProject(): Promise<{ cwd: string; home: string }> {
  return { cwd: await tempDir("session-cwd"), home: await tempDir("session-home") };
}

describe("SessionStore", () => {
  it("maintains the per-project index and auto-titles from the first user prompt", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);

    const created = await listSessions(cwd, home);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: store.id, title: store.id.slice(0, 8), archived: false });

    const prompt = "Please build the desktop session manager with a compact archive section and safe delete flow";
    await store.append("user", { prompt });
    await store.append("text", { role: "leader", delta: "Done." });

    const sessions = await listSessions(cwd, home);
    expect(sessions[0]?.id).toBe(store.id);
    expect(sessions[0]?.title).toBe(truncateTitle(prompt));
    expect(sessions[0]?.title.endsWith("...")).toBe(true);
    expect(sessions[0]?.title.length).toBeLessThanOrEqual(51);

    const index = JSON.parse(await readFile(sessionIndexPath(cwd, home), "utf8")) as Record<string, { title: string; lastActiveAt: string }>;
    expect(index[store.id]?.title).toBe(sessions[0]?.title);
    expect(index[store.id]?.lastActiveAt).toBe(sessions[0]?.lastActiveAt);
  });

  it("renames, archives, unarchives, and deletes sessions", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    await store.append("user", { prompt: "initial title" });

    await renameSession(store.id, "Release prep", cwd, home);
    await archiveSession(store.id, true, cwd, home);
    expect(await listSessions(cwd, home)).toMatchObject([{ id: store.id, title: "Release prep", archived: true }]);

    await archiveSession(store.id, false, cwd, home);
    expect((await listSessions(cwd, home))[0]?.archived).toBe(false);

    await deleteSession(store.id, cwd, home);
    expect(await listSessions(cwd, home)).toEqual([]);
    expect(existsSync(store.filePath)).toBe(false);
  });

  it("rejects rename, archive, and delete for unknown session ids", async () => {
    const { cwd, home } = await tempProject();

    await expect(renameSession("missing-id", "Nope", cwd, home)).rejects.toThrow(/No session missing-id in /);
    await expect(archiveSession("missing-id", true, cwd, home)).rejects.toThrow(/No session missing-id in /);
    await expect(deleteSession("missing-id", cwd, home)).rejects.toThrow(/No session missing-id in /);
  });

  it("does not create phantom index rows when renaming an unknown id", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    await store.append("user", { prompt: "real session" });

    await expect(renameSession("foreign-id", "Phantom", cwd, home)).rejects.toThrow(/No session foreign-id in /);

    const sessions = await listSessions(cwd, home);
    expect(sessions.map((session) => session.id)).toEqual([store.id]);
    expect(sessions.some((session) => session.id === "foreign-id")).toBe(false);
  });

  it("lazily rebuilds a missing or corrupt index from session logs", async () => {
    const { cwd, home } = await tempProject();
    const first = await SessionStore.create(cwd, home);
    await first.append("user", { prompt: "first prompt" });
    const second = await SessionStore.create(cwd, home);
    await second.append("user", { prompt: "second prompt" });

    await writeFile(sessionIndexPath(cwd, home), "{not-json", "utf8");

    const rebuilt = await listSessions(cwd, home);
    expect(rebuilt.map((session) => session.id).sort()).toEqual([first.id, second.id].sort());
    expect(rebuilt.find((session) => session.id === first.id)?.title).toBe("first prompt");

    const content = await readFile(sessionIndexPath(cwd, home), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("finds a session's project directory from its structured start event", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    await store.append("session:start", { projectDir: cwd });

    await expect(findSessionProjectDir(store.id, home)).resolves.toBe(cwd);
  });

  it("reads only the session head when finding the start event", async () => {
    const { cwd, home } = await tempProject();
    const dir = sessionDir(cwd, home);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "large-session.jsonl");
    await writeFile(
      filePath,
      `${JSON.stringify({ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: cwd } })}\nnot-json-${"x".repeat(2 * 1024 * 1024)}`,
      "utf8"
    );

    await expect(readSessionStartEvent(filePath)).resolves.toMatchObject({ type: "session:start", payload: { projectDir: cwd } });
    await expect(findSessionProjectDir("large-session", home)).resolves.toBe(cwd);
  });

  it("prunes old empty sessions but keeps sessions with user messages", async () => {
    const { cwd, home } = await tempProject();
    const dir = sessionDir(cwd, home);
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const emptyId = "empty-old";
    const userId = "user-old";
    await writeFile(path.join(dir, `${emptyId}.jsonl`), `${JSON.stringify({ type: "session:start", at: old, payload: { projectDir: cwd } })}\n`, "utf8");
    await writeFile(path.join(dir, `${userId}.jsonl`), `${JSON.stringify({ type: "user", at: old, payload: { prompt: "keep me" } })}\n`, "utf8");
    await writeFile(
      sessionIndexPath(cwd, home),
      `${JSON.stringify({
        [emptyId]: { title: emptyId, archived: false, createdAt: old, lastActiveAt: old },
        [userId]: { title: userId, archived: false, createdAt: old, lastActiveAt: old }
      })}\n`,
      "utf8"
    );

    const sessions = await listSessions(cwd, home);

    expect(sessions.map((session) => session.id)).toEqual([userId]);
    expect(existsSync(path.join(dir, `${emptyId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(dir, `${userId}.jsonl`))).toBe(true);
  });

  it("merges missing session files without wiping custom title or archived metadata", async () => {
    const { cwd, home } = await tempProject();
    const indexed = await SessionStore.create(cwd, home);
    await indexed.append("user", { prompt: "original title" });
    await renameSession(indexed.id, "Custom title", cwd, home);
    await archiveSession(indexed.id, true, cwd, home);

    const unindexedId = "unindexed-session";
    await writeFile(
      path.join(sessionDir(cwd, home), `${unindexedId}.jsonl`),
      `${JSON.stringify({ type: "user", at: "2026-01-01T00:00:00.000Z", payload: { prompt: "new file prompt" } })}\n`,
      "utf8"
    );

    const sessions = await listSessions(cwd, home);
    expect(sessions.find((session) => session.id === indexed.id)).toMatchObject({ title: "Custom title", archived: true });
    expect(sessions.find((session) => session.id === unindexedId)).toMatchObject({ title: "new file prompt", archived: false });
  });

  it("serializes concurrent index updates so appends do not clobber a rename", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    await store.append("user", { prompt: "initial title" });

    await Promise.all([
      ...Array.from({ length: 25 }, (_, index) => store.append("text", { role: "leader", delta: String(index) })),
      renameSession(store.id, "Concurrent rename", cwd, home)
    ]);

    expect((await listSessions(cwd, home))[0]).toMatchObject({ id: store.id, title: "Concurrent rename" });
  });

  it("keeps sibling deletes bounded while another session appends rapidly", async () => {
    const { cwd, home } = await tempProject();
    const active = await SessionStore.create(cwd, home);
    const target = await SessionStore.create(cwd, home);
    await active.append("user", { prompt: "active session" });
    await target.append("user", { prompt: "delete me" });

    const appends = Array.from({ length: 400 }, (_, index) =>
      active.append("text", { role: "leader", delta: `${index}:${"x".repeat(1024)}` })
    );
    const started = Date.now();

    await deleteSession(target.id, cwd, home);

    const elapsedMs = Date.now() - started;
    await Promise.all(appends);
    expect(elapsedMs).toBeLessThan(250);
    expect((await listSessions(cwd, home)).map((session) => session.id)).toEqual([active.id]);
  });

  it("reads a bounded recent event window for large desktop resumes", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    for (let index = 0; index < 120; index += 1) {
      await store.append("text", { role: "leader", delta: `event-${index}` });
    }

    const recent = await store.readRecent(25);

    expect(recent.truncated).toBe(true);
    expect(recent.events).toHaveLength(25);
    expect(recent.events[0]?.payload).toMatchObject({ delta: "event-95" });
    expect(recent.events.at(-1)?.payload).toMatchObject({ delta: "event-119" });
  });

  it("leaves normal event payloads unwrapped", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);

    await store.append("text", { role: "leader", delta: "small event" });

    const events = await store.read();
    expect(events[0]?.payload).toEqual({ role: "leader", delta: "small event" });
  });

  it("bounds oversized JSONL events and stores the original payload as a sidecar artifact", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);
    const hugeDelta = `start-${"x".repeat(SESSION_EVENT_JSON_MAX_BYTES * 3)}-tail`;

    await store.append("text", { role: "leader", delta: hugeDelta });

    const lines = (await readFile(store.filePath, "utf8")).trim().split(/\r?\n/);
    expect(Buffer.byteLength(lines[0] ?? "", "utf8")).toBeLessThan(SESSION_EVENT_JSON_MAX_BYTES);

    const events = await store.read();
    const payload = events[0]?.payload as { role?: string; delta?: string; __tandemTruncation?: { truncated?: boolean; originalBytes?: number; storedBytes?: number; artifactPath?: string } };
    expect(payload.role).toBe("leader");
    expect(payload.delta).toContain("start-");
    expect(payload.delta).toContain("Tandem truncated");
    expect(payload.delta).not.toContain("-tail");
    expect(payload.__tandemTruncation).toMatchObject({ truncated: true });
    expect(payload.__tandemTruncation?.originalBytes).toBeGreaterThan(SESSION_EVENT_JSON_MAX_BYTES);
    expect(payload.__tandemTruncation?.storedBytes).toBeLessThan(SESSION_EVENT_JSON_MAX_BYTES);

    const artifactPath = payload.__tandemTruncation?.artifactPath;
    expect(artifactPath).toBeTruthy();
    const artifact = JSON.parse(await readFile(path.join(path.dirname(store.filePath), artifactPath ?? ""), "utf8")) as { payload: { delta: string } };
    expect(artifact.payload.delta).toBe(hugeDelta);
  });

  it("reads recent events cleanly after an oversized event", async () => {
    const { cwd, home } = await tempProject();
    const store = await SessionStore.create(cwd, home);

    await store.append("text", { role: "leader", delta: "before" });
    await store.append("text", { role: "leader", delta: "x".repeat(SESSION_EVENT_JSON_MAX_BYTES * 2) });
    await store.append("text", { role: "leader", delta: "after" });

    const recent = await store.readRecent(2);

    expect(recent.truncated).toBe(true);
    expect(recent.events).toHaveLength(2);
    expect(recent.events[0]?.payload).toMatchObject({ role: "leader" });
    expect(recent.events.at(-1)?.payload).toMatchObject({ delta: "after" });
  });
});
