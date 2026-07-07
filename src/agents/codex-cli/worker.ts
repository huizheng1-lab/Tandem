import type { TandemConfig } from "../../config/schema.js";
import type { BuildPlan, CompletionReport, ReviewFeedback } from "../../orchestrator/artifacts.js";
import { validateCompletionReport } from "../../orchestrator/artifacts.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger } from "../../session/cost.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { assertSafeProjectDir } from "../../tools/protection.js";
import { buildWorkerContext } from "../live.js";
import { runCodexExec } from "./exec.js";

export interface CodexWorkerOptions {
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entry: ModelEntry;
  ledger: CostLedger;
  abortSignal?: AbortSignal;
  onWorkerText?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
  confirmCodexWrite?: (role: "leader" | "worker", message: string) => Promise<boolean>;
}

export async function runCodexWorkerBuild(
  options: CodexWorkerOptions,
  input: { plan: BuildPlan; round: number; feedback: ReviewFeedback; previousReport?: CompletionReport }
): Promise<CompletionReport> {
  assertSafeProjectDir(options.cwd);
  if (options.config.permissionMode === "ask") {
    const approved = await options.confirmCodexWrite?.("worker", "Run this round via Codex CLI with write access? Codex cannot prompt per-command in headless exec mode.");
    if (approved === false) throw new Error("Codex CLI worker round was not approved.");
  }
  const output = await runCodexExec({
    cwd: options.cwd,
    prompt: buildWorkerContext(input),
    schema: "completion-report",
    permissionMode: options.config.permissionMode,
    env: options.env,
    codexCliPath: options.config.codexCliPath,
    modelName: options.entry.modelName,
    abortSignal: options.abortSignal,
    role: "worker",
    entry: options.entry,
    ledger: options.ledger,
    onText: options.onWorkerText,
    onToolEvent: options.onToolEvent
  });
  return validateCompletionReport(input.plan, output);
}
