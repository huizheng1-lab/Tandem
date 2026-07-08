import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleGoal } from "../src/commands/goal.js";
import { addGoal, clearGoals, listGoals, formatStandingGoals, type Goal } from "../src/session/goals.js";

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

describe("clearGoals", () => {
  it("removes every goal and returns the count cleared", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-clear-"));
    try {
      await addGoal("first", cwd);
      await addGoal("second", cwd);
      await addGoal("third", cwd);
      const before = await listGoals(cwd);
      expect(before).toHaveLength(3);
      const removed = await clearGoals(cwd);
      expect(removed).toBe(3);
      expect(await listGoals(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns 0 and is a no-op when no goals exist", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-clear-empty-"));
    try {
      expect(await clearGoals(cwd)).toBe(0);
      expect(await listGoals(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("handleGoal disambiguation (D52)", () => {
  it("/goal add <text> returns handled (records-only; does not run)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      const outcome = await handleGoal(["add", "ship a haiku"], cwd);
      expect(outcome.kind).toBe("handled");
      if (outcome.kind === "handled") {
        expect(outcome.message).toMatch(/^Added goal \d+: ship a haiku$/);
      }
      const goals = await listGoals(cwd);
      expect(goals.map((g) => g.text)).toEqual(["ship a haiku"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("/goal done <n> returns handled (marks complete)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      await addGoal("finish the report", cwd);
      const outcome = await handleGoal(["done", "1"], cwd);
      expect(outcome.kind).toBe("handled");
      const goals = await listGoals(cwd);
      expect(goals[0]?.status).toBe("done");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lone /goal (no args) and /goal list return handled with goal list", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      await addGoal("alpha", cwd);
      const bare = await handleGoal([], cwd);
      expect(bare.kind).toBe("handled");
      const lone = await handleGoal(["list"], cwd);
      expect(lone.kind).toBe("handled");
      expect(bare.kind === "handled" && bare.message).toMatch(/1\. \[active\] alpha/);
      expect(lone.kind === "handled" && lone.message).toMatch(/1\. \[active\] alpha/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("/goal clear (lone token) clears all and returns handled", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      await addGoal("a", cwd);
      await addGoal("b", cwd);
      const outcome = await handleGoal(["clear"], cwd);
      expect(outcome.kind).toBe("handled");
      if (outcome.kind === "handled") expect(outcome.message).toMatch(/^Cleared 2 goal\(s\)\.$/);
      expect(await listGoals(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("/goal <multi-word starting with clear> is free-form, NOT the clear subcommand", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      const outcome = await handleGoal(["clear", "the", "temp", "build", "directory"], cwd);
      expect(outcome.kind).toBe("run");
      if (outcome.kind === "run") {
        expect(outcome.text).toBe("clear the temp build directory");
      }
      expect(await listGoals(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("/goal <multi-word starting with list> is free-form, NOT the list subcommand", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      const outcome = await handleGoal(["list", "the", "pending", "TODOs", "in", "this", "repo"], cwd);
      expect(outcome.kind).toBe("run");
      if (outcome.kind === "run") {
        expect(outcome.text).toBe("list the pending TODOs in this repo");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("free-form /goal <text> returns run (caller adds and pipes to pipeline)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "tandem-handle-"));
    try {
      const outcome = await handleGoal(["count", "from", "1", "to", "100"], cwd);
      expect(outcome.kind).toBe("run");
      if (outcome.kind === "run") expect(outcome.text).toBe("count from 1 to 100");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
