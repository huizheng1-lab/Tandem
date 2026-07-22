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
  await mkdir(path.join(repo, "process", "reciprocal"), { recursive: true });
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
  await writeFile(path.join(repo, "process", "reciprocal", "gate-taxonomy.json"), JSON.stringify({
    version: 1,
    categories: {
      autoRecoverablePrerequisite: "auto-recoverable-prerequisite",
      hardBlocked: "hard-blocked",
      hardHumanGate: "hard-human-gate",
      waitingNotBlocked: "waiting-not-blocked",
    },
    codes: {
      idleSupervisorDispatch: "idle-supervisor-dispatch",
      humanAuthorityRequired: "human-authority-required",
      explicitHumanPause: "explicit-human-pause",
      progressWait: "progress-wait",
      endpointUnavailable: "endpoint-unavailable",
      leaseHeld: "lease-held",
      repeatedGenuineBlocker: "repeated-genuine-blocker",
      recoverPausedIdlePrerequisite: "recover-paused-idle-prerequisite",
      sourceReconciliationPending: "source-reconciliation-pending",
    },
    pauseOrigins: {
      human: "human",
      machine: "machine",
      unknown: "unknown",
    },
    pauseReasonCodes: {
      explicitHumanPause: "explicit-human-pause",
      resumeCircuitBreaker: "repeated-genuine-blocker",
      candidateFailure: "candidate-failure",
    },
    displayStates: {
      working: "working",
      testing: "testing",
      waitingForReview: "waiting for review",
      humanPaused: "human paused",
      machineBlocked: "machine blocked",
      hardBlocked: "hard blocked",
      retryBackoff: "retry backoff",
      retryingPrerequisite: "retrying prerequisite",
      planning: "planning",
      unknown: "unknown",
      waitingNotBlocked: "waiting-not-blocked",
    },
    retry: { baseSeconds: 30, maxSeconds: 300, escalateAfterIdenticalAttempts: 3 },
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
    const heldState = await readJson(state);
    expect(heldState.blocker).toBeNull();
    expect(heldState.displayState).toBe("waiting-not-blocked");

    await writeFile(lock, JSON.stringify({
      token: "long-operation",
      pid: currentPid,
      processStartedAtUtc: currentStart,
      acquiredAtUtc: new Date(Date.now() - 240_000).toISOString(),
      heartbeatAtUtc: new Date(Date.now() - 180_000).toISOString(),
      expiresAtUtc: new Date(Date.now() - 60_000).toISOString(),
    }), "utf8");

    const expiredButLive = await supervisor(repo, relay);
    expect(expiredButLive.actions[0]).toMatchObject({ kind: "lease-held", code: "lease-held" });
    expect((await readJson(lock)).token).toBe("long-operation");

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

  it("D177 enforces stored retry backoff and hard blockers before retrying", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(state, JSON.stringify({
      schemaVersion: 1,
      displayState: "retrying prerequisite",
      blocker: {
        category: "auto-recoverable-prerequisite",
        code: "endpoint-unavailable",
        fingerprint: "auto-recoverable-prerequisite|endpoint-unavailable|executor-token",
        attemptCount: 2,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        message: "executor-token",
      },
      transitions: [],
    }), "utf8");

    const backoff = await supervisor(repo, relay);
    expect(backoff.actions[0]).toMatchObject({ kind: "retry-backoff", code: "endpoint-unavailable" });
    expect(backoff.transitionsUsed).toBe(0);

    const hardState = await readJson(state);
    hardState.blocker.category = "hard-blocked";
    await writeFile(state, JSON.stringify(hardState), "utf8");
    const hard = await supervisor(repo, relay);
    expect(hard.actions[0]).toMatchObject({ kind: "retry-backoff", retryable: false });
    expect((await readJson(state)).displayState).toBe("hard blocked");
  }, 30_000);

  it("D179 checks stored backoff before ready source reconciliation", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(path.join(repo, "README.md"), "source\n", "utf8");
    await execa("git", ["config", "user.email", "supervisor@example.test"], { cwd: repo });
    await execa("git", ["config", "user.name", "Supervisor Test"], { cwd: repo });
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "source"], { cwd: repo });
    await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "idle",
      activeRole: null,
      nextRole: "A",
      stableCommit: "0000000000000000000000000000000000000000",
      candidateCommit: null,
      rollbackCommit: null,
    }), "utf8");
    await writeFile(state, JSON.stringify({
      schemaVersion: 1,
      displayState: "retrying prerequisite",
      blocker: {
        category: "auto-recoverable-prerequisite",
        code: "source-reconciliation-pending",
        fingerprint: "auto-recoverable-prerequisite|source-reconciliation-pending|boom",
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        message: "boom",
      },
      transitions: [],
    }), "utf8");

    const backoff = await supervisor(repo, relay);
    expect(backoff.actions).toHaveLength(1);
    expect(backoff.actions[0]).toMatchObject({ kind: "retry-backoff", code: "source-reconciliation-pending" });
    await expect(readFile(path.join(relay, "control", "source-reconciliation-pending.json"), "utf8")).rejects.toThrow();
  }, 30_000);
});
