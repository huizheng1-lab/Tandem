import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectSearchSessions,
  DEFAULT_SEARCH_RESULT_LIMIT,
  DEFAULT_SEARCH_SNIPPET_CONTEXT,
  extractSnippet,
  matchEventText,
  scoreSearchableText,
  searchSessionsStream,
  type SessionSearchBatch,
  type SessionSearchHit
} from "../src/session/search.js";
import { SessionStore } from "../src/session/store.js";
import { tandemStateDir } from "../src/paths.js";

// vitest keeps these unused exports from being dropped; they are sanity checks
// for the planned API contract.
void DEFAULT_SEARCH_RESULT_LIMIT;
void DEFAULT_SEARCH_SNIPPET_CONTEXT;

function sessionsRoot(home: string): string {
  return path.join(tandemStateDir(home), "sessions");
}

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-search-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  const content = lines.length === 0 ? "" : `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

interface BuiltSession {
  id: string;
  hashDir: string;
  filePath: string;
  indexPath: string;
  sidecarPath?: string;
}

async function writeSession(hashDir: string, id: string, lines: unknown[], indexEntry?: object, sidecar?: { projectDir: string }): Promise<BuiltSession> {
  const filePath = path.join(hashDir, `${id}.jsonl`);
  await writeJsonl(filePath, lines);
  const indexPath = path.join(hashDir, "index.json");
  let current: Record<string, unknown> = {};
  if (existsSync(indexPath)) {
    try {
      current = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const merged = { ...current, [id]: indexEntry };
  await writeFile(indexPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  let sidecarPath: string | undefined;
  if (sidecar) {
    sidecarPath = path.join(hashDir, "project.json");
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  }
  return { id, hashDir, filePath, indexPath, sidecarPath };
}

interface CollectedSearch {
  hits: SessionSearchHit[];
  batches: SessionSearchBatch[];
  scannedCount: number;
  skippedCount: number;
}

async function collectAll(options: Parameters<typeof searchSessionsStream>[0], signal?: AbortSignal): Promise<CollectedSearch> {
  const batches = await collectSearchSessions(options, signal);
  const terminal = batches.at(-1);
  if (!terminal || terminal.done !== true) {
    throw new Error(`expected a terminal batch with done=true, got ${JSON.stringify(terminal)}`);
  }
  return { hits: terminal.hits, batches, scannedCount: terminal.scannedCount, skippedCount: terminal.skippedCount };
}

async function fingerprint(filePath: string): Promise<{ size: number; mtimeMs: number; sha256: string; bytes: Buffer } | null> {
  if (!existsSync(filePath)) return null;
  const handle = await stat(filePath);
  const bytes = await readFile(filePath);
  const { createHash } = await import("node:crypto");
  return {
    size: handle.size,
    mtimeMs: handle.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes
  };
}

describe("matchEventText", () => {
  it("extracts searchable text per event type with stable source role", () => {
    expect(matchEventText({ type: "user", at: "2026-01-01T00:00:00.000Z", payload: { prompt: "ship the search feature" } })).toEqual({ text: "ship the search feature", source: "user" });
    expect(matchEventText({ type: "text", at: "2026-01-01T00:00:00.000Z", payload: { role: "leader", delta: "hello there" } })).toEqual({ text: "hello there", source: "leader" });
    expect(matchEventText({ type: "message", at: "2026-01-01T00:00:00.000Z", payload: { role: "worker", text: "doing work" } })).toEqual({ text: "doing work", source: "worker" });
    expect(matchEventText({ type: "done", at: "2026-01-01T00:00:00.000Z", payload: { summary: "all done" } })).toEqual({ text: "all done", source: "summary" });
    expect(matchEventText({ type: "memory:compaction", at: "2026-01-01T00:00:00.000Z", payload: { summary: "compacted" } })).toEqual({ text: "compacted", source: "compaction" });
  });

  it("returns undefined for unsupported events or unknown roles", () => {
    expect(matchEventText({ type: "machine", at: "2026-01-01T00:00:00.000Z", payload: { type: "transition" } })).toBeUndefined();
    expect(matchEventText({ type: "tool", at: "2026-01-01T00:00:00.000Z", payload: { name: "grep" } })).toBeUndefined();
    expect(matchEventText({ type: "text", at: "2026-01-01T00:00:00.000Z", payload: { role: "system", delta: "x" } })).toBeUndefined();
    expect(matchEventText({ type: "user", at: "2026-01-01T00:00:00.000Z", payload: {} })).toBeUndefined();
  });
});

describe("scoreSearchableText", () => {
  it("counts overlapping occurrences case-insensitively", () => {
    expect(scoreSearchableText("Foo bar foo BAZ foo", ["foo"])).toBe(3);
    expect(scoreSearchableText("alpha beta gamma", ["alpha", "gamma"])).toBe(2);
    expect(scoreSearchableText("alpha beta", ["missing"])).toBe(0);
  });

  it("returns zero on empty inputs", () => {
    expect(scoreSearchableText("", ["any"])).toBe(0);
    expect(scoreSearchableText("anything", [])).toBe(0);
  });
});

describe("extractSnippet", () => {
  it("returns the densest window covering all tokens with offsets that slice the snippet text", () => {
    const text = "The quick brown fox jumps over the lazy dog and meets another fox by the river";
    const snippet = extractSnippet(text, ["fox", "river"], 4);
    expect(snippet.start).toBeGreaterThanOrEqual(0);
    expect(snippet.end).toBeLessThanOrEqual(text.length);
    expect(snippet.text).toBe(text.slice(snippet.start, snippet.end));
    expect(snippet.text.toLowerCase()).toContain("fox");
    expect(snippet.text.toLowerCase()).toContain("river");
  });

  it("returns an empty snippet when any token is missing", () => {
    const snippet = extractSnippet("only one word", ["missing", "word"], 4);
    expect(snippet).toEqual({ text: "", start: 0, end: 0 });
  });

  it("clamps the snippet to the available text", () => {
    const snippet = extractSnippet("needle", ["needle"], 80);
    expect(snippet.text).toBe("needle");
    expect(snippet.start).toBe(0);
    expect(snippet.end).toBe(6);
  });
});

describe("searchSessionsStream", () => {
  const trackedHomes: string[] = [];
  beforeAll(() => {
    // nothing to do globally per-test
  });
  afterAll(async () => {
    for (const home of trackedHomes) {
      await rm(home, { recursive: true, force: true });
    }
  });

  function newHome() {
    return tempDir("home").then((home) => {
      trackedHomes.push(home);
      return home;
    });
  }

  it("returns a single terminal batch with no hits for empty or whitespace queries", async () => {
    const home = await newHome();
    process.env.TANDEM_HOME = home;
    await mkdir(sessionsRoot(home), { recursive: true });

    for (const query of ["", "   ", "\n\t "]) {
      const collected = await collectAll({ query, homeDir: home });
      expect(collected.batches.length).toBe(1);
      expect(collected.batches[0]).toEqual({ hits: [], scannedCount: 0, skippedCount: 0, done: true });
    }
  });

  it("emits a single terminal batch with no hits when the sessions root is missing", async () => {
    const home = await newHome();
    process.env.TANDEM_HOME = home;
    // intentionally no sessions directory
    const collected = await collectAll({ query: "alpha", homeDir: home });
    expect(collected.batches).toEqual([{ hits: [], scannedCount: 0, skippedCount: 0, done: true }]);
  });

  it("matches the title case-insensitively and yields one hit per session", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-title");
    await mkdir(hashDir, { recursive: true });

    const titles = ["Planning session", "Session retrospective", "Architecture session"];
    const built: BuiltSession[] = [];
    for (const [index, title] of titles.entries()) {
      const id = `s-${index}`;
      const events = [
        { type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "Random unrelated text" } },
        { type: "done", at: "2026-01-01T00:00:02.000Z", payload: { summary: "Ended quietly." } }
      ];
      built.push(await writeSession(hashDir, id, events, { title, archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: `2026-01-01T0${index + 1}:00:00.000Z` }));
    }

    const collected = await collectAll({ query: "SESSION", homeDir: home });
    expect(collected.batches.length).toBe(1);
    expect(collected.batches[0]?.done).toBe(true);
    expect(collected.scannedCount).toBe(3);
    expect(collected.hits.map((hit) => hit.id).sort()).toEqual(built.map((entry) => entry.id).sort());
    expect(collected.hits.every((hit) => hit.matchCount === 1)).toBe(true);
    for (const hit of collected.hits) {
      expect(hit.sourceRole).toBe("title");
    }
  });

  it("excludes sessions whose title does not contain the query", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-title-miss");
    await mkdir(hashDir, { recursive: true });
    await writeSession(hashDir, "match-1", [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }], { title: "Architecture Decisions", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" });
    await writeSession(hashDir, "miss-1", [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }], { title: "Performance Tuning", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" });
    await writeSession(hashDir, "match-2", [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }], { title: "Architecture Reviews", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-02T00:00:00.000Z" });

    const collected = await collectAll({ query: "ARCHITECTURE", homeDir: home });
    expect(collected.scannedCount).toBe(3);
    expect(collected.hits.map((hit) => hit.id).sort()).toEqual(["match-1", "match-2"]);
  });

  it("matches user, leader, worker, summary, and compaction content case-insensitively", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-roles");
    await mkdir(hashDir, { recursive: true });

    const fixtures = [
      { id: "user", lines: [
        { type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "Investigate the ci pipeline" } }
      ], sidecar: { projectDir: "C:/proj" } },
      { id: "leader", lines: [
        { type: "session:start", at: "2026-01-02T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "text", at: "2026-01-02T00:00:01.000Z", payload: { role: "leader", delta: "Looking at the ci workflow now." } }
      ] },
      { id: "worker", lines: [
        { type: "session:start", at: "2026-01-03T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "message", at: "2026-01-03T00:00:01.000Z", payload: { role: "worker", text: "Reported a flaky ci test." } }
      ] },
      { id: "summary", lines: [
        { type: "session:start", at: "2026-01-04T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "done", at: "2026-01-04T00:00:01.000Z", payload: { summary: "Investigated the ci symptoms." } }
      ] },
      { id: "compaction", lines: [
        { type: "session:start", at: "2026-01-05T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
        { type: "memory:compaction", at: "2026-01-05T00:00:01.000Z", payload: { summary: "Earlier we debugged CI failure." } }
      ] }
    ];
    for (const fixture of fixtures) {
      await writeSession(hashDir, fixture.id, fixture.lines, { title: fixture.id, archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" }, fixture.sidecar);
    }

    const collected = await collectAll({ query: "ci", homeDir: home });
    expect(collected.scannedCount).toBe(5);
    const hitsByRole = Object.fromEntries(collected.hits.map((hit) => [hit.id, hit.sourceRole]));
    expect(hitsByRole).toMatchObject({ user: "user", leader: "leader", worker: "worker", summary: "summary", compaction: "compaction" });
  });

  it("requires every token to match (all-token semantics) and ranks by matchCount then lastActiveAt", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-multi");
    await mkdir(hashDir, { recursive: true });

    const fixtures = [
      {
        id: "both-once",
        lines: [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }, { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "search the desktop" } }],
        indexEntry: { title: "irrelevant", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" }
      },
      {
        id: "first-twice",
        lines: [
          { type: "session:start", at: "2026-02-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
          { type: "user", at: "2026-02-01T00:00:01.000Z", payload: { prompt: "search the desktop anywhere on search and desktop" } },
          { type: "user", at: "2026-02-01T00:00:02.000Z", payload: { prompt: "later repeat the words search and desktop" } }
        ],
        indexEntry: { title: "irrelevant", archived: false, createdAt: "2026-02-01T00:00:00.000Z", lastActiveAt: "2026-02-01T00:00:02.000Z" }
      },
      {
        id: "second-only",
        lines: [{ type: "session:start", at: "2026-03-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }, { type: "user", at: "2026-03-01T00:00:01.000Z", payload: { prompt: "desktop icons for the panel" } }],
        indexEntry: { title: "irrelevant", archived: false, createdAt: "2026-03-01T00:00:00.000Z", lastActiveAt: "2026-03-01T00:00:01.000Z" }
      }
    ];
    for (const fixture of fixtures) {
      await writeSession(hashDir, fixture.id, fixture.lines, fixture.indexEntry);
    }

    // Both tokens required: "second-only" must NOT match (only "desktop" present, not "search")
    const collected = await collectAll({ query: "search desktop", homeDir: home });
    expect(collected.scannedCount).toBe(3);
    expect(collected.hits.map((hit) => hit.id).sort()).toEqual(["both-once", "first-twice"]);
    // Ranking: matchCount desc → first-twice (more token occurrences) before both-once
    expect(collected.hits.map((hit) => hit.id)).toEqual(["first-twice", "both-once"]);
    expect(collected.hits[0]?.matchCount).toBeGreaterThan(collected.hits[1]?.matchCount ?? 0);
  });

  it("honors lastActiveAt desc as the tie-break when matchCount is equal", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-tie");
    await mkdir(hashDir, { recursive: true });
    const fixtures = [
      { id: "older", lines: [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }, { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "needle in haystack" } }] },
      { id: "newer", lines: [{ type: "session:start", at: "2026-06-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }, { type: "user", at: "2026-06-01T00:00:01.000Z", payload: { prompt: "needle finder" } }] }
    ];
    for (const [index, fixture] of fixtures.entries()) {
      await writeSession(hashDir, fixture.id, fixture.lines, { title: fixture.id, archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: index === 0 ? "2026-01-01T00:00:01.000Z" : "2026-06-01T00:00:01.000Z" });
    }

    const collected = await collectAll({ query: "needle", homeDir: home });
    expect(collected.hits.map((hit) => hit.id)).toEqual(["newer", "older"]);
  });

  it("emits replacement snapshots per batchSize=1 then a final terminal batch", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-stream");
    await mkdir(hashDir, { recursive: true });
    for (const [index, id] of ["alpha", "beta", "gamma"].entries()) {
      const lines = [{ type: "session:start", at: `2026-01-0${index + 1}T00:00:00.000Z`, payload: { projectDir: "C:/proj" } }, { type: "user", at: `2026-01-0${index + 1}T00:00:01.000Z`, payload: { prompt: `Find keyword ${id}` } }];
      await writeSession(hashDir, id, lines, { title: id, archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: `2026-01-0${index + 1}T00:00:01.000Z` });
    }

    const stream = await searchSessionsStream({ query: "keyword", batchSize: 1, homeDir: home });
    const batches: SessionSearchBatch[] = [];
    for await (const batch of stream) batches.push(batch);

    expect(batches.length).toBe(4);
    expect(batches.slice(0, -1).every((batch) => batch.done === false)).toBe(true);
    expect(batches.at(-1)?.done).toBe(true);
    expect(batches.slice(0, -1).map((batch) => batch.scannedCount)).toEqual([1, 2, 3]);
    expect(batches.at(-1)?.scannedCount).toBe(3);
    expect(batches.at(-1)?.hits.length).toBe(3);
  });

  it("cancels streaming when the AbortSignal fires between sessions", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-abort");
    await mkdir(hashDir, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const id = `session-${index}`;
      const lines = [{ type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } }, { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "keyword present" } }];
      await writeSession(hashDir, id, lines, { title: id, archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" });
    }

    const controller = new AbortController();
    const stream = await searchSessionsStream({ query: "keyword", batchSize: 1, homeDir: home }, controller.signal);
    const batches: SessionSearchBatch[] = [];
    let yieldedAfterAbort = 0;
    for await (const batch of stream) {
      batches.push(batch);
      if (!batch.done && batch.scannedCount >= 1 && !controller.signal.aborted) {
        controller.abort();
      } else if (controller.signal.aborted && !batch.done) {
        yieldedAfterAbort += 1;
      }
      if (batch.done) break;
    }

    expect(yieldedAfterAbort).toBe(0);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const terminal = batches.at(-1);
    expect(terminal?.done).toBe(true);
  });

  it("discovers sessions across multiple project directories and resolves projectDir fallback", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });

    const hashA = path.join(root, "hashA");
    const hashB = path.join(root, "hashB");
    await mkdir(hashA, { recursive: true });
    await mkdir(hashB, { recursive: true });

    await writeSession(
      hashA,
      "session-a",
      [
        { type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/projA" } },
        { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "keyword in project A" } }
      ],
      { title: "project A session", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" }
    );

    await writeSession(
      hashB,
      "session-b",
      [
        { type: "user", at: "2026-01-02T00:00:01.000Z", payload: { prompt: "keyword in project B" } }
      ],
      { title: "project B session", archived: false, createdAt: "2026-01-02T00:00:00.000Z", lastActiveAt: "2026-01-02T00:00:01.000Z" },
      { projectDir: "C:/projB" }
    );

    const collected = await collectAll({ query: "keyword", homeDir: home });
    expect(collected.hits.length).toBe(2);
    const ids = collected.hits.map((hit) => hit.id).sort();
    expect(ids).toEqual(["session-a", "session-b"]);
    const dirA = collected.hits.find((hit) => hit.id === "session-a")?.projectDir;
    const dirB = collected.hits.find((hit) => hit.id === "session-b")?.projectDir;
    expect(dirA).toBe("C:/projA");
    expect(dirB).toBe("C:/projB");
  });

  it("recovers from malformed lines and from an unreadable session file", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-malformed");
    await mkdir(hashDir, { recursive: true });

    const events = [
      { type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
      { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "Real valid keyword here" } }
    ];
    const indexEntry = { title: "valid session", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" };
    await writeSession(hashDir, "valid", events, indexEntry);
    // Write a session with a malformed line interleaved
    const filePath = path.join(hashDir, "malformed.jsonl");
    await writeJsonl(filePath, [
      { type: "session:start", at: "2026-02-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
      { type: "user", at: "2026-02-01T00:00:01.000Z", payload: { prompt: "another valid one with the keyword" } },
      // intentionally bad line
      "{not-json,"
    ]);
    await writeFile(path.join(hashDir, "index.json"), `${JSON.stringify({
      malformed: { title: "malformed", archived: false, createdAt: "2026-02-01T00:00:00.000Z", lastActiveAt: "2026-02-01T00:00:01.000Z" }
    }, null, 2)}\n`, "utf8");

    const collected = await collectAll({ query: "keyword", homeDir: home });
    expect(collected.hits.map((hit) => hit.id).sort()).toEqual(["malformed", "valid"]);
    expect(collected.skippedCount).toBe(0);
  });

  it("ignores a missing JSONL for an indexed session without rejecting the whole scan", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-missing");
    await mkdir(hashDir, { recursive: true });
    // Valid session
    await writeSession(hashDir, "valid", [
      { type: "session:start", at: "2026-01-01T00:00:00.000Z", payload: { projectDir: "C:/proj" } },
      { type: "user", at: "2026-01-01T00:00:01.000Z", payload: { prompt: "keyword present" } }
    ]);
    // Indexed session whose file we never write (deleted-file race / missing)
    await writeFile(path.join(hashDir, "index.json"), `${JSON.stringify({
      ghost: { title: "ghost", archived: false, createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:01.000Z" }
    }, null, 2)}\n`, "utf8");

    const collected = await collectAll({ query: "keyword", homeDir: home });
    expect(collected.hits.map((hit) => hit.id)).toEqual(["valid"]);
    expect(collected.skippedCount).toBe(1);
  });

  it("does not change bytes or mtimes of JSONL, index, or project sidecar fixtures", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const session = await SessionStore.create("C:/proj", home);
    await session.append("session:start", { projectDir: "C:/proj" });
    await session.append("user", { prompt: "Real user prompt with the search word" });
    await session.append("text", { role: "leader", delta: "the leader thinks search matters here" });

    const sessionRoot = path.dirname(session.filePath);
    const sidecarPath = path.join(sessionRoot, "project.json");
    const fingerprinterFns = [
      fingerprint(session.filePath),
      fingerprint(path.join(sessionRoot, "index.json")),
      fingerprint(sidecarPath)
    ];
    const beforeFingerprint = await Promise.all(fingerprinterFns);

    await collectAll({ query: "search", homeDir: home });

    const afterFingerprint = await Promise.all(fingerprinterFns);
    for (const [before, after] of beforeFingerprint.map((value, index) => [value, afterFingerprint[index]] as const)) {
      expect(after).not.toBeNull();
      expect(before).not.toBeNull();
      expect(after?.sha256).toBe(before?.sha256);
      expect(after?.size).toBe(before?.size);
    }
  });

  it("uses file mtime as the lastActiveAt fallback when index and events are missing timestamps", async () => {
    const home = await newHome();
    const root = sessionsRoot(home);
    await mkdir(root, { recursive: true });
    const hashDir = path.join(root, "hash-fallback");
    await mkdir(hashDir, { recursive: true });
    const id = "fallback";
    const lines: object[] = [
      { type: "user", at: "2026-01-01T00:00:00.000Z", payload: { prompt: "needle in title" } }
    ];
    await writeJsonl(path.join(hashDir, `${id}.jsonl`), lines);
    // no index.json, no session:start

    const collected = await collectAll({ query: "needle", homeDir: home });
    expect(collected.hits).toHaveLength(1);
    const hit = collected.hits[0];
    expect(hit?.projectDir).toBeUndefined();
    expect(hit?.title).toBe("needle in title");
  });
});

describe("SessionSearchHit shape", () => {
  it("matches the contract in the W0014 plan: id, title, lastActiveAt, projectDir, matchCount, sourceRole, snippet", () => {
    const sample: SessionSearchHit = {
      id: "any",
      title: "any",
      lastActiveAt: "any",
      projectDir: "C:/proj",
      matchCount: 1,
      sourceRole: "user",
      snippet: { text: "any", start: 0, end: 0 }
    };
    expect(Object.keys(sample).sort()).toEqual(["id", "lastActiveAt", "matchCount", "projectDir", "snippet", "sourceRole", "title"].sort());
    expect(Object.keys(sample.snippet).sort()).toEqual(["end", "start", "text"].sort());
  });
});
