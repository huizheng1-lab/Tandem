import { TandemConfig } from "../config/schema.js";
import {
  BuildPlan,
  CompletionReportSchema,
  CompletionReport,
  ReviewVerdict,
  ReviewVerdictSchema,
  validateBuildPlan,
  validateCompletionReport
} from "./artifacts.js";

export type MachinePhase = "IDLE" | "PLANNING" | "BUILDING" | "REVIEWING" | "FEEDBACK" | "TAKEOVER" | "DONE";
export interface OrchestrationCheckpoint {
  phase: MachinePhase;
  round: number;
  plan?: BuildPlan;
  reports: CompletionReport[];
  verdicts: ReviewVerdict[];
  feedbackHistory: ReviewVerdict["feedback"][];
}

export type MachineEvent =
  | { type: "transition"; phase: MachinePhase; message: string }
  | { type: "artifact"; name: string; value: unknown }
  | { type: "checkpoint"; checkpoint: OrchestrationCheckpoint }
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export type PlanResult = { kind: "answer"; answer: string } | { kind: "plan"; plan: BuildPlan };

export interface AgentFns {
  plan(input: { request: string; goals: string[]; history?: string }): Promise<PlanResult>;
  build(input: { plan: BuildPlan; round: number; feedback: ReviewVerdict["feedback"]; previousReport?: CompletionReport }): Promise<unknown>;
  review(input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string }): Promise<unknown>;
  takeover(input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewVerdict["feedback"][] }): Promise<{ report: CompletionReport; userSummary: string }>;
}

export interface RunOptions {
  request: string;
  config: Pick<TandemConfig, "maxReviewRounds">;
  agents: AgentFns;
  goals?: string[];
  history?: string;
  diffProvider?: (() => Promise<string>) | { beforeBuild?: () => Promise<void>; diff: () => Promise<string> };
  confirmPlan?: (plan: BuildPlan) => Promise<boolean>;
  initialState?: OrchestrationCheckpoint;
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
  const reports: CompletionReport[] = [...(options.initialState?.reports ?? [])];
  const verdicts: ReviewVerdict[] = [...(options.initialState?.verdicts ?? [])];
  const allFeedback: ReviewVerdict["feedback"][] = [...(options.initialState?.feedbackHistory ?? [])];
  let phase: MachinePhase = options.initialState?.phase ?? "PLANNING";
  let round = options.initialState?.round ?? 0;

  const emitCheckpoint = () => {
    emit({
      type: "checkpoint",
      checkpoint: {
        phase,
        round,
        plan,
        reports: [...reports],
        verdicts: [...verdicts],
        feedbackHistory: [...allFeedback]
      }
    });
  };

  const transition = (nextPhase: MachinePhase, message: string, nextRound = round) => {
    phase = nextPhase;
    round = nextRound;
    emit({ type: "transition", phase: nextPhase, message });
    emitCheckpoint();
  };

  let plan = options.initialState?.plan;

  if (!plan) {
    transition("PLANNING", "leader planning", 0);
    const planResult = await options.agents.plan({ request: options.request, goals: options.goals ?? [], history: options.history });
    if (planResult.kind === "answer") {
      transition("DONE", "leader answered without build plan", 0);
      return { phase: "DONE", summary: planResult.answer, reports, verdicts, takeover: false };
    }

    plan = validateBuildPlan(planResult.plan);
    emit({ type: "artifact", name: "BuildPlan", value: plan });
    emitCheckpoint();
    if (options.confirmPlan) {
      const confirmed = await options.confirmPlan(plan);
      if (!confirmed) {
        transition("DONE", "build plan rejected by user", 0);
        return { phase: "DONE", summary: "Build plan was not approved.", plan, reports, verdicts, takeover: false };
      }
    }
  }

  if (phase === "DONE") {
    emitCheckpoint();
    return { phase: "DONE", summary: "Session already completed.", plan, reports, verdicts, takeover: false };
  }

