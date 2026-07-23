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

  it("D181: launcher defaults to A and makes Role=Both phase-aware", async () => {
    const script = await readFile(path.resolve("scripts", "start-reciprocal-tandem.ps1"), "utf8");

    expect(script).toContain('[string]$Role = "A"');
    expect(script).toContain("function Get-PhaseAwareStartRoles");
    expect(script).toContain('$phase -eq "a-upgrade-pending"');
    expect(script).toContain('return @("B")');
    expect(script).toContain('$phase -in @("passive-testing", "validating")');
    expect(script).toContain('return @("A")');
    expect(script).not.toContain('if ($Role -in @("B", "Both")) { Start-Executor "B" }');
  });
});
