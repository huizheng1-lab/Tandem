// Live harness for prompt-shape verification. Uses MiniMax M3 as the model so the
// harness is not blocked by the Anthropic quota. The user prompt bytes generated
// here come straight from Tandem's production prompt builders; only the model
// is swapped (M3 satisfies the same JSON-schema output contract as Claude via
// @ai-sdk/openai-compatible).

import dotenv from "dotenv";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { buildClaudeLeaderPlanPrompts, buildClaudeLeaderReviewPrompts, buildClaudeLeaderTakeoverPrompts } from "../src/agents/claude-code-cli/leader.js";
import { buildClaudeWorkerPrompts } from "../src/agents/claude-code-cli/worker.js";
import { jsonSchemaFor } from "../src/agents/codex-cli/schema-json.js";
import type { BuildPlan, CompletionReport } from "../src/orchestrator/artifacts.js";

const MODEL = process.env.D49_MODEL ?? "MiniMax-M3";
const BASE_URL = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1";

const SCHEMAS = {
  "plan-or-answer": "plan-or-answer",
  "review-verdict": "review-verdict",
  takeover: "takeover",
  "completion-report": "completion-report"
} as const;
type SchemaName = keyof typeof SCHEMAS;

function makeModel() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY missing from env");
  return createOpenAICompatible({ name: "minimax", apiKey, baseURL: BASE_URL })(MODEL);
}

async function invokeOnce(
  prompts: { systemPrompt: string; prompt: string },
  schema: SchemaName
): Promise<{ structured_output: unknown; raw: string }> {
  const model = makeModel();
  const schemaObj = jsonSchemaFor(SCHEMAS[schema]);
  const systemWithSchema = `${prompts.systemPrompt}\n\nReturn ONLY a JSON object matching this schema:\n${JSON.stringify(schemaObj)}\nNo prose, no markdown, no code fences.`;
  const result = await generateText({
    model,
    system: systemWithSchema,
    prompt: prompts.prompt,
    experimental_providerMetadata: undefined
  });
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: result.text,
    structured_output: safeParseFirst(result.text),
    usage: result.usage,
    providerMetadata: result.providerMetadata
  };
  return { structured_output: envelope.structured_output, raw: JSON.stringify(envelope, null, 2) };
}

function safeParseFirst(text: string): unknown {
  try {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidate = fenced ? fenced[1].trim() : text.trim();
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return undefined;
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log(`Using model: ${MODEL} (baseURL: ${BASE_URL})`);
  const options = {
    env: process.env,
    projectInstructions: async () => "Project instructions:\n- Be concise."
  };

  console.log("\n=== D49 ACCEPTANCE SCENARIO 1: leader direct question ===");
  const planPrompts = await buildClaudeLeaderPlanPrompts(options, { request: "What is 9 times 9? Reply with only the number.", goals: [], history: "" });
  console.log("USER PROMPT bytes:\n" + JSON.stringify(planPrompts.prompt));
  console.log("---");
  const result1 = await invokeOnce(planPrompts, "plan-or-answer");
  console.log("RAW ENVELOPE:");
  console.log(result1.raw);
  console.log("structured_output:", JSON.stringify(result1.structured_output, null, 2));

  console.log("\n=== D49 ACCEPTANCE SCENARIO 2: worker build with verbatim verification echo (mkdtemp dir) ===");
  const workerCwd = await mkdtemp(path.join(os.tmpdir(), "tandem-d49-"));
  console.log(`worker cwd: ${workerCwd}`);
  const plan: BuildPlan = {
    title: "Add README",
    objective: "Create README.md containing 'tandem-smoke'.",
    constraints: [],
    tasks: [{ id: "T1", description: "Write README.md with the literal text 'tandem-smoke'.", files: ["README.md"] }],
    acceptanceCriteria: ["README.md exists at repo root.", "README.md contains 'tandem-smoke'."],
    verification: ["node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(1);if(!fs.readFileSync('README.md','utf8').includes('tandem-smoke'))process.exit(1);console.log('ok')\""]
  };
  // The worker harness is a stub: the worker model is invoked with the production
  // worker prompt bytes, but the worker DOES NOT execute shell in this script -
  // we only verify the prompt shape and that M3 returns a schema-conformant
  // completion-report envelope with status=complete and the verbatim verification
  // command echoed in the verificationResults[].command field.
  const workerPrompts = await buildClaudeWorkerPrompts(options, { plan, round: 1, feedback: [] });
  console.log("USER PROMPT (raw):\n" + JSON.stringify(workerPrompts.prompt));
  console.log("---");
  const result3 = await invokeOnce(workerPrompts, "completion-report");
  console.log("RAW ENVELOPE:");
  console.log(result3.raw);
  console.log("structured_output:", JSON.stringify(result3.structured_output, null, 2));

  // Also write the README so the verification semantics are testable.
  await writeFile(path.join(workerCwd, "README.md"), "tandem-smoke live verification", "utf8");
  console.log(`\nWrote README.md to ${workerCwd} for completeness.`);
}

await main();
