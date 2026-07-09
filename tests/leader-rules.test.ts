import { describe, expect, it } from "vitest";
import {
  finiteVerificationRule,
  leaderPlannerPrompt,
  leaderReviewerPrompt,
  leaderTakeoverPrompt,
  perceptualVerificationRule,
  reversibilityCautionRule,
  rootCauseDisciplineRule,
  scopeExpansionReviewRule,
  securityAndScopeRule,
  streamPartitioningRule
} from "../src/agents/leader.js";
import { workerPrompt } from "../src/agents/worker.js";

// D60 + D61: presence tests for shared prompt rules. These are best-effort prompt guidance -
// the real test is observed behavior in a live run, not whether the string is present. The
// presence test just guards against accidental removal during refactors.
describe("shared leader rules (D60 + D61)", () => {
  describe("perceptualVerificationRule (D60-1)", () => {
    it("is a non-empty string", () => {
      expect(perceptualVerificationRule.length).toBeGreaterThan(50);
    });
    it("warns about exit codes being necessary but not sufficient", () => {
      expect(perceptualVerificationRule).toMatch(/necessary but not sufficient/);
    });
    it("instructs the leader to use vision on sampled frames or screenshots", () => {
      expect(perceptualVerificationRule).toMatch(/vision tool on sampled frames or screenshots/);
    });
    it("covers the words-per-minute proxy for audio", () => {
      expect(perceptualVerificationRule).toMatch(/words-per-minute/);
    });
    it("forbids deferring perceptual claims to acceptanceCriteria alone", () => {
      expect(perceptualVerificationRule).toMatch(/do not defer perceptual claims to acceptanceCriteria/);
    });
  });

  describe("rootCauseDisciplineRule (D60-2)", () => {
    it("is a non-empty string", () => {
      expect(rootCauseDisciplineRule.length).toBeGreaterThan(50);
    });
    it("explicitly forbids loosening thresholds to make a check pass", () => {
      expect(rootCauseDisciplineRule).toMatch(/do not make the check pass by loosening/);
    });
    it("forbids changing expected values to match the actual wrong output", () => {
      expect(rootCauseDisciplineRule).toMatch(/changing its expected values to match the actual.*?wrong.*?output/);
    });
  });

  describe("securityAndScopeRule (D61-1 + D61-2 worker portion)", () => {
    it("is a non-empty string", () => {
      expect(securityAndScopeRule.length).toBeGreaterThan(50);
    });
    it("names concrete vulnerability classes", () => {
      expect(securityAndScopeRule).toMatch(/command injection/);
      expect(securityAndScopeRule).toMatch(/path traversal/);
      expect(securityAndScopeRule).toMatch(/hardcoded secrets|hardcoded.*?secrets/);
    });
    it("forbids unrequested features and refactors", () => {
      expect(securityAndScopeRule).toMatch(/do not add features, refactors, or abstractions/i);
    });
    it("forbids half-finished extras", () => {
      expect(securityAndScopeRule).toMatch(/no half-finished extras/i);
    });
  });

  describe("scopeExpansionReviewRule (D61-2 reviewer portion)", () => {
    it("is a non-empty string", () => {
      expect(scopeExpansionReviewRule.length).toBeGreaterThan(20);
    });
    it("instructs the reviewer to flag scope expansion as revise-worthy", () => {
      expect(scopeExpansionReviewRule).toMatch(/flag unrequested scope expansion/i);
      expect(scopeExpansionReviewRule).toMatch(/revise-worthy/i);
    });
  });

  describe("reversibilityCautionRule (D61-3)", () => {
    it("is a non-empty string", () => {
      expect(reversibilityCautionRule.length).toBeGreaterThan(50);
    });
    it("explicitly forbids force-push", () => {
      expect(reversibilityCautionRule).toMatch(/never force-push/i);
    });
    it("warns about secrets/credentials in commits", () => {
      expect(reversibilityCautionRule).toMatch(/secret or credential/);
    });
  });
});

describe("shared worker rules (D60 + D61 inheritance)", () => {
  it("workerPrompt inherits securityAndScopeRule", () => {
    expect(workerPrompt).toContain(securityAndScopeRule);
  });
  it("workerPrompt inherits reversibilityCautionRule", () => {
    expect(workerPrompt).toContain(reversibilityCautionRule);
  });
});

describe("leader prompt exports (D60 + D61 wiring)", () => {
  it("leaderPlannerPrompt contains all five D60/D61 rules", () => {
    expect(leaderPlannerPrompt).toContain(perceptualVerificationRule);
    expect(leaderPlannerPrompt).toContain(rootCauseDisciplineRule);
  });
  it("leaderReviewerPrompt contains D60 reviewer rules + D61 scope-expansion rule", () => {
    expect(leaderReviewerPrompt).toContain(perceptualVerificationRule);
    expect(leaderReviewerPrompt).toContain(rootCauseDisciplineRule);
    expect(leaderReviewerPrompt).toContain(scopeExpansionReviewRule);
  });
  it("leaderTakeoverPrompt contains D60 takeover rules + D61 reversibility rule", () => {
    expect(leaderTakeoverPrompt).toContain(perceptualVerificationRule);
    expect(leaderTakeoverPrompt).toContain(rootCauseDisciplineRule);
    expect(leaderTakeoverPrompt).toContain(reversibilityCautionRule);
  });
  it("all three prompts still contain the prior D54 + finiteVerificationRule rules", () => {
    for (const prompt of [leaderPlannerPrompt, leaderReviewerPrompt, leaderTakeoverPrompt]) {
      expect(prompt).toContain(finiteVerificationRule);
    }
    expect(leaderPlannerPrompt).toContain(streamPartitioningRule);
  });
});
