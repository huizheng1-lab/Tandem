import type { TandemConfig } from "../../config/schema.js";
import type { BuildPlan, CompletionReport, ReviewFeedback } from "../../orchestrator/artifacts.js";
import { validateCompletionReport } from "../../orchestrator/artifacts.js";
import type { ModelEntry } from "../../providers/registry.js";
import { CostLedger } from "../../session/cost.js";
import type { ToolActivityEvent } from "../../tools/fs.js";
import { buildWorkerContext } from "../live.js";
import { hostPlatformPrompt } from "../platform.js";
import { workerPrompt } from "../worker.js";
import { runClaudeExec } from "./exec.js";

export interface ClaudeWorkerOptions {
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entry: ModelEntry;
  ledger: CostLedger;
  abortSignal?: AbortSignal;
  onWorkerText?: (text: string) => void;
  onToolEvent?: (event: ToolActivityEvent) => void;
  confirmCodexWrite?: (role: "leader" | "worker", message: string) => Promise<boolean>;
  projectInstructions?: () => string | Promise<string>;
}

async function projectInstructions(options: Pick<ClaudeWorkerOptions, "projectInstructions">): Promise<string> {
  return (await options.projectInstructions?.())?.trim() || "Project instructions:\nnone";
}

export async function buildClaudeWorkerPrompts(
  options: Pick<ClaudeWorkerOptions, "env" | "projectInstructions">,
  input: { plan: BuildPlan; streamId: string; tasks: BuildPlan["tasks"]; verification: string[]; round: number; feedback: ReviewFeedback; previousReport?: CompletionReport }
): Promise<{ systemPrompt: string; prompt: string }> {
  return {
    systemPrompt: `${workerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${await projectInstructions(options)}
If read_file says you CANNOT view a file's visual content, never guess, infer, or claim to know what it shows. If the task depends on that content and the plan lacks sufficient leader-provided findings, submit a blocked CompletionReport.
You must run every verification command before submit_completion_report. In verificationResults[].command, repeat the BuildPlan verification command string verbatim. If you adapt a command for the host platform, still use the plan's original command as command and describe the adapted command plus real output in output.`,
    prompt: buildWorkerContext(input)
  };
}

export async function runClaudeWorkerBuild(
  options: ClaudeWorkerOptions,
  input: { plan: BuildPlan; streamId: string; tasks: BuildPlan["tasks"]; verification: string[]; round: number; feedback: ReviewFeedback; previousReport?: CompletionReport }
): Promise<CompletionReport> {
  if (options.config.permissionMode === "ask") {
    const approved = await options.confirmCodexWrite?.("worker", "Run this round via Claude Code CLI with write access? Claude Code cannot prompt per-command in headless print mode.");
    if (approved === false) throw new Error("Claude Code CLI worker round was not approved.");
  }
  const prompts = await buildClaudeWorkerPrompts(options, input);
  const output = await runClaudeExec({
    cwd: options.cwd,
    prompt: prompts.prompt,
    systemPrompt: prompts.systemPrompt,
    schema: "completion-report",
    permissionMode: options.config.permissionMode,
    env: options.env,
    claudeCliPath: options.config.claudeCliPath,
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
