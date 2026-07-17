import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("reciprocal setup script", () => {
  it("D134: generates fresh executor configs with a reciprocal-safe step budget", async () => {
    const script = await readFile(path.resolve("scripts", "setup-reciprocal-tandem.ps1"), "utf8");

    expect(script).toContain("$reciprocalMaxStepsPerAgentTurn = 250");
    expect(script).toContain("-not (Test-Path -LiteralPath $targetConfig)");
    expect(script).toContain("$config.maxStepsPerAgentTurn = $reciprocalMaxStepsPerAgentTurn");
  });
});
