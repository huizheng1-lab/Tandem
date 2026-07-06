import { describe, expect, it } from "vitest";
import { buildLeaderRequestMessage } from "../src/agents/live.js";

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
