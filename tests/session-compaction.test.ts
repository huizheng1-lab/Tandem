import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import {
  MIN_LEADER_CONTEXT_BUDGET_TOKENS,
  compactSessionHistory,
  compactionSource,
  effectiveLeaderContextBudgetTokens,
  isCliBackedLeader,
  leaderContextBudgetChars
} from "../src/session/compaction.js";
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

  it("clamps pathologically low leader context budgets at the point of use", () => {
    const lowConfig = { ...defaultConfig, leaderContextBudgetTokens: 50 };
    const defaultConfigBudget = { ...defaultConfig, leaderContextBudgetTokens: 60000 };

    expect(effectiveLeaderContextBudgetTokens(lowConfig)).toBe(MIN_LEADER_CONTEXT_BUDGET_TOKENS);
    expect(leaderContextBudgetChars(lowConfig)).toBe(MIN_LEADER_CONTEXT_BUDGET_TOKENS * 4);
    expect(effectiveLeaderContextBudgetTokens(defaultConfigBudget)).toBe(60000);
    expect(leaderContextBudgetChars(defaultConfigBudget)).toBe(60000 * 4);
  });

  it("does not compact ordinary multi-turn history when the configured budget is absurdly low", () => {
    const config = { ...defaultConfig, leaderContextBudgetTokens: 50 };
    const events = Array.from({ length: 6 }, (_, index) => turn(`prompt ${index + 1} ${"x".repeat(120)}`, `summary ${index + 1} ${"y".repeat(120)}`)).flat();

    expect(compactionSource(events, config, false)).toBeUndefined();
  });

  it("returns a persisted memory compaction payload for oversized CLI history", async () => {
    const config = { ...defaultConfig, leader: "codex/cli", leaderContextBudgetTokens: 12 };
    const events = Array.from({ length: 18 }, (_, index) => turn(`prompt ${index + 1} ${"x".repeat(300)}`, `summary ${index + 1} ${"y".repeat(300)}`)).flat();

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

    expect(result).toEqual({ summary: "Earlier prompts were summarized.", compactedTurns: 18 });
  });
});
