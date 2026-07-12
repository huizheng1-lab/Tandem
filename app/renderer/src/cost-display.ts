import type { CostTotals, ModelListItem } from "../../shared/ipc.js";
import type { TandemConfig } from "../../../src/config/schema.js";

function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(value);
}

export function formatTotalCost(cost: CostTotals | undefined, config: TandemConfig | undefined, models: ModelListItem[]): string {
  if (!cost) return "$0.0000";
  const totalDollars = cost.leader.dollars + cost.worker.dollars;
  const totalInput = cost.leader.inputTokens + cost.worker.inputTokens;
  const totalOutput = cost.leader.outputTokens + cost.worker.outputTokens;
  const hasTokens = totalInput + totalOutput > 0;
  const byId = new Map(models.map((model) => [model.id, model]));
  const leaderUnknown = config?.leader ? byId.get(config.leader)?.costHints === undefined : false;
  const workerUnknown = config?.worker ? byId.get(config.worker)?.costHints === undefined : false;
  if (hasTokens && totalDollars === 0 && (leaderUnknown || workerUnknown)) {
    return `${shortTokens(totalInput)} in / ${shortTokens(totalOutput)} out, price unknown`;
  }
  return `$${totalDollars.toFixed(4)}`;
}
