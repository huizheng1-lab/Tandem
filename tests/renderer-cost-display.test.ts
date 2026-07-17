import { describe, expect, it } from "vitest";
import { formatCumulativeCost, formatTotalCost } from "../app/renderer/src/cost-display.js";
import type { CostTotals, ModelListItem } from "../app/shared/ipc.js";
import { defaultConfig } from "../src/config/schema.js";

const totals: CostTotals = {
  leader: { role: "leader", inputTokens: 16_500_000, outputTokens: 112_000, dollars: 0 },
  worker: { role: "worker", inputTokens: 0, outputTokens: 0, dollars: 0 }
};

describe("renderer cost display", () => {
  it("shows tokens instead of a false zero when prices are unknown", () => {
    const models: ModelListItem[] = [{ id: "unknown/model", provider: "openai-compatible", modelName: "unknown", available: true }];
    expect(formatTotalCost(totals, { ...defaultConfig, leader: "unknown/model", worker: "unknown/model" }, models)).toBe("16.5M in / 112k out, price unknown");
  });

  it("shows dollars when the active models have cost hints", () => {
    const models: ModelListItem[] = [
      { id: "priced/model", provider: "openai-compatible", modelName: "priced", available: true, costHints: { inputPerMillion: 1, outputPerMillion: 2 } }
    ];
    expect(formatTotalCost({ ...totals, leader: { ...totals.leader, dollars: 3.25 } }, { ...defaultConfig, leader: "priced/model", worker: "priced/model" }, models)).toBe("$3.2500");
  });

  it("formats priced current-run and cumulative totals", () => {
    const models: ModelListItem[] = [
      { id: "priced/model", provider: "openai-compatible", modelName: "priced", available: true, costHints: { inputPerMillion: 1, outputPerMillion: 2 } }
    ];
    const cost: CostTotals = {
      leader: { role: "leader", inputTokens: 100, outputTokens: 20, dollars: 0.0012 },
      worker: { role: "worker", inputTokens: 50, outputTokens: 10, dollars: 0 },
      cumulative: {
        leader: { role: "leader", inputTokens: 10_000, outputTokens: 2_000, dollars: 1.2 },
        worker: { role: "worker", inputTokens: 500, outputTokens: 100, dollars: 0.0043 }
      }
    };

    expect(formatCumulativeCost(cost, { ...defaultConfig, leader: "priced/model", worker: "priced/model" }, models)).toBe("this run $0.0012 / total $1.2043");
  });

  it("uses token counts for current-run and cumulative totals when prices are unknown", () => {
    const models: ModelListItem[] = [{ id: "unknown/model", provider: "openai-compatible", modelName: "unknown", available: true }];
    const cost: CostTotals = {
      leader: { role: "leader", inputTokens: 1_500, outputTokens: 200, dollars: 0 },
      worker: { role: "worker", inputTokens: 0, outputTokens: 0, dollars: 0 },
      cumulative: totals
    };

    expect(formatCumulativeCost(cost, { ...defaultConfig, leader: "unknown/model", worker: "unknown/model" }, models)).toBe(
      "this run 1.5k in / 200 out, price unknown / total 16.5M in / 112k out, price unknown"
    );
  });

  it("formats zero cumulative usage", () => {
    const zero: CostTotals = {
      leader: { role: "leader", inputTokens: 0, outputTokens: 0, dollars: 0 },
      worker: { role: "worker", inputTokens: 0, outputTokens: 0, dollars: 0 },
      cumulative: {
        leader: { role: "leader", inputTokens: 0, outputTokens: 0, dollars: 0 },
        worker: { role: "worker", inputTokens: 0, outputTokens: 0, dollars: 0 }
      }
    };

    expect(formatCumulativeCost(zero, defaultConfig, [])).toBe("this run $0.0000 / total $0.0000");
  });
});
