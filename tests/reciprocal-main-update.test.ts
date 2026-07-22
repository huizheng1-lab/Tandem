import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/reciprocal-main-update.mjs");
const windowsIt = process.platform === "win32" ? it : it.skip;

async function git(cwd: string, ...args: string[]) {
  return execa("git", args, { cwd });
}

async function gitOut(cwd: string, ...args: string[]) {
  return (await git(cwd, ...args)).stdout.trim();
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tandem-main-update-"));
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const relay = path.join(root, "relay");
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(relay, "control"), { recursive: true });
  await mkdir(path.join(relay, "worktrees"), { recursive: true });
  await git(root, "init", "--bare", origin);
  await git(repo, "init");
  await git(repo, "config", "user.email", "main-update@example.test");
  await git(repo, "config", "user.name", "Main Update Test");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(path.join(repo, "process", "reciprocal"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({
    scripts: { typecheck: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" },
  }), "utf8");
  await writeFile(
    path.join(repo, "scripts", "reciprocal-relay.ps1"),
    await readFile(path.resolve("scripts/reciprocal-relay.ps1"), "utf8"),
    "utf8",
  );
  await writeFile(
    path.join(repo, "process", "reciprocal", "gate-taxonomy.json"),
    await readFile(path.resolve("process/reciprocal/gate-taxonomy.json"), "utf8"),
    "utf8",
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  const initial = await gitOut(repo, "rev-parse", "HEAD");
  await git(repo, "branch", "codex/reciprocal-a");
  await git(repo, "branch", "codex/reciprocal-b");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "origin", "master", "codex/reciprocal-a", "codex/reciprocal-b");
  await git(repo, "update-ref", "refs/tandem-relay/stable", initial);
  await git(repo, "worktree", "add", path.join(relay, "worktrees", "copy-a"), "codex/reciprocal-a");
  await git(repo, "worktree", "add", path.join(relay, "worktrees", "copy-b"), "codex/reciprocal-b");
  await writeFile(path.join(relay, "control", "WISHLIST.md"), [
    "# Tandem Reciprocal: Wishlist And Progress",
    "",
    "<!-- wishlist-items -->",
    `- [x] W0001 | P1 | Done work | DONE stable=${initial}`,
    "",
  ].join("\n"), "utf8");
  const relayDir = path.join(repo, ".git", "tandem-relay");
  await mkdir(relayDir, { recursive: true });
  await writeJson(path.join(relayDir, "state.json"), {
    schemaVersion: 2,
    turn: 7,
    phase: "paused",
    activeRole: null,
    nextRole: "A",
    stableCommit: initial,
    baseCommit: null,
    lastCompletedCommit: initial,
    candidateCommit: null,
    candidateKind: null,
    rollbackCommit: null,
    pausedFromPhase: "idle",
    pauseOrigin: "human",
    pauseReasonCode: "explicit-human-pause",
    pauseAfterTurn: false,
    resumeCount: 0,
    resumeTurn: null,
    startedAt: null,
    lastSummary: "fixture paused",
    lastRecoveryStash: null,
    authorityRequest: null,
    updatedAt: new Date().toISOString(),
  });
  async function advanceStable(subject = "stable") {
    const before = await gitOut(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "README.md"), `${subject}\n${Date.now()}\n`, "utf8");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", subject);
    const sha = await gitOut(repo, "rev-parse", "HEAD");
    await git(path.join(relay, "worktrees", "copy-a"), "merge", "--ff-only", sha);
    await git(path.join(relay, "worktrees", "copy-b"), "merge", "--ff-only", sha);
    await git(repo, "update-ref", "refs/tandem-relay/stable", sha);
    await git(repo, "reset", "--hard", before);
    const state = JSON.parse(await readFile(path.join(relayDir, "state.json"), "utf8"));
    state.stableCommit = sha;
    state.lastCompletedCommit = sha;
    await writeJson(path.join(relayDir, "state.json"), state);
    return { sha, before };
  }
  async function run(comment = "fixture main update", env: Record<string, string> = {}) {
    const result = await execa("node", [script, "--repo", repo, "--relay-root", relay, "--comment", comment], {
      cwd: repo,
      env: { ...process.env, ...env },
      reject: false,
    });
    const text = (result.stdout || result.stderr || "").trim();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return { result, parsed, text };
  }
  return { root, repo, relay, origin, relayDir, initial, advanceStable, run };
}

