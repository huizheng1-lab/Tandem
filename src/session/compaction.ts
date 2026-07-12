import { z } from "zod";
import type { TandemConfig } from "../config/schema.js";
import { leaderPlannerPrompt } from "../agents/leader.js";
import { hostPlatformPrompt } from "../agents/platform.js";
import { runAgentText } from "../agents/runner.js";
import { runCodexExec } from "../agents/codex-cli/exec.js";
import { runClaudeExec } from "../agents/claude-code-cli/exec.js";
import { makeModel } from "../providers/client.js";
import { resolveModel } from "../providers/registry.js";
import { withConfiguredCliModel } from "../providers/cli-models.js";
import { sanitizeModelOutputText } from "../tools/sanitize.js";
import type { CostLedger } from "./cost.js";
import type { SessionEvent } from "./store.js";
import { buildConversationHistory } from "./history.js";

export interface LeaderCompactionEvent {
  summary: string;
  compactedTurns: number;
}

export interface CompactionSource {
  text: string;
  priorTurns: number;
  truncated: boolean;
}

export const COMPACTION_SYSTEM_PROMPT =
  "Summarize the prior Tandem leader conversation for continuing future turns. Preserve user requests, files or artifacts named, decisions, unresolved issues, and accepted plans/reviews. Be concise.";

export const MIN_LEADER_CONTEXT_BUDGET_TOKENS = 2000;

const PlanOrAnswerSchema = z.object({
  kind: z.enum(["question", "implementation"]),
  answer: z.string().optional()
});

export function isCliBackedLeader(config: TandemConfig): boolean {
  const entry = withConfiguredCliModel(resolveModel(config.leader, config.customModels), config);
  return entry.provider === "codex-cli" || entry.provider === "claude-code-cli";
}

export function effectiveLeaderContextBudgetTokens(config: Pick<TandemConfig, "leaderContextBudgetTokens">): number {
  return Math.max(config.leaderContextBudgetTokens, MIN_LEADER_CONTEXT_BUDGET_TOKENS);
}

export function leaderContextBudgetChars(config: Pick<TandemConfig, "leaderContextBudgetTokens">): number {
  return effectiveLeaderContextBudgetTokens(config) * 4;
}

export function compactionSource(events: SessionEvent[], config: Pick<TandemConfig, "leaderContextBudgetTokens">, force = false): CompactionSource | undefined {
  const detection = buildConversationHistory(events, Number.MAX_SAFE_INTEGER, force ? Number.MAX_SAFE_INTEGER : leaderContextBudgetChars(config));
  if (!detection.text.trim()) return undefined;
  if (!force && !detection.truncated) return undefined;
  const source = buildConversationHistory(events, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return { ...source, truncated: detection.truncated };
}

function compactionPrompt(source: string): string {
  return `${COMPACTION_SYSTEM_PROMPT}

Return JSON matching the schema. Set kind="question" and put the summary in answer. Do not produce a plan.

Conversation to compact:
${source}`;
}

function parseCliSummary(value: unknown): string {
  const parsed = PlanOrAnswerSchema.parse(value);
  if (parsed.kind !== "question" || !parsed.answer?.trim()) throw new Error("Compaction summarizer did not return a summary answer.");
  return parsed.answer.trim();
}

export async function compactSessionHistory(options: {
  events: SessionEvent[];
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: CostLedger;
  force?: boolean;
  abortSignal?: AbortSignal;
  summarizer?: (source: CompactionSource) => string | Promise<string>;
}): Promise<LeaderCompactionEvent | undefined> {
  const source = compactionSource(options.events, options.config, options.force);
  if (!source) return undefined;

  const summary = options.summarizer
    ? await options.summarizer(source)
    : await summarizeWithConfiguredLeader(options, source.text);
  const trimmed = sanitizeModelOutputText(summary);
  if (!trimmed) throw new Error("Compaction summarizer returned an empty summary.");
  return { summary: trimmed, compactedTurns: source.priorTurns };
}

async function summarizeWithConfiguredLeader(
  options: Pick<Parameters<typeof compactSessionHistory>[0], "config" | "cwd" | "env" | "ledger" | "abortSignal">,
  source: string
): Promise<string> {
  const resolution = await makeModel(options.config.leader, options.config, options.env);
  if (resolution.entry.provider === "codex-cli") {
    return parseCliSummary(
      await runCodexExec({
        cwd: options.cwd,
        prompt: compactionPrompt(source),
        schema: "plan-or-answer",
        readOnly: true,
        permissionMode: options.config.permissionMode,
        env: options.env,
        codexCliPath: options.config.codexCliPath,
        modelName: resolution.entry.modelName,
        modelReasoningEffort: options.config.codexCliReasoningEffort,
        abortSignal: options.abortSignal,
        role: "leader",
        entry: resolution.entry,
        ledger: options.ledger
      })
    );
  }
  if (resolution.entry.provider === "claude-code-cli") {
    return parseCliSummary(
      await runClaudeExec({
        cwd: options.cwd,
        prompt: `Conversation to compact:\n${source}`,
        systemPrompt: `${leaderPlannerPrompt}
${hostPlatformPrompt(process.platform, options.env)}
${COMPACTION_SYSTEM_PROMPT}

Return JSON matching the schema. Set kind="question" and put the summary in answer. Do not produce a plan.`,
        schema: "plan-or-answer",
        readOnly: true,
        permissionMode: options.config.permissionMode,
        env: options.env,
        claudeCliPath: options.config.claudeCliPath,
        modelName: resolution.entry.modelName,
        abortSignal: options.abortSignal,
        role: "leader",
        entry: resolution.entry,
        ledger: options.ledger,
        maxBudgetUsd: options.config.claudeMaxBudgetUsdPerCall
      })
    );
  }

  const { text } = await runAgentText({
    model: resolution.model,
    modelEntry: resolution.entry,
    costRole: "leader",
    ledger: options.ledger,
    system: `${leaderPlannerPrompt}
${COMPACTION_SYSTEM_PROMPT}`,
    messages: [{ role: "user", content: source }],
    maxSteps: Math.min(8, options.config.maxStepsPerAgentTurn),
    abortSignal: options.abortSignal
  });
  return text.trim();
}
