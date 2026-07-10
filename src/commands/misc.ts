import { TandemConfig } from "../config/schema.js";
import { modelDisplayName } from "../providers/cli-models.js";
import { CostLedger } from "../session/cost.js";

export const helpText = `Commands:
/help                         show this help
/models                       list model ids and key status
/model                        open TUI model picker; non-TTY shows current models
/model leader <id>            set leader model
/model worker <id>            set worker model
/model claude-cli <model|clear> set Claude Code CLI --model pin
/model codex-cli <model|clear> set Codex CLI --model pin
/model codex-effort <level|clear> set Codex reasoning effort
/rounds <n>                   set max review rounds
/status                       show phase, round, models, session
/cost                         show token and dollar totals
/takeover                     request leader takeover
/goal <text>                  record AND start work on the text now
/goal add <text>              add a standing goal (does not run)
/goal list                    list standing goals
/goal done <n>                mark a goal done (kept in list)
/goal clear                   delete every goal (distinct from done)
/loop <interval> <prompt>     run a prompt repeatedly, e.g. 30s, 5m, 2h
/loop stop                    stop the active loop
/schedule "<cron>" <prompt>   add a schedule while Tandem is open
/schedule list                list schedules
/schedule rm <id>             remove a schedule
/sessions                     list saved sessions
/resume <id>                  resume a saved session
/clear                        start a new session`;

export function statusText(config: TandemConfig, phase = "IDLE", round = 0, sessionId = "new"): string {
  return `phase: ${phase}\nround: ${round}/${config.maxReviewRounds}\nleader: ${modelDisplayName(config.leader, config)}\nworker: ${modelDisplayName(config.worker, config)}\nparallel: ${config.maxParallelWorkers} worker(s) per round\nsession: ${sessionId}`;
}

export function costText(ledger: CostLedger): string {
  const totals = ledger.totals();
  return [
    `leader: ${totals.leader.inputTokens} in / ${totals.leader.outputTokens} out / $${totals.leader.dollars.toFixed(4)}`,
    `worker: ${totals.worker.inputTokens} in / ${totals.worker.outputTokens} out / $${totals.worker.dollars.toFixed(4)}`,
    `total: $${ledger.totalDollars().toFixed(4)}`
  ].join("\n");
}
