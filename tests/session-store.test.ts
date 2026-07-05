import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveSession, deleteSession, listSessions, renameSession, SessionStore, sessionIndexPath, truncateTitle } from "../src/session/store.js";

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
});