  const runTakeover = async (message: string): Promise<RunResult> => {
    transition("TAKEOVER", message, round);
    let lastTakeover: { report: unknown; userSummary: string } | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const takeover = await options.agents.takeover({ plan, reports, feedback: allFeedback });
        lastTakeover = takeover;
        const report = validateCompletionReport(plan, takeover.report);
        reports.push(report);
        emit({ type: "artifact", name: "TakeoverReport", value: report });
        transition("DONE", "takeover done", round);
        return { phase: "DONE", summary: takeover.userSummary, plan, reports, verdicts, takeover: true };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        lastError = error;
        emit({ type: "error", message: `TakeoverReport failed on attempt ${attempt}: ${String(error)}` });
      }
    }
    if (!lastTakeover) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    const schemaOnly = CompletionReportSchema.safeParse(lastTakeover.report);
    if (schemaOnly.success) reports.push(schemaOnly.data);
    emit({ type: "artifact", name: "TakeoverReport", value: lastTakeover.report });
    const summary = `Build finished under leader takeover, but takeover verification bookkeeping could not be finalized after retries: ${String(lastError)}. ${lastTakeover.userSummary}`;
    transition("DONE", "takeover report validation failed; build preserved", round);
    return { phase: "DONE", summary, plan, reports, verdicts, takeover: true };
  };

  if (options.config.maxReviewRounds === 0) return runTakeover("maxReviewRounds is 0; leader takeover");

  let feedback: ReviewVerdict["feedback"] = allFeedback.at(-1) ?? [];
  let nextRound = phase === "REVIEWING" ? Math.max(1, reports.length) : Math.max(1, reports.length + 1);
  if (phase === "BUILDING" && round > 0) nextRound = round;
  if (phase === "FEEDBACK") nextRound = reports.length + 1;

  for (let currentRound = nextRound; currentRound <= options.config.maxReviewRounds; currentRound += 1) {
    let report: CompletionReport;
    if (phase === "REVIEWING" && reports.length >= currentRound) {
      report = reports[currentRound - 1] as CompletionReport;
    } else {
      transition("BUILDING", `round ${currentRound}/${options.config.maxReviewRounds} worker build`, currentRound);
      if (options.diffProvider && typeof options.diffProvider !== "function") await options.diffProvider.beforeBuild?.();
      try {
        report = await retryArtifact(
          "CompletionReport",
          emit,
          () => options.agents.build({ plan, round: currentRound, feedback, previousReport: reports.at(-1) }),
          (value) => validateCompletionReport(plan, value)
        );
      } catch (error) {
        emit({ type: "error", message: `worker could not produce a valid CompletionReport: ${String(error)}` });
        return runTakeover("worker artifact failure; leader takeover");
      }
      reports.push(report);
      emitCheckpoint();
    }

    transition("REVIEWING", `round ${currentRound}/${options.config.maxReviewRounds} leader review`, currentRound);
    const diff = options.diffProvider ? await (typeof options.diffProvider === "function" ? options.diffProvider() : options.diffProvider.diff()) : "";
    let verdict: ReviewVerdict;
    try {
      verdict = await retryArtifact(
        "ReviewVerdict",
        emit,
        () => options.agents.review({ plan, report, round: currentRound, diff }),
        (value) => ReviewVerdictSchema.parse(value)
      );
    } catch (error) {
      const summary = `Build completed, but automated review could not be finalized after retries. Last worker report: ${report.summary}`;
      emit({ type: "error", message: `leader review could not produce a valid ReviewVerdict: ${String(error)}` });
      transition("DONE", "leader review failed; build report preserved", currentRound);
      return { phase: "DONE", summary, plan, reports, verdicts, takeover: false };
    }
    verdicts.push(verdict);
    emitCheckpoint();

    if (verdict.verdict === "takeover" || report.status === "blocked") {
      return runTakeover(report.status === "blocked" ? "worker blocked; leader takeover" : "leader requested takeover");
    }

    if (verdict.verdict === "approve") {
      transition("DONE", "leader review approved", currentRound);
      return { phase: "DONE", summary: verdict.userSummary, plan, reports, verdicts, takeover: false };
    }

    feedback = verdict.feedback;
    allFeedback.push(feedback);
    transition("FEEDBACK", `leader review requested ${feedback.length} change(s)`, currentRound);
    phase = "BUILDING";
  }

  return runTakeover("round limit exhausted; leader takeover");
}
