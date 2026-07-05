import { generateObject, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { TandemConfig } from "../config/schema.js";
import { makeModel } from "../providers/client.js";
import { ModelEntry } from "../providers/registry.js";
import { PermissionBridge } from "../tools/permissions.js";
import { makeToolSet } from "../tools/index.js";
import { CostLedger, CostRole } from "../session/cost.js";
import { AgentFns, PlanResult } from "../orchestrator/machine.js";
import { BuildPlan, BuildPlanSchema, CompletionReportSchema, ReviewVerdictSchema } from "../orchestrator/artifacts.js";
import { Goal } from "../session/goals.js";
import { runAgentArtifact, runAgentText } from "./runner.js";
import { leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt } from "./leader.js";
import { workerPrompt } from "./worker.js";

export interface LiveAgentOptions {
  config: TandemConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: CostLedger;
  permissionBridge?: PermissionBridge;
  recordTouchedPath?: (filePath: string) => void;
  abortSignal?: AbortSignal;
  onLeaderText?: (text: string) => void;
  onWorkerText?: (text: string) => void;
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mergeTools(...sets: ToolSet[]): ToolSet {
  return Object.assign({}, ...sets);
}

export type ProseObjectGenerator<T> = (options: {
  model: LanguageModel;
  schema: z.ZodType<T>;
  abortSignal?: AbortSignal;
  prompt: string;
}) => Promise<{ object: T; usage?: unknown }>;

export interface ExtractFromProseOptions<T> {
  resolution: { model: LanguageModel; entry: ModelEntry };
  ledger: CostLedger;
  role: CostRole;
  schema: z.ZodType<T>;
  artifactName: string;
  text: string;
  abortSignal?: AbortSignal;
  originalError: Error;
  generator?: ProseObjectGenerator<T>;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Some models (observed: Gemini 2.5 Pro) reliably do the work but fail to call their submit_*
// tool even when tool choice is forced. Recover by extracting the artifact from the prose the
// model already wrote, via schema-constrained generation with no tools involved.
export async function extractFromProse<T>(options: ExtractFromProseOptions<T>): Promise<T> {
  if (!options.text.trim()) throw options.originalError;
  const generator: ProseObjectGenerator<T> =
    options.generator ??
    ((input) =>
      generateObject({
        model: input.model,
        schema: input.schema,
        abortSignal: input.abortSignal,
        prompt: input.prompt
      }));
  try {
    const { object, usage } = await generator({
      model: options.resolution.model,
      schema: options.schema,
      abortSignal: options.abortSignal,
      prompt: `The following text is a completed ${options.artifactName} written as prose. Convert it faithfully into the structured object. Do not invent facts that are not in the text.\n\n${options.text}`
    });
    const raw = usage as { inputTokens?: unknown; outputTokens?: unknown; promptTokens?: unknown; completionTokens?: unknown } | undefined;
    options.ledger.add(
      options.role,
      options.resolution.entry,
      usageNumber(raw?.inputTokens ?? raw?.promptTokens),
      usageNumber(raw?.outputTokens ?? raw?.completionTokens)
    );
    return object;
  } catch {
    throw options.originalError;
  }
}

export async function createLiveAgents(options: LiveAgentOptions): Promise<AgentFns> {
  const leader = await makeModel(options.config.leader, options.config, options.env);
  const worker = await makeModel(options.config.worker, options.config, options.env);
  const toolContext = {
    cwd: options.cwd,
    permissionMode: options.config.permissionMode,
    permissionBridge: options.permissionBridge,
    recordTouchedPath: options.recordTouchedPath
  };

  return {
    plan: async ({ request, goals }): Promise<PlanResult> => {
      let submittedPlan: BuildPlan | undefined;
      const submitTools = {
        submit_build_plan: tool({
          description: "Submit the build plan and end planning.",
          inputSchema: BuildPlanSchema,
          execute: (input) => {
            submittedPlan = input;
            return { ok: true };
          }
        })
      };
      const result = await runAgentArtifact({
        model: leader.model,
        modelEntry: leader.entry,
        costRole: "leader",
        ledger: options.ledger,
        system: `${leaderPlannerPrompt}\nYou may answer directly for pure questions. For implementation work, call submit_build_plan exactly once.\nThe "verification" field must contain exact runnable shell commands only (e.g. "node test.mjs"), one command per entry — never prose or manual instructions. Put manual checks in acceptanceCriteria instead.`,
        messages: [
          {
            role: "user",
            content: `Request:\n${request}\n\nStanding goals:\n${goals.length > 0 ? goals.join("\n") : "none"}`
          }
        ],
        tools: mergeTools(makeToolSet(toolContext, "leader-readonly"), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_build_plan",
        abortSignal: options.abortSignal,
        onText: options.onLeaderText,
        artifactName: "BuildPlan",
        getArtifact: () => submittedPlan
      });
      return result.artifact ? { kind: "plan", plan: result.artifact } : { kind: "answer", answer: result.text.trim() };
    },

    build: async ({ plan, round, feedback, previousReport }) => {
      let report: z.infer<typeof CompletionReportSchema> | undefined;
      const submitTools = {
        submit_completion_report: tool({
          description: "Submit the worker completion report and end building.",
          inputSchema: CompletionReportSchema,
          execute: (input) => {
            report = input;
            return { ok: true };
          }
        })
      };
      const result = await runAgentArtifact({
        model: worker.model,
        modelEntry: worker.entry,
        costRole: "worker",
        ledger: options.ledger,
        system: `${workerPrompt}\nYou must run every verification command before submit_completion_report.`,
        messages: [
          {
            role: "user",
            content: `Round ${round}\nBuildPlan:\n${jsonBlock(plan)}\n\nReview feedback:\n${jsonBlock(feedback)}\n\nPrevious report:\n${jsonBlock(previousReport ?? null)}`
          }
        ],
        tools: mergeTools(makeToolSet(toolContext, "worker"), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_completion_report",
        abortSignal: options.abortSignal,
        onText: options.onWorkerText,
        artifactName: "CompletionReport",
        getArtifact: () => report
      });
      if (!result.artifact) throw new Error("Worker finished without submit_completion_report. Retry with an explicit report.");
      return result.artifact;
    },

    review: async ({ plan, report, round, diff }) => {
      let verdict: z.infer<typeof ReviewVerdictSchema> | undefined;
      const submitTools = {
        submit_review: tool({
          description: "Submit the review verdict and end reviewing.",
          inputSchema: ReviewVerdictSchema,
          execute: (input) => {
            verdict = input;
            return { ok: true };
          }
        })
      };
      const result = await runAgentArtifact({
        model: leader.model,
        modelEntry: leader.entry,
        costRole: "leader",
        ledger: options.ledger,
        system: `${leaderReviewerPrompt}\nYou may rerun only the plan verification commands. End by calling submit_review.`,
        messages: [
          {
            role: "user",
            content: `Round ${round}\nBuildPlan:\n${jsonBlock(plan)}\n\nCompletionReport:\n${jsonBlock(report)}\n\nDiff:\n${diff || "(empty diff)"}`
          }
        ],
        tools: mergeTools(makeToolSet(toolContext, "reviewer", plan.verification), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_review",
        abortSignal: options.abortSignal,
        onText: options.onLeaderText,
        artifactName: "ReviewVerdict",
        getArtifact: () => verdict
      });
      if (result.artifact) return result.artifact;
      return extractFromProse({
        resolution: leader,
        ledger: options.ledger,
        role: "leader",
        schema: ReviewVerdictSchema,
        artifactName: "ReviewVerdict",
        text: result.text,
        abortSignal: options.abortSignal,
        originalError: new Error("Leader review finished without submit_review.")
      });
    },

    takeover: async ({ plan, reports, feedback }) => {
      let submitted: { report: z.infer<typeof CompletionReportSchema>; userSummary: string } | undefined;
      const submitTools = {
        submit_takeover: tool({
          description: "Submit takeover report and user summary.",
          inputSchema: z.object({ report: CompletionReportSchema, userSummary: z.string() }),
          execute: (input) => {
            submitted = input;
            return { ok: true };
          }
        })
      };
      const result = await runAgentArtifact({
        model: leader.model,
        modelEntry: leader.entry,
        costRole: "leader",
        ledger: options.ledger,
        system: `${leaderTakeoverPrompt}\nRun every verification command, then call submit_takeover.`,
        messages: [
          {
            role: "user",
            content: `BuildPlan:\n${jsonBlock(plan)}\n\nPrevious reports:\n${jsonBlock(reports)}\n\nFeedback history:\n${jsonBlock(feedback)}`
          }
        ],
        tools: mergeTools(makeToolSet(toolContext, "takeover"), submitTools),
        maxSteps: options.config.maxStepsPerAgentTurn,
        stopToolName: "submit_takeover",
        abortSignal: options.abortSignal,
        onText: options.onLeaderText,
        artifactName: "TakeoverReport",
        getArtifact: () => submitted
      });
      if (result.artifact) return result.artifact;

      const takeoverSchema = z.object({ report: CompletionReportSchema, userSummary: z.string() });
      return extractFromProse({
        resolution: leader,
        ledger: options.ledger,
        role: "leader",
        schema: takeoverSchema,
        artifactName: "TakeoverReport",
        text: result.text,
        abortSignal: options.abortSignal,
        originalError: new Error("Leader takeover finished without submit_takeover.")
      });
    }
  };
}

export interface GoalProgressNote {
  goalId: number;
  note: string;
}

export async function suggestGoalProgressNotes(options: Pick<LiveAgentOptions, "config" | "cwd" | "env" | "ledger" | "abortSignal" | "onLeaderText"> & {
  goals: Goal[];
  userSummary: string;
}): Promise<GoalProgressNote[]> {
  if (options.goals.length === 0) return [];
  const leader = await makeModel(options.config.leader, options.config, options.env);
  let submitted: { notes: GoalProgressNote[] } | undefined;
  const submitTools = {
    submit_goal_notes: tool({
      description: "Submit one-line progress notes for only the goals that advanced.",
      inputSchema: z.object({
        notes: z.array(
          z.object({
            goalId: z.number().int().positive(),
            note: z.string().min(1).max(240)
          })
        )
      }),
      execute: (input) => {
        submitted = input;
        return { ok: true };
      }
    })
  };
  const result = await runAgentArtifact({
    model: leader.model,
    modelEntry: leader.entry,
    costRole: "leader",
    ledger: options.ledger,
    system: "You update Tandem standing goals. If the completed run advanced a goal, call submit_goal_notes with a short past-tense note. Omit unrelated goals.",
    messages: [
      {
        role: "user",
        content: `Active goals:\n${jsonBlock(options.goals.map((goal) => ({ id: goal.id, text: goal.text })))}\n\nRun summary:\n${options.userSummary}`
      }
    ],
    tools: submitTools,
    maxSteps: Math.min(5, options.config.maxStepsPerAgentTurn),
    stopToolName: "submit_goal_notes",
    toolChoice: { type: "tool", toolName: "submit_goal_notes" },
    abortSignal: options.abortSignal,
    onText: options.onLeaderText,
    artifactName: "GoalProgressNotes",
    getArtifact: () => submitted
  });
  const allowedIds = new Set(options.goals.map((goal) => goal.id));
  return (result.artifact?.notes ?? []).filter((note) => allowedIds.has(note.goalId));
}
