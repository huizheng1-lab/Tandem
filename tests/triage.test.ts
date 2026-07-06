import type { LanguageModel, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { classifyPlanRequest, leaderToolsForTriage, type TriageObjectGenerator } from "../src/agents/live.js";
import { CostLedger } from "../src/session/cost.js";
import type { ModelEntry } from "../src/providers/registry.js";
import type { ToolContext } from "../src/tools/fs.js";

const modelEntry: ModelEntry = {
  id: "test/leader",
  provider: "openai-compatible",
  baseURL: "https://example.test/v1",
  modelName: "leader",
  envKey: "TEST_API_KEY",
  contextWindow: 1000,
  costHints: { inputPerMillion: 1, outputPerMillion: 2 }
};

function fakeClassifier(): TriageObjectGenerator {
  return async ({ prompt }) => {
    const request = prompt.split("Request:").at(-1) ?? prompt;
    return {
      object: {
        kind: /answer directly/i.test(request) || /what is 2\+2/i.test(request) ? "question" : "implementation"
      },
      usage: { inputTokens: 20, outputTokens: 2 }
    };
  };
}

describe("leader triage", () => {
  it("classifies pure questions before planner tools are available", async () => {
    const ledger = new CostLedger();
    const kind = await classifyPlanRequest({
      request: "What is 2+2?",
      history: "Earlier turn: user asked about math.",
      resolution: { model: {} as LanguageModel, entry: modelEntry },
      ledger,
      generator: fakeClassifier()
    });

    expect(kind).toBe("question");
    expect(ledger.totals().leader.inputTokens).toBe(20);
  });

  it("classifies implementation requests as planner work", async () => {
    await expect(
      classifyPlanRequest({
        request: "Create hello35.txt with hi",
        resolution: { model: {} as LanguageModel, entry: modelEntry },
        ledger: new CostLedger(),
        generator: fakeClassifier()
      })
    ).resolves.toBe("implementation");
  });

  it("honors explicit answer-directly wording as question work", async () => {
    await expect(
      classifyPlanRequest({
        request: "Answer directly: summarize README.md",
        resolution: { model: {} as LanguageModel, entry: modelEntry },
        ledger: new CostLedger(),
        generator: fakeClassifier()
      })
    ).resolves.toBe("question");
  });

  it("keeps submit_build_plan and remember out of the question branch", () => {
    const toolContext: ToolContext = { cwd: process.cwd(), permissionMode: "ask", rememberNote: async () => "remembered" };
    const submitTools = { submit_build_plan: { marker: true } as never } as ToolSet;

    const questionTools = leaderToolsForTriage({ kind: "question", toolContext, submitTools });
    const implementationTools = leaderToolsForTriage({ kind: "implementation", toolContext, submitTools });

    expect(Object.keys(questionTools)).toEqual(expect.arrayContaining(["read_file", "list_dir", "glob", "grep"]));
    expect(questionTools).not.toHaveProperty("submit_build_plan");
    expect(questionTools).not.toHaveProperty("remember");
    expect(implementationTools).toHaveProperty("submit_build_plan");
    expect(implementationTools).toHaveProperty("remember");
  });
});
