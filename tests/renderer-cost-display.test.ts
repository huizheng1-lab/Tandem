import { describe, expect, it } from "vitest";
import { formatTotalCost } from "../app/renderer/src/cost-display.js";
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
});
