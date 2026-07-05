import { TandemConfig } from "../config/schema.js";
import {
  BuildPlan,
  BuildPlanSchema,
  CompletionReport,
  ReviewVerdict,
  ReviewVerdictSchema,
  validateCompletionReport
} from "./artifacts.js";

export type MachinePhase = "IDLE" | "PLANNING" | "BUILDING" | "REVIEWING" | "FEEDBACK" | "TAKEOVER" | "DONE";
export type MachineEvent =
  | { type: "transition"; phase: MachinePhase; message: string }
  | { type: "artifact"; name: string; value: unknown }
  | { type: "error"; message: string };

export type PlanResult = { kind: "answer"; answer: string } | { kind: "plan"; plan: BuildPlan };

export interface AgentFns {
  plan(input: { request: string; goals: string[] }): Promise<PlanResult>;
  build(input: { plan: BuildPlan; round: number; feedback: ReviewVerdict["feedback"]; previousReport?: CompletionReport }): Promise<unknown>;
  review(input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string }): Promise<unknown>;
  takeover(input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewVerdict["feedback"][] }): Promise<{ report: CompletionReport; userSummary: string }>;
}

export interface RunOptions {
  request: string;
  config: Pick<TandemConfig, "maxReviewRounds">;
  agents: AgentFns;
  goals?: string[];
  diffProvider?: () => Promise<string>;
  confirmPlan?: (plan: BuildPlan) => Promise<boolean>;
  emit?: (event: MachineEvent) => void;
}

async function retryArtifact<T>(name: string, emit: (event: MachineEvent) => void, producer: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const value = await producer();
      const parsed = parse(value);
      emit({ type: "artifact", name, value: parsed });
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error;
      emit({ type: "error", message: `${name} failed on attempt ${attempt}: ${String(error)}` });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface RunResult {
  phase: MachinePhase;
  summary: string;
  plan?: BuildPlan;
  reports: CompletionReport[];
  verdicts: ReviewVerdict[];
  takeover: boolean;
}

export async function runOrchestration(options: RunOptions): Promise<RunResult> {
  const emit = options.emit ?? (() => undefined);
  const reports: CompletionReport[] = [];
  const verdicts: ReviewVerdict[] = [];
  const allFeedback: ReviewVerdict["feedback"][] = [];

  emit({ type: "transition", phase: "PLANNING", message: "leader planning" });
  const planResult = await options.agents.plan({ request: options.request, goals: options.goals ?? [] });
  if (planResult.kind === "answer") {
    emit({ type: "transition", phase: "DONE", message: "leader answered without build plan" });
    return { phase: "DONE", summary: planResult.answer, reports, verdicts, takeover: false };
  }

  const plan = BuildPlanSchema.parse(planResult.plan);
  emit({ type: "artifact", name: "BuildPlan", value: plan });
  if (options.confirmPlan) {
    const confirmed = await options.confirmPlan(plan);
    if (!confirmed) {
      emit({ type: "transition", phase: "DONE", message: "build plan rejected by user" });
      return { phase: "DONE", summary: "Build plan was not approved.", plan, reports, verdicts, takeover: false };
    }
  }

  const runTakeover = async (message: string): Promise<RunResult> => {
    emit({ type: "transition", phase: "TAKEOVER", message });
    const takeover = await options.agents.takeover({ plan, reports, feedback: allFeedback });
    const report = validateCompletionReport(plan, takeover.report);
    reports.push(report);
    emit({ type: "artifact", name: "TakeoverReport", value: report });
    emit({ type: "transition", phase: "DONE", message: "takeover done" });
    return { phase: "DONE", summary: takeover.userSummary, plan, reports, verdicts, takeover: true };
  };

  if (options.config.maxReviewRounds === 0) return runTakeover("maxReviewRounds is 0; leader takeover");

  let feedback: ReviewVerdict["feedback"] = [];
  for (let round = 1; round <= options.config.maxReviewRounds; round += 1) {
    emit({ type: "transition", phase: "BUILDING", message: `round ${round}/${options.config.maxReviewRounds} worker build` });
    let report: CompletionReport;
    try {
      report = await retryArtifact(
        "CompletionReport",
        emit,
        () => options.agents.build({ plan, round, feedback, previousReport: reports.at(-1) }),
        (value) => validateCompletionReport(plan, value)
      );
    } catch (error) {
      emit({ type: "error", message: `worker could not produce a valid CompletionReport: ${String(error)}` });
      return runTakeover("worker artifact failure; leader takeover");
    }
    reports.push(report);

    emit({ type: "transition", phase: "REVIEWING", message: `round ${round}/${options.config.maxReviewRounds} leader review` });
    const diff = options.diffProvider ? await options.diffProvider() : "";
    const verdict = await retryArtifact(
      "ReviewVerdict",
      emit,
      () => options.agents.review({ plan, report, round, diff }),
      (value) => ReviewVerdictSchema.parse(value)
    );
    verdicts.push(verdict);

    if (verdict.verdict === "takeover" || report.status === "blocked") {
      return runTakeover(report.status === "blocked" ? "worker blocked; leader takeover" : "leader requested takeover");
    }

    if (verdict.verdict === "approve") {
      emit({ type: "transition", phase: "DONE", message: "leader review approved" });
      return { phase: "DONE", summary: verdict.userSummary, plan, reports, verdicts, takeover: false };
    }

    feedback = verdict.feedback;
    allFeedback.push(feedback);
    emit({ type: "transition", phase: "FEEDBACK", message: `leader review requested ${feedback.length} change(s)` });
  }

  return runTakeover("round limit exhausted; leader takeover");
}
