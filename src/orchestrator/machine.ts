import { TandemConfig } from "../config/schema.js";
import type { AttachmentRef } from "../session/attachments.js";
import {
  BuildPlan,
  CompletionReportSchema,
  CompletionReport,
  PlanStream,
  ReviewVerdict,
  ReviewVerdictSchema,
  mergeCompletionReports,
  partitionPlan,
  validateBuildPlan,
  validateCompletionReport
} from "./artifacts.js";
import { sanitizePromptValue } from "../tools/sanitize.js";
import { VerificationRunner, VerificationResult } from "./verification.js";

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
  | { type: "error"; message: string; stack?: string };

export type PlanResult = { kind: "answer"; answer: string } | { kind: "plan"; plan: BuildPlan };

// D54: extended `build` signature. `streams` lists the per-stream task slices for this round;
// `streamId` identifies which stream THIS worker invocation is responsible for; `plan` and
// `previousReport` keep their previous semantics (full plan context, last round's report).
// Single-stream callers (old AgentFns implementations) can ignore `streams` since the orchestrator
// always passes a one-element array for them, and `streamId` defaults to the only entry.
export interface BuildStreamInput {
  plan: BuildPlan;
  streamId: string;
  tasks: BuildPlan["tasks"];
  verification: string[];
  round: number;
  feedback: ReviewVerdict["feedback"];
  previousReport?: CompletionReport;
  previousAttemptError?: string;
  stepBudgetMultiplier?: number;
}

export interface AgentFns {
  plan(input: { request: string; goals: string[]; history?: string; attachments?: AttachmentRef[]; previousAttemptError?: string }): Promise<PlanResult>;
  build(input: BuildStreamInput): Promise<unknown>;
  review(input: { plan: BuildPlan; report: CompletionReport; round: number; diff: string; previousAttemptError?: string }): Promise<unknown>;
  takeover(input: { plan: BuildPlan; reports: CompletionReport[]; feedback: ReviewVerdict["feedback"][]; previousAttemptError?: string }): Promise<{ report: CompletionReport; userSummary: string }>;
}

export interface RunOptions {
  request: string;
  config: Pick<TandemConfig, "maxReviewRounds" | "maxParallelWorkers"> & Partial<Pick<TandemConfig, "permissionMode">>;
  agents: AgentFns;
  goals?: string[];
  history?: string;
  attachments?: AttachmentRef[];
  diffProvider?: (() => Promise<string>) | { beforeBuild?: () => Promise<void>; diff: () => Promise<string> };
  verificationRunner?: VerificationRunner;
  postBuildReport?: (report: CompletionReport, context: { plan: BuildPlan; round: number }) => Promise<CompletionReport>;
  confirmPlan?: (plan: BuildPlan) => Promise<boolean>;
  addSessionNote?: (text: string, by: "system") => Promise<void>;
  removeSessionNotesByPrefix?: (prefix: string) => Promise<void>;
  initialState?: OrchestrationCheckpoint;
  emit?: (event: MachineEvent) => void;
}

function isNullByteArgumentError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE" &&
    /without null bytes|null bytes/i.test(error.message)
  );
}

function errorEvent(message: string, error?: unknown): MachineEvent {
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  return stack ? { type: "error", message, stack } : { type: "error", message };
}

