import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { tandemStateDir } from "../paths.js";
import { parseJsonText, readJsonFile } from "../json.js";
import type { SessionEvent } from "./store.js";

export const DEFAULT_SEARCH_BATCH_SIZE = 25;
export const DEFAULT_SEARCH_RESULT_LIMIT = 200;
export const DEFAULT_SEARCH_HARD_RESULT_LIMIT = 1000;
export const DEFAULT_SEARCH_SNIPPET_CONTEXT = 80;

export type SessionSearchSourceRole = "title" | "user" | "leader" | "worker" | "summary" | "compaction";

export interface SessionSearchHit {
  id: string;
  title: string;
  lastActiveAt: string;
  projectDir?: string;
  matchCount: number;
  sourceRole: SessionSearchSourceRole;
  snippet: { text: string; start: number; end: number };
}

export interface SessionSearchBatch {
  hits: SessionSearchHit[];
  scannedCount: number;
  skippedCount: number;
  done: boolean;
}

export interface SessionSearchOptions {
  query: string;
  homeDir?: string;
  limit?: number;
  batchSize?: number;
  snippetContext?: number;
}

interface SessionIndexEntry {
  title: string;
  archived: boolean;
  createdAt: string;
  lastActiveAt: string;
}

type SessionIndex = Record<string, SessionIndexEntry>;

interface SearchableChunk {
  text: string;
  source: SessionSearchSourceRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_SEARCH_RESULT_LIMIT;
  return Math.min(Math.floor(limit), DEFAULT_SEARCH_HARD_RESULT_LIMIT);
}

function clampBatchSize(batchSize: number | undefined): number {
  if (typeof batchSize !== "number" || !Number.isFinite(batchSize) || batchSize <= 0) return DEFAULT_SEARCH_BATCH_SIZE;
  return Math.max(1, Math.floor(batchSize));
}

function clampSnippetContext(context: number | undefined): number {
  if (typeof context !== "number" || !Number.isFinite(context) || context < 0) return DEFAULT_SEARCH_SNIPPET_CONTEXT;
  return Math.floor(context);
}

function tokenizeQuery(query: string): string[] {
  if (typeof query !== "string") return [];
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function tokenizeSearchQuery(query: string): string[] {
  return tokenizeQuery(query);
}

export function matchEventText(event: SessionEvent): { text: string; source: SessionSearchSourceRole } | undefined {
  if (event.type === "user") {
    const prompt = isRecord(event.payload) ? event.payload.prompt : undefined;
    if (typeof prompt === "string") return { text: prompt, source: "user" };
  }
  if (event.type === "text" || event.type === "message") {
    const payload = event.payload;
    if (!isRecord(payload)) return undefined;
    const role = payload.role;
    if (role !== "leader" && role !== "worker") return undefined;
    const text = payload.text;
    const delta = payload.delta;
    if (typeof text === "string" && text.length > 0) return { text, source: role };
    if (typeof delta === "string" && delta.length > 0) return { text: delta, source: role };
  }
  if (event.type === "done") {
    const summary = isRecord(event.payload) ? event.payload.summary : undefined;
    if (typeof summary === "string") return { text: summary, source: "summary" };
  }
  if (event.type === "memory:compaction") {
    const summary = isRecord(event.payload) ? event.payload.summary : undefined;
    if (typeof summary === "string") return { text: summary, source: "compaction" };
  }
  return undefined;
}

export function scoreSearchableText(text: string, tokens: string[]): number {
  if (!Array.isArray(tokens) || tokens.length === 0) return 0;
  if (typeof text !== "string" || text.length === 0) return 0;
  const lower = text.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(token, from);
      if (idx === -1) break;
      total += 1;
      from = idx + token.length;
    }
  }
  return total;
}

export function extractSnippet(
  text: string,
  tokens: string[],
  contextChars: number = DEFAULT_SEARCH_SNIPPET_CONTEXT
): { text: string; start: number; end: number } {
  if (typeof text !== "string" || text.length === 0) return { text: "", start: 0, end: 0 };
  if (!Array.isArray(tokens) || tokens.length === 0) return { text: "", start: 0, end: 0 };
  const context = clampSnippetContext(contextChars);
  const lower = text.toLowerCase();

  const positionsPerToken: number[][] = [];
  for (const token of tokens) {
    if (!token) {
      positionsPerToken.push([]);
      continue;
    }
    const positions: number[] = [];
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(token, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + token.length;
    }
    positionsPerToken.push(positions);
  }

  if (positionsPerToken.some((positions) => positions.length === 0)) {
    return { text: "", start: 0, end: 0 };
  }

  let bestMin = positionsPerToken[0]?.[0] ?? 0;
  let bestMax = (positionsPerToken[0]?.[0] ?? 0) + (tokens[0]?.length ?? 0);
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const anchor of positionsPerToken[0] ?? []) {
    let minPos = anchor;
    let maxPos = anchor + (tokens[0]?.length ?? 0);
    let allFound = true;
    for (let i = 1; i < tokens.length; i += 1) {
      const positions = positionsPerToken[i] ?? [];
      const center = (minPos + maxPos) / 2;
      let chosenPos = -1;
      let chosenEnd = -1;
      let chosenDist = Number.POSITIVE_INFINITY;
      for (const position of positions) {
        const distance = Math.abs(position - center);
        if (distance < chosenDist) {
          chosenDist = distance;
          chosenPos = position;
          chosenEnd = position + (tokens[i]?.length ?? 0);
        }
      }
      if (chosenPos === -1) {
        allFound = false;
        break;
      }
      minPos = Math.min(minPos, chosenPos);
      maxPos = Math.max(maxPos, chosenEnd);
    }
    if (!allFound) continue;
    if (maxPos - minPos < bestSpan) {
      bestSpan = maxPos - minPos;
      bestMin = minPos;
      bestMax = maxPos;
    }
  }

  const start = Math.max(0, bestMin - context);
  const end = Math.min(text.length, bestMax + context);
  return { text: text.slice(start, end), start, end };
}

