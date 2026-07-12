import { z } from "zod";
import { resolveOnPath } from "../tools/resolve-on-path.js";
import { sanitizePromptValue } from "../tools/sanitize.js";

export const BuildPlanSchema = z.object({
  title: z.string(),
  objective: z.string(),
  constraints: z.array(z.string()),
  tasks: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      files: z.array(z.string()).optional(),
      // D54: optional stream label. Tasks sharing a `stream` run in the same worker; tasks
      // with no stream label share an implicit default stream ("__default__"). A plan where
      // every task has no stream (or all share one label) is a single-stream plan - exactly
      // today's behavior, same code path.
      stream: z.string().optional()
    })
  ),
  acceptanceCriteria: z.array(z.string()),
  verification: z.array(z.string()),
  // D54: optional per-stream verification subset. Each worker runs only its own stream's
  // commands (verbatim-echo contract). The full plan-level verification is run by the leader
  // during review. Single-stream plans ignore this map (the worker runs plan.verification).
  streamVerification: z.record(z.string(), z.array(z.string())).optional()
});
export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type PlanStreamId = string;
// D54: implicit stream id for tasks that don't declare one.
export const DEFAULT_STREAM_ID = "__default__";

// D57-2: small explicit allowlist of SHELL BUILT-INS that don't resolve via PATH lookup
// (they're interpreter internals, not separate executables). This list must stay tiny and
// only grow for genuine built-ins, not general tools - the primary signal is now PATH
// resolution (D57-3), and the D55-2 shape heuristic is the fallback for tools that aren't
// installed on the validation machine but might be on the execution machine.
const shellBuiltIns = new Set([
  "cd",
  "echo",
  "exit",
  "set",
  "export",
  "unset",
  "read",
  "true",
  "false",
  "test",
  "[",
  "pwd",
  "pushd",
  "popd",
  "if",
  "then",
  "else",
  "fi",
  "do",
  "done",
  "for",
  "while",
  "case",
  "function",
  "return",
  "type", // shell builtin on POSIX; on win32 it's an executable
  "where", // win32 builtin equivalent
  "dir" // bash builtin on most shells; win32 cmd.exe builtin
]);
// Windows shell built-ins (cmd.exe + PowerShell). These are interpreter-internal, not
// separate files. They bypass the PATH-resolution primary signal.
const windowsShellBuiltIns = new Set([
  "dir",
  "findstr",
  "where",
  "type",
  "cd",
  "dir",
  "copy",
  "move",
  "del",
  "ren",
  "echo",
  "set",
  "if",
  "for",
  "goto",
  "call",
  "exit",
  "pushd",
  "popd",
  "start",
  "cls",
  "powershell",
  "pwsh"
]);

const windowsPosixAlternatives: Record<string, string> = {
  cat: "use `type <file>` or PowerShell `Get-Content <file>`",
  grep: "use `findstr` or PowerShell `Select-String`",
  ls: "use `dir` or PowerShell `Get-ChildItem`",
  touch: "use PowerShell `New-Item` or `Set-Content`",
  rm: "use `del`/`rmdir` or PowerShell `Remove-Item`",
  sed: "use `node -e` or PowerShell text processing",
  awk: "use `node -e` or PowerShell text processing",
  head: "use PowerShell `Select-Object -First`",
  tail: "use PowerShell `Select-Object -Last`",
  chmod: "avoid chmod on Windows; use a platform-appropriate command"
};

export const CompletionReportSchema = z.object({
  status: z.enum(["complete", "blocked"]),
  summary: z.string(),
  taskResults: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["done", "partial", "skipped"]),
      notes: z.string().optional()
    })
  ),
  filesChanged: z.array(z.string()),
  verificationResults: z.array(
    z.object({
      command: z.string(),
      passed: z.boolean(),
      output: z.string()
    })
  ),
  deviationsFromPlan: z.array(z.string())
});
export type CompletionReport = z.infer<typeof CompletionReportSchema>;

