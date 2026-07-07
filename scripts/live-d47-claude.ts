// Live test for D47: directly invokes the real `claude` CLI with the exact prompt bytes
// the production Tandem code produces, and verifies the response includes a schema-conformant
// structured_output (not empty/acknowledgment/etc).

import dotenv from "dotenv";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { buildClaudeLeaderPlanPrompts } from "../src/agents/claude-code-cli/leader.js";
import { locateClaudeCli } from "../src/agents/claude-code-cli/locate.js";
import { buildClaudeWorkerPrompts } from "../src/agents/claude-code-cli/worker.js";
import { jsonSchemaFor } from "../src/agents/codex-cli/schema-json.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";
import { execa } from "execa";

async function main(): Promise<void> {
  const options = {
    env: process.env,
    projectInstructions: async () => "Project instructions:\n- Be concise."
  };

  console.log("=== D47 ACCEPTANCE SCENARIO 1: leader direct question ===");
  const planPrompts = await buildClaudeLeaderPlanPrompts(options, { request: "What is 9 times 9? Reply with only the number.", goals: [], history: "" });
  console.log("USER PROMPT bytes:\n" + JSON.stringify(planPrompts.prompt));
  console.log("---");
  const result1 = await invoke(planPrompts, "plan-or-answer", "haiku", "plan", process.cwd());
  console.log("RAW STDOUT:", result1.raw);
  console.log("structured_output:", JSON.stringify(result1.structured_output, null, 2));
  if (!result1.structured_output) {
    console.log("RAW STDOUT (first 1500 chars):", result1.raw.slice(0, 1500));
  }

  console.log("\n=== D47 ACCEPTANCE SCENARIO 2: worker build with verbatim verification echo ===");
  const plan: BuildPlan = {
    title: "Add README and verify it",
    objective: "Create README.md containing 'tandem-smoke' and verify it exists",
    constraints: [],
    tasks: [{ id: "T1", description: "Write README.md with the literal text 'tandem-smoke'.", files: ["README.md"] }],
    acceptanceCriteria: ["README.md exists at repo root", "README.md contains the literal text 'tandem-smoke'."],
    verification: ["node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(1);if(!fs.readFileSync('README.md','utf8').includes('tandem-smoke'))process.exit(1);console.log('ok')\""]
  };
  const workerPrompts = await buildClaudeWorkerPrompts(options, { plan, round: 1, feedback: [] });
  console.log("USER PROMPT (first 400 chars):\n" + workerPrompts.prompt.slice(0, 400));
  console.log("---");
  const workerCwd = await mkdtemp(path.join(os.tmpdir(), "tandem-d47-"));
  const result3 = await invoke(workerPrompts, "completion-report", "haiku", "bypassPermissions", workerCwd);
  console.log("RAW STDOUT:", result3.raw);
  console.log("structured_output:", JSON.stringify(result3.structured_output, null, 2));
  if (!result3.structured_output) {
    console.log("RAW STDOUT (first 1500 chars):", result3.raw.slice(0, 1500));
  }
}

async function invoke(prompts: { systemPrompt: string; prompt: string }, schema: "plan-or-answer" | "review-verdict" | "takeover" | "completion-report", model: string, permissionMode: string = "plan", cwd: string): Promise<{ structured_output: unknown; raw: string }> {
  const claudePath = locateClaudeCli({ env: process.env });
  if (!claudePath) throw new Error("Claude Code CLI not found.");
  const argv = [
    "-p", prompts.prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchemaFor(schema)),
    "--permission-mode", permissionMode,
    "--no-session-persistence",
    "--system-prompt", prompts.systemPrompt,
    "--model", model
  ];
  const res = await execa(claudePath, argv, {
    cwd,
    stdin: "ignore",
    reject: false,
    timeout: 180000,
    env: process.env
  }).catch((e: unknown) => ({ stdout: "", exitCode: -1, stderr: String(e) } as { stdout: string; exitCode: number; stderr: string }));
  if (res.exitCode !== 0) {
    return { structured_output: undefined, raw: res.stdout || res.stderr };
  }
  const env = JSON.parse(res.stdout);
  return { structured_output: env.structured_output, raw: res.stdout };
}

await main();
