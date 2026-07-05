import { TandemConfig } from "../config/schema.js";
import { CostLedger } from "../session/cost.js";

export const helpText = `/help
/models
/model
/model leader <id>
/model worker <id>
/rounds <n>
/status
/cost
/takeover
/goal add <text>
/goal list
/goal done <n>
/loop <interval> <prompt>
/loop stop
/schedule "<cron>" <prompt>
/schedule list
/schedule rm <id>
/sessions
/resume <id>
/clear`;

export function statusText(config: TandemConfig, phase = "IDLE", round = 0, sessionId = "new"): string {
  return `phase: ${phase}\nround: ${round}/${config.maxReviewRounds}\nleader: ${config.leader}\nworker: ${config.worker}\nsession: ${sessionId}`;
}

export function costText(ledger: CostLedger): string {
  const totals = ledger.totals();
  return [
    `leader: ${totals.leader.inputTokens} in / ${totals.leader.outputTokens} out / $${totals.leader.dollars.toFixed(4)}`,
    `worker: ${totals.worker.inputTokens} in / ${totals.worker.outputTokens} out / $${totals.worker.dollars.toFixed(4)}`,
    `total: $${ledger.totalDollars().toFixed(4)}`
  ].join("\n");
}
