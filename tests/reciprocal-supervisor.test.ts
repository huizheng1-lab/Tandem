import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = path.resolve("scripts", "continue-reciprocal-automation.ps1");

async function fixture() {
  const root = path.join(tmpdir(), `tandem-supervisor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const repo = path.join(root, "repo");
  const relay = path.join(root, "relay");
  await mkdir(path.join(repo, ".git", "tandem-relay"), { recursive: true });
  await mkdir(path.join(relay, "control"), { recursive: true });
  await mkdir(path.join(relay, "worktrees", "copy-a"), { recursive: true });
  await mkdir(path.join(relay, "worktrees", "copy-b"), { recursive: true });
  await execa("git", ["init"], { cwd: repo });
  await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
    schemaVersion: 2,
    phase: "idle",
    activeRole: null,
    nextRole: "A",
    stableCommit: "0123456789012345678901234567890123456789",
  }), "utf8");
  await writeFile(path.join(relay, "control", "WISHLIST.md"), [
    "# Tandem Reciprocal: Wishlist And Progress",
    "",
    "<!-- wishlist-items -->",
    "",
  ].join("\n"), "utf8");
  return { repo, relay, lock: path.join(relay, "control", "continuation-supervisor.lock.json"), state: path.join(relay, "control", "continuation-supervisor-state.json") };
}

async function supervisor(repo: string, relay: string) {
  const result = await execa("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-Workspace", repo,
    "-RelayRoot", relay,
    "-MaxTransitions", "1",
  ], { cwd: repo });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

async function readJson(file: string) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

describeWindows("reciprocal continuation supervisor", () => {
  it("D176: respects a live token lease and reclaims a dead expired lease", async () => {
    const { repo, relay, lock, state } = await fixture();
    const now = new Date();
    const currentPid = process.pid;
    const currentStart = (await execa("powershell", [
      "-NoProfile", "-Command",
      `(Get-Process -Id ${currentPid}).StartTime.ToUniversalTime().ToString("o")`,
    ])).stdout.trim();
    await writeFile(lock, JSON.stringify({
      token: "other",
      pid: currentPid,
      processStartedAtUtc: currentStart,
      acquiredAtUtc: now.toISOString(),
      heartbeatAtUtc: now.toISOString(),
      expiresAtUtc: new Date(Date.now() + 120_000).toISOString(),
    }), "utf8");

    const held = await supervisor(repo, relay);
    expect(held.actions[0]).toMatchObject({ kind: "lease-held", code: "lease-held" });
    expect((await readJson(lock)).token).toBe("other");
    expect((await readJson(state)).blocker.code).toBe("lease-held");

    await writeFile(lock, JSON.stringify({
      token: "dead",
      pid: 999999,
      processStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      acquiredAtUtc: "2000-01-01T00:00:00.0000000Z",
      heartbeatAtUtc: "2000-01-01T00:00:00.0000000Z",
      expiresAtUtc: "2000-01-01T00:00:00.0000000Z",
    }), "utf8");

    const reclaimed = await supervisor(repo, relay);
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.actions.map((action: { kind: string }) => action.kind)).not.toContain("lease-held");
  }, 30_000);
});