export const ReviewVerdictSchema = z
  .object({
    verdict: z.enum(["approve", "revise", "takeover"]),
    scores: z.object({
      correctness: z.number().min(1).max(5),
      planAdherence: z.number().min(1).max(5),
      codeQuality: z.number().min(1).max(5)
    }),
    feedback: z.array(
      z.object({
        issue: z.string(),
        location: z.string().optional(),
        requiredChange: z.string()
      })
    ),
    userSummary: z.string()
  })
  .superRefine((value, ctx) => {
    if (value.verdict !== "approve") return;
    const lowScore = Object.entries(value.scores).find(([, score]) => score <= 2);
    if (!lowScore) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scores", lowScore[0]],
      message: "approve verdict requires scores above 2; low scores indicate revise or takeover"
    });
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewFeedback = ReviewVerdict["feedback"];

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function commandToken(segment: string): string {
  const match = segment.trim().match(/^["']?([^\s"'`]+)["']?/);
  return match?.[1]?.toLowerCase() ?? "";
}

function verificationSegments(command: string): string[] {
  return command.split(/\|\||&&|[|;]/g).map((part) => part.trim()).filter(Boolean);
}

// D57-3: tests whether `entry` looks like a real shell command invocation rather than prose.
// Primary signal: the first token resolves to a real executable on PATH - that's what Claude
// Code does, and it's the authoritative signal that can't have a "some legitimate tool I forgot
// to list" false-rejection class. Falls back to:
//   - a shell built-in (built into the interpreter, no separate PATH entry)
//   - a leading path (`./foo`, `C:\foo`, `/foo`, `~/foo`)
//   - a script filename matching common interpreter extensions
//   - the D55-2 shape heuristic (bare executable + flag/path indicators) for tools that may
//     not be installed on the validation machine but are on the execution machine (D57-3
//     fallback per the handoff).
async function hasCommandShape(
  entry: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const first = commandToken(trimmed);
  if (!first) return false;
  // Primary: real PATH resolution. Use the actual env's path separator (path.delimiter) -
  // tests can pass a custom env that matches the platform parameter. This handles the case
  // where the test platform label and the env's separator differ.
  const pathSep = (env.PATH ?? env.Path ?? env.path ?? "").includes(";") ? ";" : ":";
  const names = platform === "win32" ? [`${first}.exe`, `${first}.cmd`, `${first}.bat`, first] : [first];
  if (resolveOnPath({ token: first, names, env, pathSeparator: pathSep })) return true;
  // Fallback: shell built-in (interpreter-internal, no PATH entry).
  if (shellBuiltIns.has(first)) return true;
  if (platform === "win32" && windowsShellBuiltIns.has(first)) return true;
  // Fallback: leading path or script filename.
  if (/^(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(trimmed)) return true;
  if (/^[\w.-]+\.(?:cmd|bat|ps1|mjs|cjs|js|ts|py|sh|exe)\b/i.test(trimmed)) return true;
  // Final fallback (D55-2): bare executable + flag/path indicators. Lets through commands for
  // tools installed on the execution machine but not the validation machine (e.g. task 1 of
  // a plan installs a CLI; task 2's verification runs it).
  if (/^[A-Za-z][\w.-]*$/.test(first)) {
    const afterFirst = trimmed.slice(first.length).trimStart();
    const secondTokenMatch = afterFirst.match(/^["']?([^\s"'`]+)/);
    const second = secondTokenMatch?.[1] ?? "";
    if (/^-{1,2}[\w-]+/.test(second)) return true;
    if (/[./\\]/.test(afterFirst)) return true;
  }
  return false;
}

async function validateVerificationEntry(entry: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const errors: string[] = [];
  const normalized = normalizeCommand(entry);
  if (!normalized) return ["verification entry is empty"];
  if (platform === "win32") {
    const posixTools = [...new Set(verificationSegments(normalized)
      .map(commandToken)
      .filter((token) => token in windowsPosixAlternatives))];
    for (const posix of posixTools) {
      errors.push(`verification command "${entry}" uses POSIX-only tool \`${posix}\` on Windows; ${windowsPosixAlternatives[posix]}.`);
    }
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasPathFlagOrShellChars = /[./\\:-]|--?|[|&><]/.test(normalized);
  const shapeOk = await hasCommandShape(normalized, platform, env);
  if (!shapeOk || (wordCount > 6 && !hasPathFlagOrShellChars)) {
    errors.push(`verification entry "${entry}" does not look like a runnable shell command; move manual checks to acceptanceCriteria and use commands such as \`npm test\`, \`node test.mjs\`, or \`type launch.bat\`.`);
  }
  return errors;
}

// D54: partition tasks into streams. Tasks without a `stream` label share the implicit default
// stream id. Returns streams in a stable order: explicit labels first in first-seen order,
// then the default stream last if it has any tasks. Within each stream, tasks keep their
// original order.
export interface PlanStream {
  id: PlanStreamId;
  tasks: BuildPlan["tasks"];
  verification: string[];
}

export function partitionPlan(plan: BuildPlan): PlanStream[] {
  const byId = new Map<PlanStreamId, BuildPlan["tasks"]>();
  const order: PlanStreamId[] = [];
  for (const task of plan.tasks) {
    const id = (task.stream ?? DEFAULT_STREAM_ID) as PlanStreamId;
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(task);
  }
  // Default stream last for predictability.
  const defaultIdx = order.indexOf(DEFAULT_STREAM_ID);
  if (defaultIdx >= 0) {
    order.splice(defaultIdx, 1);
    order.push(DEFAULT_STREAM_ID);
  }
  const streamVerification = plan.streamVerification ?? {};
  return order.map((id) => ({
    id,
    tasks: byId.get(id) ?? [],
    verification: id === DEFAULT_STREAM_ID ? plan.verification : (streamVerification[id] ?? plan.verification)
  }));
}

// D54: disjoint-files check across streams. Every task in a multi-stream plan MUST list
// `files`; no file path may appear in tasks of two different streams. Two workers writing the
// same file concurrently in the same cwd is the failure mode to prevent. Overlapping reads
// are fine and unenforceable; we only gate on declared write-ownership lists.
export function validateStreamFileOwnership(plan: BuildPlan): string[] {
  const streams = partitionPlan(plan);
  if (streams.length < 2) return [];
  const errors: string[] = [];
  for (const stream of streams) {
    for (const task of stream.tasks) {
      if (!task.files || task.files.length === 0) {
        errors.push(
          `Task "${task.id}" in stream "${stream.id}" must list its files when the plan has multiple streams (disjoint-files invariant).`
        );
      }
    }
  }
  const ownerByFile = new Map<string, string>();
  for (const stream of streams) {
    for (const task of stream.tasks) {
      for (const file of task.files ?? []) {
        const prev = ownerByFile.get(file);
        if (prev && prev !== stream.id) {
          errors.push(
            `File "${file}" is declared by both stream "${prev}" and stream "${stream.id}" (task "${task.id}"). Streams must have disjoint file write-ownership.`
          );
        } else {
          ownerByFile.set(file, stream.id);
        }
      }
    }
  }
  return errors;
}

export async function validateBuildPlan(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<BuildPlan> {
  const plan = sanitizePromptValue(BuildPlanSchema.parse(value));
  if (plan.tasks.length === 0) throw new Error("no implementation tasks - answer directly instead");
  const errors: string[] = [];
  const verifResults = await Promise.all(
    plan.verification.map((entry) => validateVerificationEntry(entry, platform, env))
  );
  errors.push(...verifResults.flat());
  errors.push(...validateStreamFileOwnership(plan));
  if (errors.length > 0) throw new Error(`Invalid BuildPlan:\n${errors.join("\n")}`);
  return plan;
}

function matchResult(planEntry: string, results: CompletionReport["verificationResults"]) {
  const entry = normalizeCommand(planEntry);
  return results.find((result) => {
    const command = normalizeCommand(result.command);
    return command.length > 0 && (command === entry || looselyEquivalentCommand(command, entry));
  });
}

function looseCommand(value: string): string {
  return normalizeCommand(value)
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\\(["'])/g, "$1")
    .replace(/(["'])/g, "")
    .replace(/\s*;\s*/g, ";")
    .replace(/\s*,\s*/g, ",")
    .toLowerCase();
}

function commandTokens(value: string): Set<string> {
  return new Set(
    looseCommand(value)
      .split(/[^a-z0-9_.:\\/-]+/i)
      .filter((token) => token.length >= 4)
  );
}

function looselyEquivalentCommand(command: string, entry: string): boolean {
  if (command.length < 200 && entry.length < 200) return false;
  const left = looseCommand(command);
  const right = looseCommand(entry);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = commandTokens(command);
  const rightTokens = commandTokens(entry);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const overlap = [...rightTokens].filter((token) => leftTokens.has(token)).length;
  return overlap / rightTokens.size >= 0.9 && overlap / leftTokens.size >= 0.9;
}

// Extracts basenames of files referenced by a verification command string. Handles the most
// common shapes: `node verify-video.js`, `python tests/check.py`, `bash ./scripts/run.sh`,
// `path\to\verify.cmd`, quoted or unquoted. Falls back to [] for commands that don't reference
// any file (e.g. `npm test`, `ffprobe foo.mp4` - the latter references the input media, not a script).
const SCRIPT_EXTENSION = /\.(?:js|mjs|cjs|ts|py|sh|cmd|bat|ps1|exe)\b/i;
function extractReferencedScriptBasenames(commands: string[]): Set<string> {
  const basenames = new Set<string>();
  // Match either an extension-suffixed token (path or bare filename) anywhere in the command.
  for (const cmd of commands) {
    const tokens = cmd.split(/\s+/);
    for (const token of tokens) {
      const cleaned = token.replace(/^["']|["']$/g, "");
      if (SCRIPT_EXTENSION.test(cleaned)) {
        const basename = cleaned.split(/[\\/]/).pop() ?? cleaned;
        basenames.add(basename.toLowerCase());
      }
    }
  }
  return basenames;
}

// D56-2: detects the failure mode where a worker/takeover edits a script that's used by one of
// the plan's verification commands, then reports all-passing without disclosing the change.
// Mechanical check: if a verification-referenced file appears in `filesChanged`, the report's
// `deviationsFromPlan` array MUST mention it. This is the smallest reliable mitigation; a stronger
// solution would snapshot the script and re-run verification, but that's a bigger architecture
// change flagged in the handoff's "Consider" block, not built here.
function detectVerificationScriptTampering(plan: BuildPlan, report: CompletionReport): string[] {
  const referenced = extractReferencedScriptBasenames(plan.verification);
  if (referenced.size === 0) return [];
  const expectedBasenames = new Set(
    plan.tasks
      .flatMap((task) => task.files ?? [])
      .map((file) => (file.split(/[\\/]/).pop() ?? file).toLowerCase())
      .filter((name) => name.length > 0)
  );
  const changedBasenames = new Set(
    report.filesChanged
      .map((file) => (file.split(/[\\/]/).pop() ?? file).toLowerCase())
      .filter((name) => name.length > 0)
  );
  const missing: string[] = [];
  for (const ref of referenced) {
    if (expectedBasenames.has(ref)) continue;
    if (changedBasenames.has(ref)) {
      const mentioned = report.deviationsFromPlan.some((entry) => entry.toLowerCase().includes(ref));
      if (!mentioned) missing.push(ref);
    }
  }
  return missing;
}

export function enforceVerification(
  plan: BuildPlan,
  report: CompletionReport,
  expectedCommands: string[] = plan.verification,
  options: { enforceCommandEcho?: boolean; enforceCompleteVerification?: boolean } = {}
): void {
  const enforceCommandEcho = options.enforceCommandEcho ?? true;
  const enforceCompleteVerification = options.enforceCompleteVerification ?? true;
  // D54: the orchestrator passes a stream-scoped subset of plan.verification when validating
  // per-stream worker reports. Single-stream plans and the merged-after-merge check still pass
  // the full plan.verification (the default).
  if (enforceCommandEcho) {
    const missing = expectedCommands.filter((entry) => !matchResult(entry, report.verificationResults));
    if (missing.length > 0) {
      throw new Error(`Completion report omitted verification commands: ${missing.join(", ")}${verificationReportDiagnostic(report.verificationResults)}`);
    }
  }
  if (enforceCompleteVerification) {
    const failed = expectedCommands.filter((entry) => matchResult(entry, report.verificationResults)?.passed !== true);
    if (failed.length > 0 && report.status === "complete") {
      throw new Error(`Completion report marked complete with failing verification: ${failed.join(", ")}`);
    }
  }
  // D56-2: if a worker/takeover edited a script that's referenced by the plan's verification
  // commands, the change MUST be declared in `deviationsFromPlan`. Otherwise the worker
  // effectively gets to write its own passing grade.
  const tampered = detectVerificationScriptTampering(plan, report);
  if (tampered.length > 0) {
    throw new Error(
      `Verification script edited without disclosure: ${tampered.join(", ")}. ` +
        "Add an entry to deviationsFromPlan for each edited script before resubmitting."
    );
  }
}

function truncateDiagnostic(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}... (${normalized.length} chars)`;
}

function verificationReportDiagnostic(results: CompletionReport["verificationResults"]): string {
  if (results.length === 0) return "\nReported verification commands: none";
  return `\nReported verification commands:\n${results.map((result, index) => `${index + 1}. ${truncateDiagnostic(result.command)} [passed=${result.passed}]`).join("\n")}`;
}

export function validateCompletionReport(
  plan: BuildPlan,
  value: unknown,
  expectedCommands: string[] = plan.verification,
  options?: { enforceCommandEcho?: boolean; enforceCompleteVerification?: boolean }
): CompletionReport {
  const report = sanitizePromptValue(CompletionReportSchema.parse(value));
  enforceVerification(plan, report, expectedCommands, options);
  return report;
}

// D54: merge N per-stream CompletionReports into one synthetic round report. The orchestrator
// runs one worker per stream, collects N reports, and calls this. Status is "complete" only
// when every stream is "complete"; any blocked stream flips the merged report to "blocked".
// taskResults are concatenated - every plan task must appear exactly once across streams
// (caller should validate the partition). filesChanged / verificationResults /
// deviationsFromPlan are unioned. summary is joined per-stream, prefixed with the stream id.
export function mergeCompletionReports(
  reports: { streamId: PlanStreamId; report: CompletionReport }[]
): CompletionReport {
  if (reports.length === 0) {
    throw new Error("mergeCompletionReports: at least one per-stream report is required");
  }
  const allTaskResults = reports.flatMap((entry) => entry.report.taskResults);
  const allTaskIds = new Set(allTaskResults.map((r) => r.id));
  if (allTaskIds.size !== allTaskResults.length) {
    const ids = allTaskResults.map((r) => r.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new Error(`mergeCompletionReports: duplicate task result ids across streams: ${[...new Set(dupes)].join(", ")}`);
  }
  const seen = new Set<string>();
  const filesChanged: string[] = [];
  for (const entry of reports) {
    for (const file of entry.report.filesChanged) {
      if (!seen.has(file)) {
        seen.add(file);
        filesChanged.push(file);
      }
    }
  }
  const verificationResults: CompletionReport["verificationResults"] = reports.flatMap(
    (entry) => entry.report.verificationResults
  );
  const deviationsFromPlan: string[] = reports.flatMap((entry) => entry.report.deviationsFromPlan);
  const status: CompletionReport["status"] = reports.every((entry) => entry.report.status === "complete")
    ? "complete"
    : "blocked";
  const summary = reports
    .map((entry) => `[${entry.streamId}] ${entry.report.summary}`.trim())
    .join(" | ");
  return {
    status,
    summary,
    taskResults: allTaskResults,
    filesChanged,
    verificationResults,
    deviationsFromPlan
  };
}