function previousAttemptMessage(error: unknown, max = 500): string {
  const normalized = String(error).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

export class WorkerStepExhaustionError extends Error {
  readonly stepsUsed: number;
  readonly maxSteps: number;

  constructor(stepsUsed: number, maxSteps: number) {
    super(`Worker step budget exhausted (${stepsUsed}/${maxSteps}) before submit_completion_report.`);
    this.name = "WorkerStepExhaustionError";
    this.stepsUsed = stepsUsed;
    this.maxSteps = maxSteps;
  }
}

function takeoverAuthoritativeVerificationWarning(report: CompletionReport): string | undefined {
  if (report.status !== "complete") return undefined;
  const failed = report.verificationResults.filter((result) => !result.passed);
  if (failed.length === 0) return undefined;
  const commands = failed.map((result) => result.command).join("; ");
  return `takeover claimed complete, but authoritative verification failed ${failed.length}/${report.verificationResults.length} command(s): ${commands}`;
}

async function retryArtifact<T>(name: string, emit: (event: MachineEvent) => void, producer: (previousError?: unknown, attempt?: number) => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const value = await producer(lastError, attempt);
      const parsed = sanitizePromptValue(parse(value));
      emit({ type: "artifact", name, value: parsed });
      return parsed;
    } catch (error) {
      // D66-2: rate-limit outcomes are not transient - retrying now (before the reset time)
      // is guaranteed to fail identically. Same AbortError fast-fail pattern.
      if (error instanceof Error && (error.name === "AbortError" || error.name === "RateLimitError" || isNullByteArgumentError(error))) throw error;
      lastError = error;
      emit(errorEvent(`${name} failed on attempt ${attempt}: ${String(error)}`, error));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// D54: build a synthetic carry-forward report for a stream that didn't run in this round.
// Only used as a defensive fallback when the previous report for a stream is missing entirely
// (which shouldn't happen in practice - it would mean a round-1 stream was never built).
function syntheticCarryReport(stream: PlanStream, fallback: CompletionReport | undefined): CompletionReport {
  if (fallback) return fallback;
  return {
    status: "blocked",
    summary: `[${stream.id}] no previous report carried forward`,
    taskResults: stream.tasks.map((task) => ({ id: task.id, status: "skipped" as const, notes: "stream did not run this round" })),
    filesChanged: [],
    verificationResults: [],
    deviationsFromPlan: []
  };
}

// D54: for a revise round, determine which streams actually need to be re-run. A feedback
// item targets a specific stream if its `location` (or its task-id-bearing `issue`/`requiredChange`
// text) names any task that belongs to that stream. Items with no attributable stream make
// the resolver fall back to re-running every stream (safe).
function streamsToRerun(
  streams: PlanStream[],
  feedback: ReviewVerdict["feedback"],
  allStreamIds: string[]
): Set<string> {
  const taskToStream = new Map<string, string>();
  for (const stream of streams) {
    for (const task of stream.tasks) {
      taskToStream.set(task.id, stream.id);
    }
  }
  const targeted = new Set<string>();
  for (const item of feedback) {
    const haystacks = [item.location ?? "", item.issue, item.requiredChange];
    let matched = false;
    for (const hay of haystacks) {
      for (const [taskId, streamId] of taskToStream) {
        if (hay.includes(taskId)) {
          targeted.add(streamId);
          matched = true;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      // No attribution: conservative re-run of all streams.
      for (const id of allStreamIds) targeted.add(id);
      return targeted;
    }
  }
  if (targeted.size === 0) {
    // Empty feedback - shouldn't happen on a `revise` verdict, but be conservative.
    for (const id of allStreamIds) targeted.add(id);
  }
  return targeted;
}

// D54: run a single stream's build. Returns the parsed CompletionReport. Throws after the
// existing 3-attempt retry envelope (caller handles takeover).
async function runOneStreamBuild(
  agents: AgentFns,
  stream: PlanStream,
  plan: BuildPlan,
  currentRound: number,
  feedback: ReviewVerdict["feedback"],
  previousReport: CompletionReport | undefined,
  emit: (event: MachineEvent) => void,
  authoritativeVerification: boolean
): Promise<CompletionReport> {
  emit({ type: "transition", phase: "BUILDING", message: `round ${currentRound} worker build [stream ${stream.id}: ${stream.tasks.length} task(s)]` });
  return retryArtifact(
    "CompletionReport",
    emit,
    (previousError, attempt = 1) => {
      const stepExhaustion = previousError instanceof WorkerStepExhaustionError ? previousError : undefined;
      const stepBudgetMultiplier = stepExhaustion ? Math.min(attempt, 3) : 1;
      if (stepExhaustion && stepBudgetMultiplier > 1) {
        emit({
          type: "notice",
          message: `stream ${stream.id} ran out of steps on attempt ${attempt - 1} (used ${stepExhaustion.stepsUsed}/${stepExhaustion.maxSteps}); retrying with an increased budget (${stepBudgetMultiplier}x)`
        });
      }
      return agents.build({
        plan,
        streamId: stream.id,
        tasks: stream.tasks,
        verification: stream.verification,
        round: currentRound,
        feedback,
        previousReport,
        previousAttemptError: previousError === undefined ? undefined : previousAttemptMessage(previousError),
        stepBudgetMultiplier
      });
    },
    (value) =>
      validateCompletionReport(plan, value, stream.verification, {
        enforceCommandEcho: !authoritativeVerification,
        enforceCompleteVerification: !authoritativeVerification
      })
  );
}

// D54: dispatch a list of streams under a concurrency cap using a worker-pool. cap-many
// workers run in parallel; as each finishes the next pending stream starts. If cap >=
// streams.length this is just Promise.all. The workers share the run's abort signal: if any
// call throws, the rest of the pool is rejected and the error propagates so the takeover
// fallback fires.
async function dispatchStreams(
  agents: AgentFns,
  streams: PlanStream[],
  cap: number,
  plan: BuildPlan,
  currentRound: number,
  feedback: ReviewVerdict["feedback"],
  previousReports: Map<string, CompletionReport>,
  emit: (event: MachineEvent) => void,
  authoritativeVerification: boolean
): Promise<CompletionReport[]> {
  if (streams.length === 0) return [];
  const poolSize = Math.max(1, cap);
  const results: CompletionReport[] = new Array(streams.length);
  const cursor = { next: 0 };

  function spawnOne(): Promise<unknown> {
    const index = cursor.next++;
    const stream = streams[index];
    if (!stream) return Promise.resolve();
    return runOneStreamBuild(agents, stream, plan, currentRound, feedback, previousReports.get(stream.id), emit, authoritativeVerification).then(
      (report) => {
        results[index] = report;
      }
    );
  }

  // Pool: keep at most `poolSize` workers in flight. When a worker resolves, if there are
  // more streams queued, start the next one. Loop until the queue is exhausted and no workers
  // are still running. We use `Promise.allSettled` semantics via a settled-promise sentinel:
  // any rejection from a worker is captured and re-thrown ONCE at the end, so the build loop's
  // outer try/catch can convert it to a takeover.
  const inflight = new Set<Promise<unknown>>();
  let firstError: unknown;
  for (let i = 0; i < Math.min(poolSize, streams.length); i++) {
    const p = spawnOne();
    p.then(
      () => inflight.delete(p),
      (err) => {
        inflight.delete(p);
        if (firstError === undefined) firstError = err;
      }
    );
    inflight.add(p);
  }
  while (inflight.size > 0) {
    // Wait for any worker to settle. Promise.race resolves when the first one does; the
    // .then/.catch above update inflight membership on each settlement.
    await Promise.race(inflight);
    // Refill any free slot - the .then/.catch will no-op on already-deleted promises.
    while (inflight.size < poolSize && cursor.next < streams.length) {
      const p = spawnOne();
      p.then(
        () => inflight.delete(p),
        (err) => {
          inflight.delete(p);
          if (firstError === undefined) firstError = err;
        }
      );
      inflight.add(p);
    }
  }
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  return results;
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
  // D54: per-stream report history, kept in stream-id order. The most recent entry per stream
  // is the previous report for the next round. We do NOT serialize this into the checkpoint
  // payload in this round (single-stream resume path doesn't need it) - the merged `reports`
  // array is what gets checkpointed, and the per-stream details are reconstructible from the
  // feedback history + plan partitioning on resume.
  const streamReportHistory: { streamId: string; report: CompletionReport }[][] = [];
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

  const attachAuthoritativeVerification = async (report: CompletionReport): Promise<{ report: CompletionReport; ran: boolean }> => {
    if (!options.verificationRunner) return { report, ran: false };
    try {
      const results: VerificationResult[] = await options.verificationRunner(plan?.verification ?? []);
      const passed = results.filter((result) => result.passed).length;
      emit({ type: "notice", message: `verification: ${passed}/${results.length} passed` });
      return { report: { ...report, verificationResults: results }, ran: true };
    } catch (error) {
      emit({ type: "notice", message: `authoritative verification skipped: ${String(error)}` });
      return { report, ran: false };
    }
  };

  let plan = options.initialState?.plan;

  if (!plan) {
    transition("PLANNING", "leader planning", 0);
    let planResult: PlanResult;
    try {
      // D64-1: wrap the plan() call in the same 3-attempt envelope build and review
      // already use. A transient leader hiccup (e.g. a permission-denial-style throw from
      // a read-only explore step) previously killed the whole session outright; the retry
      // self-corrects on a later attempt the way the build/review path already does.
      planResult = await retryArtifact<PlanResult>(
        "BuildPlanOrAnswer",
        emit,
        (previousError) =>
          options.agents.plan({
            request: options.request,
            goals: options.goals ?? [],
            history: options.history,
            attachments: options.attachments,
            previousAttemptError: previousError === undefined ? undefined : previousAttemptMessage(previousError)
          }),
        (value) => value as PlanResult
      );
    } catch (error) {
      // D64-1: if all 3 attempts fail (the retryArtifact envelope throws its lastError),
      // there's no plan to take over from - end the session cleanly with a diagnosable
      // summary, same shape as review-exhaustion. This must be a clean terminal state, not
      // a swallowed exception - the caller (tandem-service) will surface this to the user.
      const message = `Leader planning could not produce a valid result after retries: ${String(error)}`;
      transition("DONE", message, 0);
      return { phase: "DONE", summary: message, reports, verdicts, takeover: false };
    }
    if (planResult.kind === "answer") {
      transition("DONE", "leader answered without build plan", 0);
      return { phase: "DONE", summary: planResult.answer, reports, verdicts, takeover: false };
    }

    plan = await validateBuildPlan(planResult.plan);
    emit({ type: "artifact", name: "BuildPlan", value: plan });
    emitCheckpoint();
    if (options.confirmPlan) {
      const confirmed = await options.confirmPlan(plan);
      if (!confirmed) {
        transition("DONE", "build plan rejected by user", 0);
        return { phase: "DONE", summary: "Build plan was not approved.", plan, reports, verdicts, takeover: false };
      }
    }
    if (plan.constraints.length > 0) {
      await options.addSessionNote?.(`Plan '${plan.title}' constraints: ${plan.constraints.join("; ")}`, "system");
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
        const takeover = await options.agents.takeover({ plan, reports, feedback: allFeedback, previousAttemptError: lastError === undefined ? undefined : previousAttemptMessage(lastError) });
        lastTakeover = takeover;
        const schemaReport = validateCompletionReport(plan, takeover.report, plan.verification, {
          enforceCommandEcho: !options.verificationRunner,
          enforceCompleteVerification: !options.verificationRunner
        });
        const authoritative = await attachAuthoritativeVerification(schemaReport);
        const report = authoritative.report;
        validateCompletionReport(plan, report, plan.verification, {
          enforceCommandEcho: !authoritative.ran,
          enforceCompleteVerification: !authoritative.ran
        });
        const verificationWarning = authoritative.ran ? takeoverAuthoritativeVerificationWarning(report) : undefined;
        if (verificationWarning) emit({ type: "notice", message: verificationWarning });
        reports.push(report);
        emit({ type: "artifact", name: "TakeoverReport", value: report });
        transition("DONE", verificationWarning ? "takeover done with verification warning" : "takeover done", round);
        const summary = verificationWarning ? `${takeover.userSummary}\n\nWarning: ${verificationWarning}` : takeover.userSummary;
        return { phase: "DONE", summary, plan, reports, verdicts, takeover: true };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        lastError = error;
        emit(errorEvent(`TakeoverReport failed on attempt ${attempt}: ${String(error)}`, error));
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
      // D54: partition the plan into streams. Decide which streams to run this round.
      // First round: all streams. Revise rounds: only streams targeted by the feedback.
      const allStreams = partitionPlan(plan);
      const lastStreamReportList = streamReportHistory.at(-1);
      const previousReportsByStream = new Map<string, CompletionReport>(
        (lastStreamReportList ?? []).map((entry) => [entry.streamId, entry.report])
      );
      const targetStreamIds = (() => {
        if (currentRound === 1) return new Set(allStreams.map((s) => s.id));
        if (allFeedback.length === 0) return new Set(allStreams.map((s) => s.id));
        // Use the most recent feedback (the revise reason).
        return streamsToRerun(allStreams, allFeedback.at(-1) ?? [], allStreams.map((s) => s.id));
      })();
      const targetStreams = allStreams.filter((stream) => targetStreamIds.has(stream.id));
      // Streams that aren't re-run this round carry forward their previous report (unchanged).
      const carryForward = allStreams
        .filter((stream) => !targetStreamIds.has(stream.id))
        .map((stream) => ({
          streamId: stream.id,
          report:
            previousReportsByStream.get(stream.id) ??
            syntheticCarryReport(stream, previousReportsByStream.get(stream.id))
        }));

      if (targetStreams.length === 0) {
        // Defensive: revise with no targets - skip build, reuse previous merged report.
        report = reports.at(-1) as CompletionReport;
      } else {
        try {
          const cap = options.config.maxParallelWorkers;
          const newReports = await dispatchStreams(
            options.agents,
            targetStreams,
            cap,
            plan,
            currentRound,
            feedback,
            previousReportsByStream,
            emit,
            Boolean(options.verificationRunner)
          );
          // Build the round's effective stream list (newly-built + carry-forward).
          const roundStreams: { streamId: string; report: CompletionReport }[] = [
            ...newReports.map((report, i) => ({ streamId: targetStreams[i]?.id ?? "?", report })),
            ...carryForward
          ];
          streamReportHistory.push(roundStreams);
          // D58-1: pass roundStreams (new + carry-forward), not newReports alone. Without this
          // fix, revise rounds that re-run only some streams produced a merged report that
          // dropped every carried-forward stream's task results / filesChanged, leaving the
          // leader reviewer with an incomplete picture and the final report missing work.
          report = mergeCompletionReports(roundStreams);
          if (options.postBuildReport) {
            report = await options.postBuildReport(report, { plan, round: currentRound });
            emit({ type: "artifact", name: "PostBuildReport", value: report });
          }
          const authoritative = await attachAuthoritativeVerification(report);
          report = authoritative.report;
          validateCompletionReport(plan, report, plan.verification, {
            enforceCommandEcho: !authoritative.ran,
            enforceCompleteVerification: !authoritative.ran
          });
        } catch (error) {
          // D66-2: rate-limit errors should not trigger a takeover (the failure isn't in the
          // worker's output, it's a transient quota hit). Surface the resetsAt so the user
          // knows when to retry, and end the run cleanly rather than going through a doomed
          // takeover attempt.
          if (error instanceof Error && error.name === "RateLimitError") {
            const message = `Worker build is rate-limited: ${(error as { resetsAt?: string }).resetsAt ?? "unknown reset time"}. Try again after that time or switch engines.`;
            emit({ type: "error", message });
            transition("DONE", message, currentRound);
            return { phase: "DONE", summary: message, plan, reports, verdicts, takeover: false };
          }
          emit(errorEvent(`worker could not produce a valid CompletionReport: ${String(error)}`, error));
          return runTakeover("worker artifact failure; leader takeover");
        }
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
        (previousError) =>
          options.agents.review({
            plan,
            report,
            round: currentRound,
            diff,
            previousAttemptError: previousError === undefined ? undefined : previousAttemptMessage(previousError)
          }),
        (value) => ReviewVerdictSchema.parse(value)
      );
    } catch (error) {
      // D66-2: rate-limit errors should not be mis-reported as "review could not be finalized";
      // surface the resetsAt so the user knows when to retry.
      if (error instanceof Error && error.name === "RateLimitError") {
        const message = `Leader review is rate-limited: ${(error as { resetsAt?: string }).resetsAt ?? "unknown reset time"}. Try again after that time or switch engines.`;
        emit({ type: "error", message });
        transition("DONE", message, currentRound);
        return { phase: "DONE", summary: message, plan, reports, verdicts, takeover: false };
      }
      const summary = `Build completed, but automated review could not be finalized after retries. Last worker report: ${report.summary}`;
      emit(errorEvent(`leader review could not produce a valid ReviewVerdict: ${String(error)}`, error));
      transition("DONE", "leader review failed; build report preserved", currentRound);
      return { phase: "DONE", summary, plan, reports, verdicts, takeover: false };
    }
    verdicts.push(verdict);
    emitCheckpoint();

    if (verdict.verdict === "takeover" || report.status === "blocked") {
      return runTakeover(report.status === "blocked" ? "worker blocked; leader takeover" : "leader requested takeover");
    }

    if (verdict.verdict === "approve") {
      await options.removeSessionNotesByPrefix?.("Review round ");
      transition("DONE", "leader review approved", currentRound);
      return { phase: "DONE", summary: verdict.userSummary, plan, reports, verdicts, takeover: false };
    }

    feedback = verdict.feedback;
    allFeedback.push(feedback);
    if (feedback.length > 0) {
      const issues = feedback.map((item) => [item.issue, item.location, item.requiredChange].filter(Boolean).join(" - ")).join("; ");
      await options.addSessionNote?.(`Review round ${currentRound} open issues: ${issues}`, "system");
    }
    transition("FEEDBACK", `leader review requested ${feedback.length} change(s)`, currentRound);
    phase = "BUILDING";
  }

  return runTakeover("round limit exhausted; leader takeover");
}
