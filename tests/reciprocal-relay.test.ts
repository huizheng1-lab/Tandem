import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("reciprocal relay script", () => {
  windowsIt("D129: status does not lock packed refs when relay refs are unchanged", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d129-"));
    const script = path.resolve("scripts/reciprocal-relay.ps1");
    try {
      await execa("git", ["init"], { cwd: repo });
      await execa("git", ["config", "user.email", "d129@example.test"], { cwd: repo });
      await execa("git", ["config", "user.name", "D129 Test"], { cwd: repo });
      await writeFile(path.join(repo, "README.md"), "D129\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "initial"], { cwd: repo });
      await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "Reset", "-Force"], { cwd: repo });
      await execa("git", ["pack-refs", "--all", "--prune"], { cwd: repo });

      await mkdir(path.join(repo, ".git", "packed-refs.lock"));
      const result = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "Status"], { cwd: repo });

      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "STATUS" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
