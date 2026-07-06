import { describe, expect, it } from "vitest";
import { buildLeaderRequestMessage, workerMediaWarning } from "../src/agents/live.js";

describe("leader request context dedupe", () => {
  it("omits the history digest when a leader thread already exists", () => {
    const content = buildLeaderRequestMessage({
      request: "add one more to that file",
      goals: [],
      history: "Turn 1:\nUser: create colors.txt\nOutcome: created colors.txt",
      includeHistoryDigest: false
    });

    expect(content).toContain("Request:\nadd one more to that file");
    expect(content).not.toContain("Compact session-log history:");
    expect(content).not.toContain("created colors.txt");
  });

  it("keeps the history digest when no leader thread exists", () => {
    const content = buildLeaderRequestMessage({
      request: "add one more to that file",
      goals: [],
      history: "Turn 1:\nUser: create colors.txt\nOutcome: created colors.txt",
      includeHistoryDigest: true
    });

    expect(content).toContain("Compact session-log history:");
    expect(content).toContain("created colors.txt");
    expect(content).toContain("Request:\nadd one more to that file");
  });
});

describe("worker media routing", () => {
  it("warns the planner when attachments exceed worker media capability", () => {
    const warning = workerMediaWarning(
      [
        { path: "attachments/mock.png", mediaType: "image/png" },
        { path: "attachments/spec.pdf", mediaType: "application/pdf" }
      ],
      { id: "minimax/minimax-m2.7", provider: "openai-compatible", modelName: "MiniMax", envKey: "MINIMAX_API_KEY", contextWindow: 128000 }
    );

    expect(warning).toContain("worker model (minimax/minimax-m2.7) cannot view");
    expect(warning).toContain("attachments/mock.png");
    expect(warning).toContain("attachments/spec.pdf");
    expect(warning).toContain("Inspect them yourself during planning");
    expect(warning).toContain("visual/PDF findings");
  });
});
