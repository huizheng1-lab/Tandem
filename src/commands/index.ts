import { TandemConfig } from "../config/schema.js";
import { saveProjectConfig } from "../config/load.js";
import { CostLedger } from "../session/cost.js";
import { listSessions } from "../session/store.js";
import { modelCommandUsage } from "../providers/cli-models.js";
import { listModels, setCliModelConfig, setModel } from "./model.js";
import { costText, helpText, statusText } from "./misc.js";
import { addSchedule, listSchedules, removeSchedule } from "./schedule.js";

function formatSessionList(sessions: Awaited<ReturnType<typeof listSessions>>): string {
  return sessions.map((session) => `${session.id} ${session.archived ? "[archived] " : ""}${session.title}`).join("\n") || "No sessions yet.";
}

export interface CommandContext {
  config: TandemConfig;
  env: NodeJS.ProcessEnv;
  cwd: string;
  ledger: CostLedger;
  sessionId?: string;
  setConfig?: (config: TandemConfig) => void;
}

function splitCommand(input: string): string[] {
  const matches = input.match(/"[^"]*"|\S+/g) ?? [];
  return matches.map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part));
}

export async function dispatchCommand(input: string, ctx: CommandContext): Promise<string | undefined> {
  if (!input.startsWith("/")) return undefined;
  const [command, ...args] = splitCommand(input);
  switch (command) {
    case "/help":
      return helpText;
    case "/models":
      return listModels(ctx.config, ctx.env);
    case "/model": {
      const role = args[0];
      const id = args[1];
      if (role === "claude-cli" || role === "codex-cli" || role === "codex-effort") {
        const result = await setCliModelConfig(ctx.config, role, id, ctx.cwd);
        if (result.config) ctx.setConfig?.(result.config);
        return result.message;
      }
      if ((role !== "leader" && role !== "worker") || !id) return `leader: ${ctx.config.leader}\nworker: ${ctx.config.worker}\n${modelCommandUsage}`;
      const next = await setModel(ctx.config, role, id, ctx.cwd);
      ctx.setConfig?.(next);
      return `Set ${role} model to ${id}.`;
    }
    case "/rounds": {
      const rounds = Number(args[0]);
      if (!Number.isInteger(rounds) || rounds < 0) return "Usage: /rounds <n>";
      const next = { ...ctx.config, maxReviewRounds: rounds };
      await saveProjectConfig(next, ctx.cwd);
      ctx.setConfig?.(next);
      return `Set maxReviewRounds to ${rounds}.`;
    }
    case "/status":
      return statusText(ctx.config, "IDLE", 0, ctx.sessionId ?? "new");
    case "/cost":
      return costText(ctx.ledger);
    case "/goal":
      // /goal is handled directly by the interactive surfaces (src/tui/App.tsx, the desktop
      // app) because the run-outcome ("record + start pipeline") needs the pipeline runner
      // handle that's only available inside those render loops. Returning undefined here lets
      // the caller's `commandResult !== undefined` fall-through take the TUI into its run path
      // (and, for non-TTY script callers like src/index.ts, falls through to the "Use a TTY"
      // notice).
      return undefined;
    case "/sessions":
      return formatSessionList(await listSessions(ctx.cwd));
    case "/resume":
      return args[0] ? `Resume requested for ${args[0]}.` : "Usage: /resume <id>";
    case "/clear":
      return "Started a new session.";
    case "/takeover":
      return "Leader takeover requested.";
    case "/schedule": {
      if (args[0] === "list") {
        const schedules = await listSchedules(ctx.cwd);
        return schedules.map((item) => `${item.id} ${item.cron} ${item.prompt}`).join("\n") || "No schedules.";
      }
      if (args[0] === "rm" && args[1]) {
        await removeSchedule(args[1], ctx.cwd);
        return `Removed schedule ${args[1]}.`;
      }
      if (args.length >= 2) {
        const schedule = await addSchedule(args[0] ?? "", args.slice(1).join(" "), ctx.cwd);
        return `Added schedule ${schedule.id}. Schedules run only while Tandem is open.`;
      }
      return 'Usage: /schedule "<cron>" <prompt>';
    }
    default:
      return `Unknown command ${command}. Run /help.`;
  }
}
