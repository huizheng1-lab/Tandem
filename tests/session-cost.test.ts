import { describe, expect, it } from "vitest";
import { CostLedger, type CostTotals } from "../src/session/cost.js";
import type { ModelEntry } from "../src/providers/registry.js";

const baseline: CostTotals = {
  leader: { role: "leader", inputTokens: 100, outputTokens: 20, dollars: 0.5 },
  worker: { role: "worker", inputTokens: 50, outputTokens: 10, dollars: 0.25 }
};

describe("CostLedger.hydrate", () => {
  it("round-trips persisted totals", () => {
    const ledger = new CostLedger();
    ledger.hydrate(baseline);

    expect(ledger.totals()).toEqual(baseline);
    expect(ledger.totalDollars()).toBe(0.75);
  });

  it("accumulates new ticks on top of the baseline", () => {
    const ledger = new CostLedger();
    ledger.hydrate(baseline);
    ledger.add("leader", { costHints: { inputPerMillion: 1, outputPerMillion: 2 } } as ModelEntry, 10, 5);
    ledger.addDirectCost("worker", 0.1, 4, 2);

    expect(ledger.totals()).toEqual({
      leader: { role: "leader", inputTokens: 110, outputTokens: 25, dollars: 0.50002 },
      worker: { role: "worker", inputTokens: 54, outputTokens: 12, dollars: 0.35 }
    });
  });
});
