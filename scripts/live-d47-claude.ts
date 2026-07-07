// D47 / D49 live verification harness for Claude Code CLI.
//
// Invokes the real Claude Code CLI with the exact prompt bytes Tandem's production
// code produces, and verifies the response includes a schema-conformant
// structured_output (not empty/acknowledgment/etc).
//
// Stability rules learned across D42-D49:
//   - use locateClaudeCli() (the same path Tandem uses at runtime) instead of bare
//     `execa("claude", ...)` so the Windows .cmd shim can never get in the way
//   - run the worker scenario in a fresh mkdtemp, not a fixed path
//   - always print raw stdout for at least leader-question and worker-build so
//     the reviewer can verify the success without trusting a derived assertion

import dotenv from "dotenv";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { buildClaudeLeaderPlanPrompts } from "../src/agents/claude-code-cli/leader.js";
import { buildClaudeWorkerPrompts } from "../src/agents/claude-code-cli/worker.js";
import { locateClaudeCli } from "../src/agents/claude-code-cli/locate.js";
import { jsonSchemaFor } from "../src/agents/codex-cli/schema-json.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";
import { execa } from "execa";

const MODEL = "haiku";
const SCHEMAS = {
  "plan-or-answer": "plan-or-answer",
  "review-verdict": "review-verdict",
  takeover: "takeover",
  "completion-report": "completion-report"
} as const;
type SchemaName = keyof typeof SCHEMAS;

async function main(): Promise<void> {
  let failed = false;
  const claudePath = locateClaudeCli({ env: process.env });
  if (!claudePath) {
    console.error("locateClaudeCli returned undefined; aborting.");
    return;
  }
  console.log(`Using claude binary: ${claudePath}`);
  // Sanity log so future readers can tell which executable the harness is exercising.
  const versionResult = await execa(claudePath, ["--version"], { reject: false, windowsHide: true, stdin: "ignore" });
  console.log(`claude --version: ${versionResult.stdout.trim() || versionResult.stderr.trim()}`);

  const options = {
    env: process.env,
    projectInstructions: async () => "Project instructions:\n- Be concise."
  };

  console.log("\n=== D47 ACCEPTANCE SCENARIO 1: leader direct question ===");
  const planPrompts = await buildClaudeLeaderPlanPrompts(options, { request: "What is 9 times 9? Reply with only the number.", goals: [], history: "" });
  console.log("USER PROMPT bytes:\n" + JSON.stringify(planPrompts.prompt));
  console.log("---");
  const result1 = await invoke(claudePath, planPrompts, "plan-or-answer", MODEL, "plan", process.cwd());
  console.log("RAW STDOUT:", result1.raw);
  console.log("structured_output:", JSON.stringify(result1.structured_output, null, 2));
  if (!isLeaderQuestionSuccess(result1.structured_output)) {
    console.error("Leader direct-question scenario did not return structured_output.kind=\"question\" with answer=\"81\".");
    failed = true;
  }

  console.log("\n=== D47 ACCEPTANCE SCENARIO 2: worker build with verbatim verification echo (mkdtemp dir) ===");
  const workerCwd = await mkdtemp(path.join(os.tmpdir(), "tandem-d47-"));
  console.log(`worker cwd: ${workerCwd}`);
  const plan: BuildPlan = {
    title: "Add README",
    objective: "Create README.md containing 'tandem-smoke'.",
    constraints: [],
    tasks: [{ id: "T1", description: "Write README.md with the literal text 'tandem-smoke'.", files: ["README.md"] }],
    acceptanceCriteria: ["README.md exists at repo root.", "README.md contains 'tandem-smoke'."],
    verification: ["node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(1);if(!fs.readFileSync('README.md','utf8').includes('tandem-smoke'))process.exit(1);console.log('ok')\""]
  };
  const workerPrompts = await buildClaudeWorkerPrompts(options, { plan, round: 1, feedback: [] });
  console.log("USER PROMPT (raw):\n" + JSON.stringify(workerPrompts.prompt));
  console.log("---");
  const result3 = await invoke(claudePath, workerPrompts, "completion-report", MODEL, "bypassPermissions", workerCwd);
  console.log("RAW STDOUT:", result3.raw);
  console.log("structured_output:", JSON.stringify(result3.structured_output, null, 2));
  if (!isWorkerBuildSuccess(result3.structured_output, plan.verification[0])) {
    console.error("Worker build scenario did not return a complete CompletionReport with the expected passing verification command.");
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLeaderQuestionSuccess(value: unknown): boolean {
  return isRecord(value) && value.kind === "question" && value.answer === "81";
}

function isWorkerBuildSuccess(value: unknown, expectedCommand: string): boolean {
  if (!isRecord(value) || value.status !== "complete" || !Array.isArray(value.verificationResults)) return false;
  return value.verificationResults.some((result) => isRecord(result) && result.command === expectedCommand && result.passed === true);
}

async function invoke(
  claudePath: string,
  prompts: { systemPrompt: string; prompt: string },
  schema: SchemaName,
  model: string,
  permissionMode: string = "plan",
  cwd: string | undefined = undefined
): Promise<{ structured_output: unknown; raw: string }> {
  const argv = [
    "-p", prompts.prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchemaFor(SCHEMAS[schema])),
    "--permission-mode", permissionMode,
    "--no-session-persistence",
    "--system-prompt", prompts.systemPrompt,
    "--model", model
  ];
  const res = await execa(claudePath, argv, {
    stdin: "ignore",
    reject: false,
    timeout: 300000,
    env: process.env,
    cwd
  }).catch((e: unknown) => ({ stdout: "", exitCode: -1, stderr: String(e) } as { stdout: string; exitCode: number; stderr: string }));
  if (res.exitCode !== 0) {
    return { structured_output: undefined, raw: res.stdout || res.stderr };
  }
  const env = JSON.parse(res.stdout);
  return { structured_output: env.structured_output, raw: res.stdout };
}

await main();
