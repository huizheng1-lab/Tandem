import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionEvent {
  type: string;
  at: string;
  payload: unknown;
}

export interface SessionMetadata {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  lastActiveAt: string;
}

type SessionIndex = Record<string, Omit<SessionMetadata, "id">>;
let indexQueue: Promise<void> = Promise.resolve();

export function projectHash(cwd = process.cwd()): string {
  return createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function sessionDir(cwd = process.cwd(), homeDir = homedir()): string {
  return path.join(homeDir, ".tandem", "sessions", projectHash(cwd));
}

export function sessionIndexPath(cwd = process.cwd(), homeDir = homedir()): string {
  return path.join(sessionDir(cwd, homeDir), "index.json");
}

export function truncateTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 48) return normalized || "Untitled session";
  const slice = normalized.slice(0, 48);
  const boundary = slice.lastIndexOf(" ");
  return `${(boundary >= 24 ? slice.slice(0, boundary) : slice).trimEnd()}...`;
}

async function enqueueIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(operation, operation);
  indexQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function readIndex(cwd: string, homeDir: string): Promise<SessionIndex> {
  try {
    return JSON.parse(await readFile(sessionIndexPath(cwd, homeDir), "utf8")) as SessionIndex;
  } catch {
    return {};
  }
}

async function writeIndex(cwd: string, homeDir: string, index: SessionIndex): Promise<void> {
  const filePath = sessionIndexPath(cwd, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  return content
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function sessionFileIds(cwd: string, homeDir: string): Promise<Set<string>> {
  const dir = sessionDir(cwd, homeDir);
  if (!existsSync(dir)) return new Set();
  return new Set((await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, "")));
}

async function synthesizeSessionEntry(cwd: string, homeDir: string, id: string): Promise<Omit<SessionMetadata, "id">> {
  const events = await readSessionEvents(path.join(sessionDir(cwd, homeDir), `${id}.jsonl`));
  const first = events[0]?.at ?? new Date(0).toISOString();
  const last = events.at(-1)?.at ?? first;
  const userPrompt = events.find((event) => event.type === "user")?.payload as { prompt?: unknown } | undefined;
  return {
    title: typeof userPrompt?.prompt === "string" ? truncateTitle(userPrompt.prompt) : id.slice(0, 8),
    archived: false,
    createdAt: first,
    lastActiveAt: last
  };
}

async function reconcileSessionIndex(cwd: string, homeDir: string, index: SessionIndex): Promise<SessionIndex> {
  const files = await sessionFileIds(cwd, homeDir);
  const next: SessionIndex = {};
  for (const id of files) {
    next[id] = index[id] ?? (await synthesizeSessionEntry(cwd, homeDir, id));
  }
  return next;
}

async function updateSessionIndex(cwd: string, homeDir: string, id: string, updater: (entry: Omit<SessionMetadata, "id">) => void): Promise<void> {
  await enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    const now = new Date().toISOString();
    index[id] ??= { title: id.slice(0, 8), archived: false, createdAt: now, lastActiveAt: now };
    const entry = index[id];
    updater(entry);
    await writeIndex(cwd, homeDir, index);
  });
}

export class SessionStore {
  readonly id: string;
  readonly filePath: string;

  private constructor(id: string, filePath: string, private readonly cwd: string, private readonly homeDir: string) {
    this.id = id;
    this.filePath = filePath;
  }

  static async create(cwd = process.cwd(), homeDir = homedir()): Promise<SessionStore> {
    const id = randomUUID();
    const dir = sessionDir(cwd, homeDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.jsonl`);
    await writeFile(filePath, "", { flag: "wx" });
    const now = new Date().toISOString();
    await updateSessionIndex(cwd, homeDir, id, (entry) => {
      entry.title = id.slice(0, 8);
      entry.archived = false;
      entry.createdAt = now;
      entry.lastActiveAt = now;
    });
    return new SessionStore(id, filePath, cwd, homeDir);
  }

  static async open(id: string, cwd = process.cwd(), homeDir = homedir()): Promise<SessionStore> {
    const filePath = path.join(sessionDir(cwd, homeDir), `${id}.jsonl`);
    if (!existsSync(filePath)) throw new Error(`No session ${id}. Run /sessions to list sessions.`);
    return new SessionStore(id, filePath, cwd, homeDir);
  }

  async append(type: string, payload: unknown): Promise<void> {
    const event: SessionEvent = { type, at: new Date().toISOString(), payload };
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(this.filePath, { flags: "a" });
      stream.once("error", reject);
      stream.end(`${JSON.stringify(event)}\n`, resolve);
    });
    await updateSessionIndex(this.cwd, this.homeDir, this.id, (entry) => {
      entry.lastActiveAt = event.at;
      if (type === "user" && (!entry.title || entry.title === this.id.slice(0, 8))) {
        const prompt = (payload as { prompt?: unknown } | undefined)?.prompt;
        if (typeof prompt === "string") entry.title = truncateTitle(prompt);
      }
    });
  }

  async read(): Promise<SessionEvent[]> {
    return readSessionEvents(this.filePath);
  }
}

export async function listSessions(cwd = process.cwd(), homeDir = homedir()): Promise<SessionMetadata[]> {
  const dir = sessionDir(cwd, homeDir);
  if (!existsSync(dir)) return [];
  return enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    await writeIndex(cwd, homeDir, index);
    return Object.entries(index)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  });
}

export async function renameSession(id: string, title: string, cwd = process.cwd(), homeDir = homedir()): Promise<void> {
  await updateSessionIndex(cwd, homeDir, id, (entry) => {
    entry.title = title.trim() || id.slice(0, 8);
  });
}

export async function archiveSession(id: string, archived: boolean, cwd = process.cwd(), homeDir = homedir()): Promise<void> {
  await updateSessionIndex(cwd, homeDir, id, (entry) => {
    entry.archived = archived;
  });
}

export async function deleteSession(id: string, cwd = process.cwd(), homeDir = homedir()): Promise<void> {
  await rm(path.join(sessionDir(cwd, homeDir), `${id}.jsonl`), { force: true });
  await enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    delete index[id];
    await writeIndex(cwd, homeDir, index);
  });
}
