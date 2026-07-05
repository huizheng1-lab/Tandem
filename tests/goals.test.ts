import { describe, expect, it } from "vitest";
import { formatStandingGoals, type Goal } from "../src/session/goals.js";

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: 1,
    text: "build a dogfight game",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    notes: [],
    ...overrides
  };
}

describe("standing goal formatting", () => {
  it("includes user-visible goal ids", () => {
    expect(formatStandingGoals([goal({ id: 1, text: "build an airplane dogfight game" })])).toEqual(["Goal 1: build an airplane dogfight game"]);
  });

  it("includes only the last two progress notes indented under the goal", () => {
    expect(formatStandingGoals([goal({ id: 3, notes: ["first", "second", "third"] })])).toEqual(["Goal 3: build a dogfight game\n  - second\n  - third"]);
  });
});
