import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tandemStateDir } from "../paths.js";

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
const EMPTY_SESSION_PRUNE_MS = 60 * 60 * 1000;
const APPEND_INDEX_DEBOUNCE_MS = 250;
const READ_TAIL_CHUNK_BYTES = 128 * 1024;
const READ_HEAD_CHUNK_BYTES = 64 * 1024;
export const SESSION_EVENT_JSON_MAX_BYTES = 256 * 1024;
export const SESSION_EVENT_PREVIEW_STRING_CHARS = 64 * 1024;
const SESSION_EVENT_FALLBACK_STRING_CHARS = 8 * 1024;
const SESSION_EVENT_COLLECTION_PREVIEW_ITEMS = 50;
const SESSION_EVENT_FALLBACK_COLLECTION_ITEMS = 8;

interface PendingAppendIndexUpdate {
  cwd: string;
  homeDir: string | undefined;
  id: string;
  lastActiveAt: string;
  title?: string;
}

interface SessionEventTruncation {
  truncated: true;
  originalBytes: number;
  storedBytes: number;
  artifactPath?: string;
  note: string;
}

const pendingAppendIndexUpdates = new Map<string, PendingAppendIndexUpdate>();
let appendIndexFlushTimer: ReturnType<typeof setTimeout> | undefined;

export function projectHash(cwd = process.cwd()): string {
  return createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function sessionDir(cwd = process.cwd(), homeDir?: string): string {
  return path.join(tandemStateDir(homeDir), "sessions", projectHash(cwd));
}

export function sessionIndexPath(cwd = process.cwd(), homeDir?: string): string {
  return path.join(sessionDir(cwd, homeDir), "index.json");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(jsonText(value), "utf8");
}

function truncateString(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  const hidden = value.length - maxChars;
  return {
    value: `${value.slice(0, maxChars)}\n\n[Tandem truncated ${hidden.toLocaleString()} additional characters from this session event. Full payload may be available in the event artifact.]`,
    truncated: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewValue(value: unknown, stringLimit: number, collectionLimit: number): { value: unknown; truncated: boolean } {
  if (typeof value === "string") return truncateString(value, stringLimit);
  if (Array.isArray(value)) {
    let truncated = value.length > collectionLimit;
    const items = value.slice(0, collectionLimit).map((item) => {
      const preview = previewValue(item, stringLimit, collectionLimit);
      truncated ||= preview.truncated;
      return preview.value;
    });
    if (value.length > collectionLimit) {
      items.push({ __tandemTruncatedItems: value.length - collectionLimit });
    }
    return { value: items, truncated };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    let truncated = entries.length > collectionLimit;
    const next: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, collectionLimit)) {
      const preview = previewValue(item, stringLimit, collectionLimit);
      truncated ||= preview.truncated;
      next[key] = preview.value;
    }
    if (entries.length > collectionLimit) next.__tandemTruncatedKeys = entries.length - collectionLimit;
    return { value: next, truncated };
  }
  return { value, truncated: false };
}

function withTruncationMetadata(payload: unknown, metadata: SessionEventTruncation): unknown {
  if (isRecord(payload)) return { ...payload, __tandemTruncation: metadata };
  return { __tandemTruncation: metadata, preview: payload };
}

function eventWithTruncationMetadata(event: SessionEvent, payload: unknown, metadata: Omit<SessionEventTruncation, "storedBytes">): SessionEvent {
  let storedBytes = 0;
  let next: SessionEvent = event;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    next = { ...event, payload: withTruncationMetadata(payload, { ...metadata, storedBytes }) };
    const bytes = jsonBytes(next);
    if (bytes === storedBytes) return next;
    storedBytes = bytes;
  }
  return next;
}

function artifactRelativePath(sessionId: string): string {
  return `${sessionId}.artifacts/${randomUUID()}.json`;
}