describe("reciprocal main update transaction recovery", () => {
  it("D178 rejects malformed transaction state instead of silently starting a new update", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-main-update-malformed-"));
    try {
      await mkdir(path.join(repo, ".git", "tandem-relay"), { recursive: true });
      await writeFile(path.join(repo, ".git", "tandem-relay", "main-update-transaction.json"), "{ bad json", "utf8");
      await expect(execa("node", [
        script,
        "--repo", repo,
        "--relay-root", path.join(repo, "relay"),
        "--comment", "test malformed transaction",
      ])).rejects.toThrow(/Invalid main-update transaction state/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  windowsIt.each(["merged-not-pushed", "tagged-not-pushed", "pushed-not-synced"] as const)(
    "D180 resumes %s main-update transaction without duplicate tags or force push",
    async (stage) => {
      const fx = await makeFixture();
      try {
        const { sha: stable, before: beforeMaster } = await fx.advanceStable(`stable ${stage}`);
        const tag = "main-update-001";
        if (stage !== "merged-not-pushed") {
          await git(fx.repo, "tag", "-a", tag, "-m", "existing tag", stable);
        }
        if (stage === "pushed-not-synced") {
          await git(fx.repo, "push", "--atomic", "origin", `${stable}:refs/heads/master`, `refs/tags/${tag}:refs/tags/${tag}`);
        }
        await writeJson(path.join(fx.relayDir, "main-update-transaction.json"), {
          schemaVersion: 1,
          stage,
          beforeMaster,
          masterSha: stable,
          stableSha: stable,
          ...(stage === "merged-not-pushed" ? {} : { tag }),
        });
        const { result, parsed, text } = await fx.run(`resume ${stage}`);
        expect(result.exitCode, text).toBe(0);
        expect(parsed).toMatchObject({ ok: true, stage: "complete", resumedTransaction: true, masterSha: stable });
        expect((await gitOut(fx.repo, "tag", "--list", "main-update-*")).split(/\r?\n/).filter(Boolean)).toEqual([tag]);
        expect(await gitOut(fx.repo, "ls-remote", "origin", "refs/heads/master")).toContain(stable);
        await expect(readFile(path.join(fx.relayDir, "main-update-transaction.json"), "utf8")).rejects.toThrow();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  windowsIt("D180 preserves dirty tracked staged renamed deleted untracked and spaced paths while resuming tagged transaction", async () => {
    const fx = await makeFixture();
    try {
      const { sha: stable, before: beforeMaster } = await fx.advanceStable("stable dirty preservation");
      await git(fx.repo, "reset", "--hard", stable);
      const tag = "main-update-001";
      await git(fx.repo, "tag", "-a", tag, "-m", "existing tag", stable);
      await writeFile(path.join(fx.repo, "dirty tracked.txt"), "tracked\n", "utf8");
      await git(fx.repo, "add", "dirty tracked.txt");
      await git(fx.repo, "commit", "-m", "dirty base");
      await writeFile(path.join(fx.repo, "dirty tracked.txt"), "tracked dirty\n", "utf8");
      await writeFile(path.join(fx.repo, "staged path.txt"), "staged\n", "utf8");
      await git(fx.repo, "add", "staged path.txt");
      await git(fx.repo, "mv", "package.json", "renamed package.json");
      await git(fx.repo, "rm", "README.md");
      await writeFile(path.join(fx.repo, "untracked space.txt"), "untracked\n", "utf8");
      const beforeStatus = await gitOut(fx.repo, "status", "--porcelain=v1", "--untracked-files=all");
      const beforeIndex = await gitOut(fx.repo, "ls-files", "--stage");
      await writeJson(path.join(fx.relayDir, "main-update-transaction.json"), {
        schemaVersion: 1,
        stage: "tagged-not-pushed",
        beforeMaster,
        masterSha: stable,
        stableSha: stable,
        tag,
      });
      const { result, parsed, text } = await fx.run("resume dirty tagged");
      expect(result.exitCode, text).toBe(0);
      expect(parsed).toMatchObject({ ok: true, localMasterDeferred: true });
      expect(await gitOut(fx.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(beforeStatus);
      expect(await gitOut(fx.repo, "ls-files", "--stage")).toBe(beforeIndex);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D180 injected after-push fault preserves pushed transaction for exact resume", async () => {
    const fx = await makeFixture();
    try {
      await fx.advanceStable("stable fault");
      const failed = await fx.run("fault after push", { TANDEM_MAIN_UPDATE_FAULT_STAGE: "after-push" });
      expect(failed.result.exitCode).not.toBe(0);
      expect(failed.parsed).toMatchObject({ ok: false, stage: "push", pushed: true });
      const transaction = JSON.parse(await readFile(path.join(fx.relayDir, "main-update-transaction.json"), "utf8"));
      expect(transaction).toMatchObject({ stage: "pushed-not-synced" });
      const resumed = await fx.run("resume after fault");
      expect(resumed.result.exitCode, resumed.text).toBe(0);
      expect(resumed.parsed).toMatchObject({ ok: true, resumedTransaction: true, stage: "complete", masterSha: transaction.masterSha });
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("resumes the exact relay pause created by an interrupted automatic main update", async () => {
    const fx = await makeFixture();
    try {
      await fx.advanceStable("stable automatic pause recovery");
      const statePath = path.join(fx.relayDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      Object.assign(state, {
        phase: "idle",
        pausedFromPhase: null,
        pauseOrigin: null,
        pauseReasonCode: null,
        lastSummary: "ready",
      });
      await writeJson(statePath, state);

      const failed = await fx.run("fault after automatic pause", { TANDEM_MAIN_UPDATE_FAULT_STAGE: "after-push" });
      expect(failed.result.exitCode).not.toBe(0);
      const transaction = JSON.parse(await readFile(path.join(fx.relayDir, "main-update-transaction.json"), "utf8"));
      expect(transaction).toMatchObject({ stage: "pushed-not-synced", resumeRequired: true });
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ phase: "paused", pauseOrigin: "human", pauseReasonCode: "explicit-human-pause" });

      const resumed = await fx.run("resume exact automatic pause");
      expect(resumed.result.exitCode, resumed.text).toBe(0);
      expect(resumed.parsed).toMatchObject({ ok: true, resumedTransaction: true, relayResumed: true });
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ phase: "idle", activeRole: null, stableCommit: transaction.masterSha });
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D180 isolated merge conflict leaves refs tags and transaction state unchanged", async () => {
    const fx = await makeFixture();
    try {
      const { before } = await fx.advanceStable("stable conflict side");
      await writeFile(path.join(fx.repo, "README.md"), "master conflict side\n", "utf8");
      await git(fx.repo, "add", "README.md");
      await git(fx.repo, "commit", "-m", "master conflict side");
      const masterBefore = await gitOut(fx.repo, "rev-parse", "master");
      const stableBefore = await gitOut(fx.repo, "rev-parse", "refs/tandem-relay/stable");
      const originBefore = await gitOut(fx.repo, "ls-remote", "origin", "refs/heads/master");
      const failed = await fx.run("conflict should stop");
      expect(failed.result.exitCode).not.toBe(0);
      expect(failed.parsed).toMatchObject({ ok: false, stage: "isolated-merge", pushed: false });
      expect(failed.text).toMatch(/Isolated stable merge conflict/);
      expect(await gitOut(fx.repo, "rev-parse", "master")).toBe(masterBefore);
      expect(await gitOut(fx.repo, "rev-parse", "refs/tandem-relay/stable")).toBe(stableBefore);
      expect(await gitOut(fx.repo, "ls-remote", "origin", "refs/heads/master")).toBe(originBefore);
      expect(await gitOut(fx.repo, "tag", "--list", "main-update-*")).toBe("");
      await expect(readFile(path.join(fx.relayDir, "main-update-transaction.json"), "utf8")).rejects.toThrow();
      expect(before).toBe(originBefore.split(/\s+/)[0]);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);
});
