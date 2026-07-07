import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type CodexSchemaKind = "build-plan" | "completion-report" | "review-verdict" | "takeover" | "plan-or-answer";

const stringSchema = { type: "string" };
const nullableStringSchema = { type: ["string", "null"] };

export const buildPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "constraints", "tasks", "acceptanceCriteria", "verification"],
  properties: {
    title: stringSchema,
    objective: stringSchema,
    constraints: { type: "array", items: stringSchema },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "files"],
        properties: {
          id: stringSchema,
          description: stringSchema,
          files: { type: ["array", "null"], items: stringSchema }
        }
      }
    },
    acceptanceCriteria: { type: "array", items: stringSchema },
    verification: { type: "array", items: stringSchema }
  }
} as const;

export const completionReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "taskResults", "filesChanged", "verificationResults", "deviationsFromPlan"],
  properties: {
    status: { enum: ["complete", "blocked"] },
    summary: stringSchema,
    taskResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "notes"],
        properties: {
          id: stringSchema,
          status: { enum: ["done", "partial", "skipped"] },
          notes: nullableStringSchema
        }
      }
    },
    filesChanged: { type: "array", items: stringSchema },
    verificationResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "passed", "output"],
        properties: {
          command: stringSchema,
          passed: { type: "boolean" },
          output: stringSchema
        }
      }
    },
    deviationsFromPlan: { type: "array", items: stringSchema }
  }
} as const;

export const reviewVerdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "scores", "feedback", "userSummary"],
  properties: {
    verdict: { enum: ["approve", "revise", "takeover"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["correctness", "planAdherence", "codeQuality"],
      properties: {
        correctness: { type: "number", minimum: 1, maximum: 5 },
        planAdherence: { type: "number", minimum: 1, maximum: 5 },
        codeQuality: { type: "number", minimum: 1, maximum: 5 }
      }
    },
    feedback: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "location", "requiredChange"],
        properties: {
          issue: stringSchema,
          location: nullableStringSchema,
          requiredChange: stringSchema
        }
      }
    },
    userSummary: stringSchema
  }
} as const;

export const takeoverJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["report", "userSummary"],
  properties: {
    report: completionReportJsonSchema,
    userSummary: stringSchema
  }
} as const;

export const planOrAnswerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "answer", "plan"],
  properties: {
    kind: { enum: ["question", "implementation"] },
    answer: nullableStringSchema,
    plan: { anyOf: [buildPlanJsonSchema, { type: "null" }] }
  }
} as const;

export function jsonSchemaFor(kind: CodexSchemaKind): object {
  if (kind === "build-plan") return buildPlanJsonSchema;
  if (kind === "completion-report") return completionReportJsonSchema;
  if (kind === "review-verdict") return reviewVerdictJsonSchema;
  if (kind === "takeover") return takeoverJsonSchema;
  return planOrAnswerJsonSchema;
}

export async function withCodexSchemaFiles<T>(kind: CodexSchemaKind, fn: (paths: { schemaPath: string; outputPath: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "tandem-codex-"));
  const schemaPath = path.join(dir, `${kind}.schema.json`);
  const outputPath = path.join(dir, "last-message.json");
  try {
    await writeFile(schemaPath, `${JSON.stringify(jsonSchemaFor(kind), null, 2)}\n`, "utf8");
    return await fn({ schemaPath, outputPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
