import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { compactSessionHistory, compactionSource, isCliBackedLeader } from "../src/session/compaction.js";
import { CostLedger } from "../src/session/cost.js";
import type { SessionEvent } from "../src/session/store.js";

function event(type: string, payload: unknown): SessionEvent {
  return { type, payload, at: "2026-01-01T00:00:00.000Z" };
}

function turn(prompt: string, summary: string): SessionEvent[] {
  return [event("user", { prompt }), event("done", { summary })];
}

describe("session compaction", () => {
  it("detects CLI-backed leaders after configured model pins", () => {
    expect(isCliBackedLeader({ ...defaultConfig, leader: "codex/cli", codexCliModel: "gpt-5" })).toBe(true);
    expect(isCliBackedLeader({ ...defaultConfig, leader: "claude-code/cli", claudeCliModel: "sonnet" })).toBe(true);
    expect(isCliBackedLeader({ ...defaultConfig, leader: "minimax/minimax-m3" })).toBe(false);
  });

  it("builds a compaction source only when history exceeds the leader budget unless forced", () => {
    const config = { ...defaultConfig, leaderContextBudgetTokens: 1000 };
    const events = [...turn("short prompt", "short outcome")];

    expect(compactionSource(events, config, false)).toBeUndefined();
    expect(compactionSource(events, config, true)?.text).toContain("short prompt");
  });

  it("returns a persisted memory compaction payload for oversized CLI history", async () => {
    const config = { ...defaultConfig, leader: "codex/cli", leaderContextBudgetTokens: 12 };
    const events = Array.from({ length: 4 }, (_, index) => turn(`prompt ${index + 1} ${"x".repeat(30)}`, `summary ${index + 1}`)).flat();

    const result = await compactSessionHistory({
      events,
      config,
      cwd: process.cwd(),
      env: {},
      ledger: new CostLedger(),
      summarizer: (source) => {
        expect(source.truncated).toBe(true);
        expect(source.text).toContain("prompt 4");
        return "Earlier prompts were summarized.";
      }
    });

    expect(result).toEqual({ summary: "Earlier prompts were summarized.", compactedTurns: 4 });
  });
});
