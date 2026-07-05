import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractFromProse } from "../src/agents/live.js";
import { CostLedger } from "../src/session/cost.js";
import { ModelEntry } from "../src/providers/registry.js";

const modelEntry: ModelEntry = {
  id: "test/model",
  provider: "openai-compatible",
  modelName: "test-model",
  envKey: "TEST_API_KEY",
  baseURL: "https://example.test/v1",
  contextWindow: 1000,
  costHints: { inputPerMillion: 2, outputPerMillion: 8 }
};

const schema = z.object({
  verdict: z.enum(["approve", "revise", "takeover"]),
  userSummary: z.string()
});

describe("extractFromProse", () => {
  it("extracts a structured artifact with an injected generator", async () => {
    const ledger = new CostLedger();
    const result = await extractFromProse({
      resolution: { model: {} as LanguageModel, entry: modelEntry },
      ledger,
      role: "leader",
      schema,
      artifactName: "ReviewVerdict",
      text: "Approved. Summary: done.",
      originalError: new Error("original"),
      generator: async ({ prompt }) => {
        expect(prompt).toContain("Approved");
        return { object: { verdict: "approve" as const, userSummary: "done" }, usage: { inputTokens: 100, outputTokens: 25 } };
      }
    });

    expect(result).toEqual({ verdict: "approve", userSummary: "done" });
  });

  it("throws a diagnostic error when extraction fails", async () => {
    const originalError = new Error("Leader review finished without submit_review.");
    const promise = extractFromProse({
      resolution: { model: {} as LanguageModel, entry: modelEntry },
      ledger: new CostLedger(),
      role: "leader",
      schema,
      artifactName: "ReviewVerdict",
      text: "I refuse to be JSON today.",
      originalError,
      generator: async () => {
        throw new Error("provider parse failed");
      }
    });

    await expect(promise).rejects.toThrow(/Leader review finished without submit_review\. Fallback extraction also failed:/);
    await expect(promise).rejects.toThrow(/provider parse failed/);
  });

  it("throws the original error for empty prose", async () => {
    await expect(
      extractFromProse({
        resolution: { model: {} as LanguageModel, entry: modelEntry },
        ledger: new CostLedger(),
        role: "leader",
        schema,
        artifactName: "ReviewVerdict",
        text: "",
        originalError: new Error("Leader review finished without submit_review.")
      })
    ).rejects.toThrow(/^Leader review finished without submit_review\.$/);
  });

  it("records cost ledger usage for the extra extraction call", async () => {
    const ledger = new CostLedger();
    await extractFromProse({
      resolution: { model: {} as LanguageModel, entry: modelEntry },
      ledger,
      role: "leader",
      schema,
      artifactName: "ReviewVerdict",
      text: "Approved.",
      originalError: new Error("original"),
      generator: async () => ({ object: { verdict: "approve" as const, userSummary: "done" }, usage: { promptTokens: 50, completionTokens: 10 } })
    });

    const totals = ledger.totals().leader;
    expect(totals.inputTokens).toBe(50);
    expect(totals.outputTokens).toBe(10);
    expect(totals.dollars).toBeCloseTo(0.00018, 8);
  });
});