function rankAndTrim(candidates: SessionSearchHit[], limit: number): SessionSearchHit[] {
  return candidates
    .slice()
    .sort((a, b) => {
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    })
    .slice(0, limit);
}

interface ScannedSession {
  id: string;
  title: string;
  lastActiveAt: string;
  projectDir?: string;
  searchableChunks: SearchableChunk[];
}

async function readSessionIndex(dir: string): Promise<SessionIndex> {
  try {
    return await readJsonFile<SessionIndex>(path.join(dir, "index.json"));
  } catch {
    return {};
  }
}

async function readOwnershipProjectDir(hashDir: string): Promise<string | undefined> {
  try {
    const parsed = await readJsonFile<{ projectDir?: unknown }>(path.join(hashDir, "project.json"));
    if (typeof parsed.projectDir === "string") return parsed.projectDir;
  } catch {
    return undefined;
  }
  return undefined;
}

function safeStat(filePath: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  return stat(filePath).catch(() => undefined);
}

async function streamSession(filePath: string, signal: AbortSignal | undefined): Promise<{
  events: SessionEvent[];
  projectDir?: string;
  firstUserPrompt?: string;
  malformed: number;
  aborted: boolean;
}> {
  const events: SessionEvent[] = [];
  let projectDir: string | undefined;
  let firstUserPrompt: string | undefined;
  let malformed = 0;
  let aborted = false;
  const handle = createReadStream(filePath);
  const rl = createInterface({ input: handle, crlfDelay: Infinity });

  const abortHandler = () => {
    aborted = true;
    void handle.destroy();
    rl.close();
  };
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    for await (const line of rl) {
      if (aborted) break;
      if (!line.trim()) continue;
      try {
        const event = parseJsonText<SessionEvent>(line);
        events.push(event);
        if (event.type === "session:start" && isRecord(event.payload) && typeof event.payload.projectDir === "string") {
          projectDir = event.payload.projectDir;
        } else if (event.type === "user" && firstUserPrompt === undefined && isRecord(event.payload) && typeof event.payload.prompt === "string") {
          firstUserPrompt = event.payload.prompt;
        }
      } catch {
        malformed += 1;
      }
    }
  } finally {
    rl.close();
    handle.destroy();
    if (signal) signal.removeEventListener("abort", abortHandler);
  }

  return { events, projectDir, firstUserPrompt, malformed, aborted };
}

async function scanSessionFile(
  hashDir: string,
  id: string,
  indexEntry: SessionIndexEntry | undefined,
  signal: AbortSignal | undefined,
  homeDir: string
): Promise<ScannedSession> {
  const filePath = path.join(hashDir, `${id}.jsonl`);
  const fileStat = await safeStat(filePath);
  if (!fileStat) throw new Error(`session file not found: ${filePath}`);
  const scanned = await streamSession(filePath, signal);
  if (scanned.aborted) throw new Error("session scan aborted");

  let projectDir = scanned.projectDir;
  if (projectDir === undefined) {
    projectDir = await readOwnershipProjectDir(hashDir);
  }

  const title = indexEntry?.title ?? (scanned.firstUserPrompt ? scanned.firstUserPrompt : id.slice(0, 8));
  const lastActiveAt = indexEntry?.lastActiveAt ?? (scanned.events.at(-1)?.at ?? fileStat.mtime.toISOString());

  const searchableChunks: SearchableChunk[] = [{ text: title, source: "title" }];
  let pending: { text: string; source: "leader" | "worker" } | null = null;
  for (const event of scanned.events) {
    if (event.type === "session:start") continue;
    const match = matchEventText(event);
    if (!match) continue;
    if (match.source === "leader" || match.source === "worker") {
      if (pending && pending.source === match.source) {
        pending = { text: pending.text.length === 0 ? match.text : `${pending.text} ${match.text}`, source: match.source };
      } else {
        if (pending) searchableChunks.push(pending);
        pending = { text: match.text, source: match.source };
      }
    } else {
      if (pending) {
        searchableChunks.push(pending);
        pending = null;
      }
      searchableChunks.push(match);
    }
  }
  if (pending) searchableChunks.push(pending);

  void homeDir;
  return { id, title, lastActiveAt, projectDir, searchableChunks };
}