async function writePayloadArtifact(filePath: string, relativePath: string, event: SessionEvent): Promise<string | undefined> {
  try {
    const target = path.join(path.dirname(filePath), relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(event, null, 2)}\n`, "utf8");
    return relativePath;
  } catch {
    return undefined;
  }
}

async function boundedSessionEvent(filePath: string, sessionId: string, event: SessionEvent): Promise<SessionEvent> {
  const originalBytes = jsonBytes(event);
  if (originalBytes <= SESSION_EVENT_JSON_MAX_BYTES) return event;

  const artifactPath = await writePayloadArtifact(filePath, artifactRelativePath(sessionId), event);
  const preview = previewValue(event.payload, SESSION_EVENT_PREVIEW_STRING_CHARS, SESSION_EVENT_COLLECTION_PREVIEW_ITEMS).value;
  const metadata: Omit<SessionEventTruncation, "storedBytes"> = {
    truncated: true,
    originalBytes,
    artifactPath,
    note: "Session event payload exceeded Tandem's JSONL size limit and was stored as a bounded preview."
  };
  let bounded = eventWithTruncationMetadata(event, preview, metadata);
  let storedBytes = jsonBytes(bounded);

  if (storedBytes > SESSION_EVENT_JSON_MAX_BYTES) {
    const fallback = previewValue(event.payload, SESSION_EVENT_FALLBACK_STRING_CHARS, SESSION_EVENT_FALLBACK_COLLECTION_ITEMS).value;
    bounded = eventWithTruncationMetadata(event, fallback, metadata);
    storedBytes = jsonBytes(bounded);
  }

  if (storedBytes > SESSION_EVENT_JSON_MAX_BYTES) {
    const summary = {
      payloadType: Array.isArray(event.payload) ? "array" : typeof event.payload,
      keys: isRecord(event.payload) ? Object.keys(event.payload).slice(0, SESSION_EVENT_FALLBACK_COLLECTION_ITEMS) : undefined
    };
    bounded = eventWithTruncationMetadata(event, summary, metadata);
  }

  return bounded;
}

export async function findSessionProjectDir(id: string, homeDir?: string): Promise<string | undefined> {
  const root = path.join(tandemStateDir(homeDir), "sessions");
  if (!existsSync(root)) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, `${id}.jsonl`);
    if (!existsSync(filePath)) continue;
    const started = (await readSessionStartEvent(filePath))?.payload as { projectDir?: unknown } | undefined;
    return typeof started?.projectDir === "string" ? started.projectDir : undefined;
  }
  return undefined;
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

async function readIndex(cwd: string, homeDir: string | undefined): Promise<SessionIndex> {
  try {
    return JSON.parse(await readFile(sessionIndexPath(cwd, homeDir), "utf8")) as SessionIndex;
  } catch {
    return {};
  }
}

async function writeIndex(cwd: string, homeDir: string | undefined, index: SessionIndex): Promise<void> {
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

export async function readSessionStartEvent(filePath: string): Promise<SessionEvent | undefined> {
  if (!existsSync(filePath)) return undefined;
  const handle = await open(filePath, "r");
  try {
    let position = 0;
    let pending = "";
    while (true) {
      const buffer = Buffer.alloc(READ_HEAD_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return undefined;
      position += bytesRead;
      pending += buffer.subarray(0, bytesRead).toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as SessionEvent;
        if (event.type === "session:start") return event;
        return undefined;
      }
    }
  } finally {
    await handle.close();
  }
}

async function readRecentSessionEvents(filePath: string, limit: number): Promise<{ events: SessionEvent[]; truncated: boolean }> {
  if (!existsSync(filePath)) return { events: [], truncated: false };
  if (limit <= 0) return { events: [], truncated: true };
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let position = size;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= limit) {
      const length = Math.min(READ_TAIL_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      chunks.unshift(buffer);
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === 10) newlineCount += 1;
      }
    }
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const truncated = position > 0 || lines.length > limit;
    return {
      events: lines.slice(-limit).map((line) => JSON.parse(line) as SessionEvent),
      truncated
    };
  } finally {
    await handle.close();
  }
}

async function sessionFileIds(cwd: string, homeDir: string | undefined): Promise<Set<string>> {
  const dir = sessionDir(cwd, homeDir);
  if (!existsSync(dir)) return new Set();
  return new Set((await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, "")));
}

async function synthesizeSessionEntry(cwd: string, homeDir: string | undefined, id: string): Promise<Omit<SessionMetadata, "id">> {
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

async function reconcileSessionIndex(cwd: string, homeDir: string | undefined, index: SessionIndex): Promise<SessionIndex> {
  const files = await sessionFileIds(cwd, homeDir);
  const next: SessionIndex = {};
  for (const id of files) {
    next[id] = index[id] ?? (await synthesizeSessionEntry(cwd, homeDir, id));
  }
  return next;
}

async function pruneOldEmptySessions(cwd: string, homeDir: string | undefined, index: SessionIndex, now = Date.now()): Promise<SessionIndex> {
  const next: SessionIndex = {};
  for (const [id, entry] of Object.entries(index)) {
    const lastActiveAt = new Date(entry.lastActiveAt).getTime();
    if (!Number.isFinite(lastActiveAt) || now - lastActiveAt <= EMPTY_SESSION_PRUNE_MS) {
      next[id] = entry;
      continue;
    }
    const filePath = path.join(sessionDir(cwd, homeDir), `${id}.jsonl`);
    const events = await readSessionEvents(filePath);
    if (events.some((event) => event.type === "user")) {
      next[id] = entry;
      continue;
    }
    await rm(filePath, { force: true });
  }
  return next;
}

async function updateSessionIndex(cwd: string, homeDir: string | undefined, id: string, updater: (entry: Omit<SessionMetadata, "id">) => void): Promise<void> {
  await enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    const now = new Date().toISOString();
    index[id] ??= { title: id.slice(0, 8), archived: false, createdAt: now, lastActiveAt: now };
    const entry = index[id];
    updater(entry);
    await writeIndex(cwd, homeDir, index);
  });
}

function appendIndexKey(cwd: string, homeDir: string | undefined, id: string): string {
  return `${sessionIndexPath(cwd, homeDir)}\0${id}`;
}

function sameProject(left: PendingAppendIndexUpdate, cwd: string, homeDir: string | undefined): boolean {
  return sessionIndexPath(left.cwd, left.homeDir) === sessionIndexPath(cwd, homeDir);
}

function scheduleAppendIndexUpdate(update: PendingAppendIndexUpdate): void {
  const key = appendIndexKey(update.cwd, update.homeDir, update.id);
  const current = pendingAppendIndexUpdates.get(key);
  pendingAppendIndexUpdates.set(key, {
    ...update,
    title: current?.title ?? update.title
  });
  if (!appendIndexFlushTimer) {
    appendIndexFlushTimer = setTimeout(() => {
      appendIndexFlushTimer = undefined;
      void flushPendingAppendIndexUpdates();
    }, APPEND_INDEX_DEBOUNCE_MS);
  }
}

function discardPendingAppendIndexUpdate(cwd: string, homeDir: string | undefined, id: string): void {
  pendingAppendIndexUpdates.delete(appendIndexKey(cwd, homeDir, id));
}

async function flushPendingAppendIndexUpdates(cwd?: string, homeDir?: string): Promise<void> {
  const updates = [...pendingAppendIndexUpdates.entries()].filter(([, update]) => (cwd === undefined ? true : sameProject(update, cwd, homeDir)));
  if (updates.length === 0) return;
  for (const [key] of updates) pendingAppendIndexUpdates.delete(key);
  if (pendingAppendIndexUpdates.size === 0 && appendIndexFlushTimer) {
    clearTimeout(appendIndexFlushTimer);
    appendIndexFlushTimer = undefined;
  }
  const byProject = new Map<string, PendingAppendIndexUpdate[]>();
  for (const [, update] of updates) {
    const key = sessionIndexPath(update.cwd, update.homeDir);
    byProject.set(key, [...(byProject.get(key) ?? []), update]);
  }
  for (const group of byProject.values()) {
    const first = group[0];
    if (!first) continue;
    await enqueueIndexMutation(async () => {
      const files = await sessionFileIds(first.cwd, first.homeDir);
      const index = await reconcileSessionIndex(first.cwd, first.homeDir, await readIndex(first.cwd, first.homeDir));
      for (const update of group) {
        if (!files.has(update.id)) continue;
        const now = new Date().toISOString();
        index[update.id] ??= { title: update.id.slice(0, 8), archived: false, createdAt: now, lastActiveAt: now };
        const entry = index[update.id];
        entry.lastActiveAt = update.lastActiveAt;
        if (update.title && (!entry.title || entry.title === update.id.slice(0, 8))) entry.title = update.title;
      }
      await writeIndex(first.cwd, first.homeDir, index);
    });
  }
}

function noSessionError(id: string, cwd: string): Error {
  return new Error(`No session ${id} in ${cwd}.`);
}

async function updateExistingSessionIndex(cwd: string, homeDir: string | undefined, id: string, updater: (entry: Omit<SessionMetadata, "id">) => void): Promise<void> {
  await enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    const entry = index[id];
    if (!entry) throw noSessionError(id, cwd);
    updater(entry);
    await writeIndex(cwd, homeDir, index);
  });
}

export class SessionStore {
  readonly id: string;
  readonly filePath: string;

  private constructor(id: string, filePath: string, private readonly cwd: string, private readonly homeDir: string | undefined) {
    this.id = id;
    this.filePath = filePath;
  }

  static async create(cwd = process.cwd(), homeDir?: string): Promise<SessionStore> {
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

  static async open(id: string, cwd = process.cwd(), homeDir?: string): Promise<SessionStore> {
    const filePath = path.join(sessionDir(cwd, homeDir), `${id}.jsonl`);
    if (!existsSync(filePath)) throw new Error(`No session ${id}. Run /sessions to list sessions.`);
    return new SessionStore(id, filePath, cwd, homeDir);
  }

  async append(type: string, payload: unknown): Promise<void> {
    const event: SessionEvent = { type, at: new Date().toISOString(), payload };
    const storedEvent = await boundedSessionEvent(this.filePath, this.id, event);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(this.filePath, { flags: "a" });
      stream.once("error", reject);
      stream.end(`${JSON.stringify(storedEvent)}\n`, resolve);
    });
    const prompt = type === "user" ? (payload as { prompt?: unknown } | undefined)?.prompt : undefined;
    scheduleAppendIndexUpdate({
      cwd: this.cwd,
      homeDir: this.homeDir,
      id: this.id,
      lastActiveAt: storedEvent.at,
      title: typeof prompt === "string" ? truncateTitle(prompt) : undefined
    });
  }

  async read(): Promise<SessionEvent[]> {
    return readSessionEvents(this.filePath);
  }

  async readRecent(limit: number): Promise<{ events: SessionEvent[]; truncated: boolean }> {
    return readRecentSessionEvents(this.filePath, limit);
  }
}

export async function listSessions(cwd = process.cwd(), homeDir?: string): Promise<SessionMetadata[]> {
  const dir = sessionDir(cwd, homeDir);
  if (!existsSync(dir)) return [];
  await flushPendingAppendIndexUpdates(cwd, homeDir);
  return enqueueIndexMutation(async () => {
    const index = await pruneOldEmptySessions(cwd, homeDir, await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir)));
    await writeIndex(cwd, homeDir, index);
    return Object.entries(index)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  });
}

export async function renameSession(id: string, title: string, cwd = process.cwd(), homeDir?: string): Promise<void> {
  await flushPendingAppendIndexUpdates(cwd, homeDir);
  await updateExistingSessionIndex(cwd, homeDir, id, (entry) => {
    entry.title = title.trim() || id.slice(0, 8);
  });
}

export async function archiveSession(id: string, archived: boolean, cwd = process.cwd(), homeDir?: string): Promise<void> {
  await flushPendingAppendIndexUpdates(cwd, homeDir);
  await updateExistingSessionIndex(cwd, homeDir, id, (entry) => {
    entry.archived = archived;
  });
}

export async function deleteSession(id: string, cwd = process.cwd(), homeDir?: string): Promise<void> {
  const filePath = path.join(sessionDir(cwd, homeDir), `${id}.jsonl`);
  if (!existsSync(filePath)) throw noSessionError(id, cwd);
  discardPendingAppendIndexUpdate(cwd, homeDir, id);
  await rm(filePath);
  await enqueueIndexMutation(async () => {
    const index = await reconcileSessionIndex(cwd, homeDir, await readIndex(cwd, homeDir));
    delete index[id];
    await writeIndex(cwd, homeDir, index);
  });
}
