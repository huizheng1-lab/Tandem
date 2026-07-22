import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

describe("reciprocal main update transaction recovery", () => {
  it("D178 rejects malformed transaction state instead of silently starting a new update", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-main-update-malformed-"));
    try {
      await mkdir(path.join(repo, ".git", "tandem-relay"), { recursive: true });
      await writeFile(path.join(repo, ".git", "tandem-relay", "main-update-transaction.json"), "{ bad json", "utf8");

      await expect(execa("node", [
        path.resolve("scripts/reciprocal-main-update.mjs"),
        "--repo", repo,
        "--relay-root", path.join(repo, "relay"),
        "--comment", "test malformed transaction",
      ])).rejects.toThrow(/Invalid main-update transaction state/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
