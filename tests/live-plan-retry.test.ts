import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type TandemConfig } from "../src/config/schema.js";
import { CostLedger } from "../src/session/cost.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";

const runnerMocks = vi.hoisted(() => ({
  runAgentArtifact: vi.fn(),
  runAgentText: vi.fn(),
  estimatePromptSize: vi.fn(() => ({ chars: 1, approxTokens: 1 })),
  toolCallThinkingDelta: vi.fn((toolName: string) => `[tool call: ${toolName}]\n`)
}));

const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((definition) => definition)
}));

vi.mock("../src/agents/runner.js", () => runnerMocks);
vi.mock("ai", () => aiMocks);

const plan: BuildPlan = {
  title: "Create file",
  objective: "Create a test file",
  constraints: ["Keep the change small."],
  tasks: [{ id: "T1", description: "Create the file.", files: ["hello.txt"] }],
  acceptanceCriteria: ["File exists."],
  verification: ["node --version"]
};

function testConfig(triage: TandemConfig["triage"] = "always-plan"): TandemConfig {
  return {
    ...defaultConfig,
    leader: "test/leader",
    worker: "test/worker",
    triage,
    maxStepsPerAgentTurn: 10,
    customModels: [
      {
        id: "test/leader",
        baseURL: "https://example.test/v1",
        apiKeyEnv: "TEST_API_KEY",
        modelName: "leader",
        costHints: { inputPerMillion: 0, outputPerMillion: 0 }
      },
      {
        id: "test/worker",
        baseURL: "https://example.test/v1",
        apiKeyEnv: "TEST_API_KEY",
        modelName: "worker",
        costHints: { inputPerMillion: 0, outputPerMillion: 0 }
      }
    ]
  };
}

async function makeAgents(triage?: TandemConfig["triage"]) {
  const { createLiveAgents } = await import("../src/agents/live.js");
  return createLiveAgents({
    config: testConfig(triage),
    cwd: process.cwd(),
    env: { TEST_API_KEY: "test" },
    ledger: new CostLedger()
  });
}

describe("live leader implementation planning retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerMocks.runAgentText.mockResolvedValue({ text: "direct answer", stepsUsed: 1, usage: undefined as LanguageModelUsage | undefined });
  });

  it("D108: retries implementation planning when the leader ends without submit_build_plan", async () => {
    runnerMocks.runAgentArtifact
      .mockResolvedValueOnce({ text: "I investigated and here is a prose plan.", stepsUsed: 2 })
      .mockResolvedValueOnce({ text: "Submitted.", artifact: plan, stepsUsed: 1 });

    const agents = await makeAgents();
    await expect(agents.plan({ request: "Create hello.txt", goals: [] })).resolves.toEqual({ kind: "plan", plan });

    expect(runnerMocks.runAgentArtifact).toHaveBeenCalledTimes(2);
    const retryUserMessage = runnerMocks.runAgentArtifact.mock.calls[1]?.[0].messages.find((message: { role: string; content: unknown }) =>
      message.role === "user" && String(message.content).includes("required to call submit_build_plan")
    );
    expect(retryUserMessage).toMatchObject({ role: "user" });
    expect(String(retryUserMessage?.content)).toContain("required to call submit_build_plan");
    expect(String(retryUserMessage?.content)).toContain("Do not just describe the plan in prose");
  });

  it("D108: throws after three implementation planning attempts without submit_build_plan", async () => {
    runnerMocks.runAgentArtifact.mockResolvedValue({ text: "prose only", stepsUsed: 1 });

    const agents = await makeAgents();
    await expect(agents.plan({ request: "Modify the code", goals: [] })).rejects.toThrow(/without submit_build_plan/);
    expect(runnerMocks.runAgentArtifact).toHaveBeenCalledTimes(3);
  });

  it("D108: keeps question triage as a direct answer without implementation retries", async () => {
    aiMocks.generateObject.mockResolvedValue({ object: { kind: "question" }, usage: { inputTokens: 1, outputTokens: 1 } });
    runnerMocks.runAgentText.mockResolvedValue({ text: "It is a bug.", stepsUsed: 1 });

    const agents = await makeAgents("auto");
    await expect(agents.plan({ request: "Is this a bug?", goals: [] })).resolves.toEqual({ kind: "answer", answer: "It is a bug." });
    expect(runnerMocks.runAgentArtifact).not.toHaveBeenCalled();
    expect(runnerMocks.runAgentText).toHaveBeenCalledTimes(1);
  });
});
