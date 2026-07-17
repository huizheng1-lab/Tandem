import { ModelEntry } from "../providers/registry.js";

export type CostRole = "leader" | "worker";

export interface CostTick {
  role: CostRole;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

export type CostTotals = Record<CostRole, CostTick>;

export class CostLedger {
  private ticks: CostTick[] = [];

  hydrate(totals: CostTotals): void {
    this.ticks = [
      { ...totals.leader, role: "leader" },
      { ...totals.worker, role: "worker" }
    ];
  }

  add(role: CostRole, model: ModelEntry, inputTokens: number, outputTokens: number): CostTick {
    const dollars =
      ((model.costHints?.inputPerMillion ?? 0) * inputTokens + (model.costHints?.outputPerMillion ?? 0) * outputTokens) / 1_000_000;
    const tick = { role, inputTokens, outputTokens, dollars };
    this.ticks.push(tick);
    return tick;
  }

  addDirectCost(role: CostRole, dollars: number, inputTokens: number, outputTokens: number): CostTick {
    const tick = {
      role,
      inputTokens,
      outputTokens,
      dollars: Number.isFinite(dollars) ? Math.max(0, dollars) : 0
    };
    this.ticks.push(tick);
    return tick;
  }

  totals(): CostTotals {
    const empty = (role: CostRole): CostTick => ({ role, inputTokens: 0, outputTokens: 0, dollars: 0 });
    const totals: Record<CostRole, CostTick> = { leader: empty("leader"), worker: empty("worker") };
    for (const tick of this.ticks) {
      totals[tick.role].inputTokens += tick.inputTokens;
      totals[tick.role].outputTokens += tick.outputTokens;
      totals[tick.role].dollars += tick.dollars;
    }
    return totals;
  }

  totalDollars(): number {
    const totals = this.totals();
    return totals.leader.dollars + totals.worker.dollars;
  }
}