function rankScannedSessionsByMetadata(
  sessions: ScannedSession[],
  tokens: string[],
  snippetContext: number
): { ranked: SessionSearchHit[]; skipped: number } {
  const ranked: SessionSearchHit[] = [];
  let skipped = 0;
  for (const session of sessions) {
    let total = 0;
    let bestChunk: SearchableChunk | null = null;
    let bestChunkCount = -1;
    const tokenCounts: number[] = tokens.map(() => 0);
    for (const chunk of session.searchableChunks) {
      const lower = chunk.text.toLowerCase();
      let chunkTotal = 0;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? "";
        if (!token) continue;
        let from = 0;
        let tokenHits = 0;
        while (from <= lower.length) {
          const at = lower.indexOf(token, from);
          if (at === -1) break;
          tokenHits += 1;
          from = at + token.length;
        }
        chunkTotal += tokenHits;
        tokenCounts[index] = (tokenCounts[index] ?? 0) + tokenHits;
      }
      if (chunkTotal > 0) {
        total += chunkTotal;
        if (chunkTotal > bestChunkCount) {
          bestChunk = chunk;
          bestChunkCount = chunkTotal;
        }
      }
    }
    const matchesAllTokens = tokenCounts.every((count) => count > 0);
    if (total === 0 || bestChunk === null || bestChunkCount === -1 || !matchesAllTokens) {
      skipped += 1;
      continue;
    }
    const snippet = extractSnippet(bestChunk.text, tokens, snippetContext);
    ranked.push({
      id: session.id,
      title: session.title,
      lastActiveAt: session.lastActiveAt,
      projectDir: session.projectDir,
      matchCount: total,
      sourceRole: bestChunk.source,
      snippet
    });
  }
  return { ranked, skipped };
}

async function listHashDirs(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const hashDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    hashDirs.push(path.join(root, entry.name));
  }
  return hashDirs;
}

async function listSessionFiles(hashDir: string): Promise<Array<{ id: string; filePath: string }>> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(hashDir).catch(() => []);
  const files: Array<{ id: string; filePath: string }> = [];
  for (const file of entries) {
    if (!file.endsWith(".jsonl")) continue;
    files.push({ id: file.replace(/\.jsonl$/, ""), filePath: path.join(hashDir, file) });
  }
  return files;
}

export async function searchSessionsStream(
  options: SessionSearchOptions,
  signal?: AbortSignal
): Promise<AsyncIterable<SessionSearchBatch>> {
  const limit = clampLimit(options.limit);
  const batchSize = clampBatchSize(options.batchSize);
  const snippetContext = clampSnippetContext(options.snippetContext);
  const tokens = tokenizeQuery(options.query);

  async function* generate(): AsyncGenerator<SessionSearchBatch> {
    const aborted = () => signal?.aborted === true;
    if (aborted()) {
      yield { hits: [], scannedCount: 0, skippedCount: 0, done: true };
      return;
    }
    if (tokens.length === 0) {
      yield { hits: [], scannedCount: 0, skippedCount: 0, done: true };
      return;
    }

    const root = path.join(tandemStateDir(options.homeDir), "sessions");
    const homeDir = path.join(tandemStateDir(options.homeDir));
    const rootStat = await safeStat(root);
    if (!rootStat) {
      yield { hits: [], scannedCount: 0, skippedCount: 0, done: true };
      return;
    }

    let scannedCount = 0;
    let skippedCount = 0;
    const candidates: SessionSearchHit[] = [];

    const hashDirs = await listHashDirs(root);
    for (const hashDir of hashDirs) {
      if (aborted()) break;
      const index = await readSessionIndex(hashDir);
      const files = await listSessionFiles(hashDir);
      const fileIds = new Set(files.map((file) => file.id));
      const indexIds = new Set(Object.keys(index));
      const allIds = new Set<string>([...fileIds, ...indexIds]);
      for (const id of allIds) {
        if (aborted()) break;
        const indexEntry = index[id];
        try {
          const scanned = await scanSessionFile(hashDir, id, indexEntry, signal, homeDir);
          scannedCount += 1;
          const { ranked, skipped } = rankScannedSessionsByMetadata([scanned], tokens, snippetContext);
          skippedCount += skipped;
          const hit = ranked[0];
          if (hit) candidates.push(hit);
        } catch {
          skippedCount += 1;
          continue;
        }
        if (scannedCount % batchSize === 0) {
          yield { hits: rankAndTrim(candidates, limit), scannedCount, skippedCount, done: false };
        }
      }
    }

    if (aborted()) {
      yield { hits: rankAndTrim(candidates, limit), scannedCount, skippedCount, done: true };
      return;
    }
    yield { hits: rankAndTrim(candidates, limit), scannedCount, skippedCount, done: true };
  }

  return generate();
}

export async function collectSearchSessions(
  options: SessionSearchOptions,
  signal?: AbortSignal
): Promise<SessionSearchBatch[]> {
  const stream = await searchSessionsStream(options, signal);
  const batches: SessionSearchBatch[] = [];
  for await (const batch of stream) {
    batches.push(batch);
    if (batch.done) break;
  }
  return batches;
}
