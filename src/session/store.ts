import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tandemStateDir } from "../paths.js";
import { parseJsonText, readJsonFile, stripJsonBom } from "../json.js";

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
  projectDir?: string;
}

type SessionIndexEntry = Omit<SessionMetadata, "id" | "projectDir">;
type SessionIndex = Record<string, SessionIndexEntry>;
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

function projectOwnershipPath(homeDir: string | undefined, projectHashDir: string): string {
  return path.join(tandemStateDir(homeDir), "sessions", projectHashDir, "project.json");
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
    value: `${value.slice(0, maxChars)}\n\n[Tandem truncated ${hidden.toLocaleString()} additional characters from this session event at storage time to keep the session log bounded.]`,
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

function isCheckpointMachineEvent(event: SessionEvent): boolean {
  return event.type === "machine" && isRecord(event.payload) && event.payload.type === "checkpoint";
}

function boundedSessionEvent(event: SessionEvent): SessionEvent {
  if (isCheckpointMachineEvent(event)) return event;
  const originalBytes = jsonBytes(event);
  if (originalBytes <= SESSION_EVENT_JSON_MAX_BYTES) return event;

  const preview = previewValue(event.payload, SESSION_EVENT_PREVIEW_STRING_CHARS, SESSION_EVENT_COLLECTION_PREVIEW_ITEMS).value;
  const metadata: Omit<SessionEventTruncation, "storedBytes"> = {
    truncated: true,
    originalBytes,
    note: "Session event payload exceeded Tandem's JSONL size limit and was truncated at storage time to keep the session log bounded."
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

async function readProjectOwnershipSidecar(ownershipPath: string): Promise<string | undefined> {
  try {
    const parsed = await readJsonFile<{ projectDir?: unknown }>(ownershipPath);
    return typeof parsed.projectDir === "string" ? parsed.projectDir : undefined;
  } catch {
    return undefined;
  }
}

export async function findSessionProjectDir(id: string, homeDir?: string): Promise<string | undefined> {
  const root = path.join(tandemStateDir(homeDir), "sessions");
  if (!existsSync(root)) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, `${id}.jsonl`);
    if (!existsSync(filePath)) continue;
    const started = (await readSessionStartEvent(filePath))?.payload as { projectDir?: unknown } | undefined;
    if (typeof started?.projectDir === "string") return started.projectDir;
    // Fall back to the durable sidecar written by SessionStore.create().
    return readProjectOwnershipSidecar(projectOwnershipPath(homeDir, entry.name));
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
    return await readJsonFile<SessionIndex>(sessionIndexPath(cwd, homeDir));
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
  return stripJsonBom(content)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseJsonText<SessionEvent>(line));
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
        const event = parseJsonText<SessionEvent>(line);
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
      events: lines.slice(-limit).map((line) => parseJsonText<SessionEvent>(line)),
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

async function synthesizeSessionEntry(cwd: string, homeDir: string | undefined, id: string): Promise<SessionIndexEntry> {
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

async function updateSessionIndex(cwd: string, homeDir: string | undefined, id: string, updater: (entry: SessionIndexEntry) => void): Promise<void> {
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

async function updateExistingSessionIndex(cwd: string, homeDir: string | undefined, id: string, updater: (entry: SessionIndexEntry) => void): Promise<void> {
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
    // Write a durable ownership sidecar so listAllSessions and findSessionProjectDir
    // can resolve projectDir even for sessions that never append a session:start event.
    const ownershipPath = path.join(dir, "project.json");
    if (!existsSync(ownershipPath)) {
      await writeFile(ownershipPath, `${JSON.stringify({ projectDir: path.resolve(cwd) })}\n`, "utf8");
    }
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
    const storedEvent = boundedSessionEvent(event);
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

async function sessionProjectDirFromHashDir(hashDir: string, ownershipSidecarPath: string, filePath: string): Promise<string | undefined> {
  void hashDir;
  const started = (await readSessionStartEvent(filePath))?.payload as { projectDir?: unknown } | undefined;
  if (typeof started?.projectDir === "string") return started.projectDir;
  // Fall back to the durable sidecar written by SessionStore.create().
  return readProjectOwnershipSidecar(ownershipSidecarPath);
}

async function synthesizeGlobalSessionEntry(id: string, filePath: string): Promise<SessionIndexEntry> {
  const fileStat = await stat(filePath);
  const timestamp = fileStat.mtime.toISOString();
  return {
    title: id.slice(0, 8),
    archived: false,
    createdAt: timestamp,
    lastActiveAt: timestamp
  };
}

export async function listAllSessions(homeDir?: string): Promise<SessionMetadata[]> {
  const root = path.join(tandemStateDir(homeDir), "sessions");
  if (!existsSync(root)) return [];
  await flushPendingAppendIndexUpdates();
  const sessions: SessionMetadata[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const ownershipSidecar = path.join(dir, "project.json");

    // Reconcile and prune this project-hash directory before collecting sessions,
    // consistent with how project-scoped listSessions() behaves.
    // Derive the project cwd using priority:
    // 1. project.json sidecar, if present and valid.
    // 2. Any .jsonl session with a valid first session:start event containing projectDir.
    let derivedProjectDir = await readProjectOwnershipSidecar(ownershipSidecar);
    if (derivedProjectDir === undefined) {
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        const started = (await readSessionStartEvent(filePath))?.payload as { projectDir?: unknown } | undefined;
        if (typeof started?.projectDir === "string") {
          derivedProjectDir = started.projectDir;
          // Opportunistically write project.json sidecar to self-heal
          try {
            await writeFile(ownershipSidecar, `${JSON.stringify({ projectDir: started.projectDir })}\n`, "utf8");
          } catch {
            // Ignore write errors to be safe
          }
          break;
        }
      }
    }

    if (derivedProjectDir !== undefined) {
      // Use the derived cwd so sessionDir() and sessionIndexPath() resolve to this hash dir.
      await enqueueIndexMutation(async () => {
        const rawIndex = await readIndex(derivedProjectDir, homeDir);
        const reconciled = await reconcileSessionIndex(derivedProjectDir, homeDir, rawIndex);
        const pruned = await pruneOldEmptySessions(derivedProjectDir, homeDir, reconciled);
        await writeIndex(derivedProjectDir, homeDir, pruned);
      });
    }

    let index: SessionIndex = {};
    try {
      index = await readJsonFile<SessionIndex>(path.join(dir, "index.json"));
    } catch {
      index = {};
    }
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(/\.jsonl$/, "");
      const filePath = path.join(dir, file);
      // Skip sessions pruned above (file may have been removed).
      if (!existsSync(filePath)) continue;
      const projectDir = await sessionProjectDirFromHashDir(entry.name, ownershipSidecar, filePath);
      const indexed = index[id] ?? (await synthesizeGlobalSessionEntry(id, filePath));
      sessions.push({ id, ...indexed, projectDir });
    }
  }
  return sessions.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
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
