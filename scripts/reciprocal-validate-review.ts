import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createLiveAgents } from "../src/agents/live.js";
import { loadConfig, loadEnv } from "../src/config/load.js";
import { BuildPlanSchema, CompletionReportSchema } from "../src/orchestrator/artifacts.js";
import { withConfiguredCliModel } from "../src/providers/cli-models.js";
import { resolveModel } from "../src/providers/registry.js";
import { formatProjectInstructions, readProjectInstructions } from "../src/session/project-memory.js";
import { CostLedger } from "../src/session/cost.js";

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  const array = Array.isArray(value) ? value : [value];
  return array.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

const StringArray = z.preprocess(asArray, z.array(z.string()));
const PlanTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  files: StringArray.optional(),
  stream: z.string().optional()
});
const CompletionTaskResultSchema = z.object({
  id: z.string(),
  status: z.enum(["done", "partial", "skipped"]),
  notes: z.string().optional()
});
const VerificationResultSchema = z.object({
  command: z.string(),
  passed: z.boolean(),
  output: z.string()
});

const LooseBuildPlanSchema = z.object({
  title: z.string(),
  objective: z.string(),
  constraints: StringArray,
  tasks: z.preprocess(asArray, z.array(PlanTaskSchema)),
  acceptanceCriteria: StringArray,
  verification: StringArray,
  streamVerification: z.record(z.string(), StringArray).optional()
}).transform((value) => BuildPlanSchema.parse(value));

const LooseCompletionReportSchema = z.object({
  status: z.enum(["complete", "blocked"]),
  summary: z.string(),
  taskResults: z.preprocess(asArray, z.array(CompletionTaskResultSchema)),
  filesChanged: StringArray,
  verificationResults: z.preprocess(asArray, z.array(VerificationResultSchema)),
  deviationsFromPlan: StringArray
}).transform((value) => CompletionReportSchema.parse(value));

const PayloadSchema = z.object({
  cwd: z.string().min(1),
  round: z.number().int().positive(),
  tandemHome: z.string().optional().nullable(),
  plan: LooseBuildPlanSchema,
  report: LooseCompletionReportSchema,
  diff: z.string()
});

function inputPath(argv: string[]): string {
  const index = argv.indexOf("--input");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("Usage: tsx scripts/reciprocal-validate-review.ts --input <payload.json>");
  return value;
}

async function main(): Promise<void> {
  const rawPayload = (await readFile(inputPath(process.argv.slice(2)), "utf8")).replace(/^\uFEFF/, "");
  const payload = PayloadSchema.parse(JSON.parse(rawPayload));
  const env = { ...process.env };
  if (payload.tandemHome?.trim()) env.TANDEM_HOME = payload.tandemHome.trim();
  loadEnv(payload.cwd, undefined, env);
  const config = loadConfig({ cwd: payload.cwd, env });
  const leader = withConfiguredCliModel(resolveModel(config.leader, config.customModels), config);
  const ledger = new CostLedger();
  const agents = await createLiveAgents({
    config,
    cwd: payload.cwd,
    env,
    ledger,
    projectInstructions: async () => formatProjectInstructions(await readProjectInstructions(payload.cwd)),
    confirmCodexWrite: async () => true
  });
  const verdict = await agents.review({
    plan: payload.plan,
    report: payload.report,
    round: payload.round,
    diff: payload.diff
  });
  const cost = ledger.totals();
  process.stdout.write(`${JSON.stringify({
    verdict,
    cost,
    totalDollars: ledger.totalDollars(),
    source: `AgentFns.review leader=${config.leader} provider=${leader.provider} model=${leader.modelName || leader.id}`
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
