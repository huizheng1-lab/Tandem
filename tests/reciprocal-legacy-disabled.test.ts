import { execa } from "execa";
import path from "node:path";
import { describe, expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("D196 legacy reciprocal actors", () => {
  windowsIt("hard-disables the old relay by default", async () => {
    const result = await execa(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/reciprocal-relay.ps1"), "-Action", "Status"],
      { reject: false },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("LEGACY_DISABLED");
    expect(result.stdout).toContain("reciprocal-orchestrator.ps1");
  });

  windowsIt("hard-disables the continuation supervisor by default", async () => {
    const result = await execa(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/continue-reciprocal-automation.ps1")],
      { reject: false },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("D196 removed the continuation supervisor");
    expect(result.stdout).toContain("reciprocal-orchestrator.ps1");
  });
});
