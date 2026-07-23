import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
      executorBusy: "executor-busy",
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
      environmentFailure: "environment-failure",
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

async function supervisor(repo: string, relay: string, env: NodeJS.ProcessEnv = process.env) {
  const result = await execa("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-Workspace", repo,
    "-RelayRoot", relay,
    "-MaxTransitions", "1",
  ], { cwd: repo, env });
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

  it("D186 never sends paused candidate failures directly to PassiveTest", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "candidate-failure",
      activeRole: null,
      nextRole: "A",
      stableCommit: "0123456789012345678901234567890123456789",
      candidateCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    }), "utf8");

    const result = await supervisor(repo, relay);
    expect(result.transitionsUsed).toBe(0);
    expect(result.actions.map((action: { kind: string }) => action.kind)).not.toContain("passive-test");
    expect(result.finalPhase).toBe("paused");
    expect((await readJson(state)).blocker).toBeNull();
  }, 30_000);

  it("D186 does not auto-resume human or unknown-origin paused candidates", async () => {
    for (const [pauseOrigin, pauseReasonCode] of [["human", "explicit-human-pause"], ["unknown", "environment-failure"]]) {
      const { repo, relay } = await fixture();
      await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
        schemaVersion: 2,
        phase: "paused",
        pausedFromPhase: "passive-testing",
        pauseOrigin,
        pauseReasonCode,
        activeRole: null,
        nextRole: "A",
        stableCommit: "0123456789012345678901234567890123456789",
        candidateCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      }), "utf8");

      const result = await supervisor(repo, relay);
      expect(result.transitionsUsed).toBe(0);
      expect(result.actions).toHaveLength(0);
      expect(result.finalPhase).toBe("paused");
    }
  }, 30_000);

  it("D188 retries a machine-origin environment failure with exactly one Resume and PassiveTest", async () => {
    const { repo, relay } = await fixture();
    const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
    await writeFile(statePath, JSON.stringify({
      schemaVersion: 2,
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      pauseAfterTurn: false,
      activeRole: null,
      nextRole: "A",
      stableCommit: "0123456789012345678901234567890123456789",
      candidateCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    }), "utf8");
    const fakeRelay = path.join(relay, "control", "fake-relay.ps1");
    const callsPath = path.join(relay, "control", "retry-calls.log");
    await writeFile(fakeRelay, `
param([string]$Action,[string]$Workspace,[string]$Role,[string]$Summary)
Add-Content -LiteralPath '${callsPath.replaceAll("'", "''")}' -Value $Action
$statePath='${statePath.replaceAll("'", "''")}'
$utf8=[Text.UTF8Encoding]::new($false)
if($Action -eq 'Resume'){
  $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $state.phase='passive-testing'; $state.pauseOrigin=$null; $state.pauseReasonCode=$null
  [IO.File]::WriteAllBytes($statePath, $utf8.GetBytes(($state | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
  @{ outcome='RESUMED'; phase='passive-testing' } | ConvertTo-Json
  exit 0
}
if($Action -eq 'PassiveTest'){
  $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $state.phase='paused'; $state.pausedFromPhase='passive-testing'; $state.pauseOrigin='machine'; $state.pauseReasonCode='environment-failure'
  [IO.File]::WriteAllBytes($statePath, $utf8.GetBytes(($state | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
  @{ outcome='PASSIVE_FAILED'; phase='paused'; pauseReasonCode='environment-failure' } | ConvertTo-Json
  exit 0
}
throw "unexpected action $Action"
`, "utf8");

    const result = await supervisor(repo, relay, {
      ...process.env,
      TANDEM_SUPERVISOR_TEST_RELAY_SCRIPT: fakeRelay,
      TANDEM_SUPERVISOR_TEST_COPY_A: repo,
    });
    expect(result.transitionsUsed).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      kind: "environment-failure-retry",
      resumeOutcome: "RESUMED",
      passiveOutcome: "PASSIVE_FAILED",
      phase: "paused",
    });
    expect((await readFile(callsPath, "utf8")).trim().split(/\r?\n/)).toEqual(["Resume", "PassiveTest"]);
    const saved = await readJson(path.join(relay, "control", "continuation-supervisor-state.json"));
    expect(saved.blocker).toMatchObject({ code: "environment-failure", attemptCount: 1 });
  }, 30_000);

  it("D188 backs off and hard-blocks repeated environment failures without retrying", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      activeRole: null,
      nextRole: "A",
      stableCommit: "0123456789012345678901234567890123456789",
      candidateCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    }), "utf8");
    await writeFile(state, JSON.stringify({
      schemaVersion: 1,
      displayState: "retrying prerequisite",
      blocker: {
        category: "auto-recoverable-prerequisite",
        code: "environment-failure",
        fingerprint: "auto-recoverable-prerequisite|environment-failure|environment failure reproduced during bounded passive retry",
        attemptCount: 2,
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        message: "environment failure reproduced during bounded passive retry",
      },
      transitions: [],
    }), "utf8");

    const backoff = await supervisor(repo, relay);
    expect(backoff.transitionsUsed).toBe(0);
    expect(backoff.actions[0]).toMatchObject({ kind: "retry-backoff", code: "environment-failure", retryable: true });

    const hardState = await readJson(state);
    hardState.blocker.category = "hard-blocked";
    await writeFile(state, JSON.stringify(hardState), "utf8");
    const hard = await supervisor(repo, relay);
    expect(hard.transitionsUsed).toBe(0);
    expect(hard.actions[0]).toMatchObject({ kind: "retry-backoff", code: "environment-failure", retryable: false });
  }, 30_000);

  it("D189 escalates repeated environment failures through production retry state", async () => {
    const { repo, relay, state } = await fixture();
    const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
    await writeFile(statePath, JSON.stringify({
      schemaVersion: 2,
      phase: "paused",
      pausedFromPhase: "passive-testing",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      pauseAfterTurn: false,
      activeRole: null,
      nextRole: "A",
      stableCommit: "0123456789012345678901234567890123456789",
      candidateCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    }), "utf8");
    const fakeRelay = path.join(relay, "control", "fake-relay-d189.ps1");
    const callsPath = path.join(relay, "control", "retry-calls-d189.log");
    await writeFile(fakeRelay, `
param([string]$Action,[string]$Workspace,[string]$Role,[string]$Summary)
Add-Content -LiteralPath '${callsPath.replaceAll("'", "''")}' -Value $Action
$statePath='${statePath.replaceAll("'", "''")}'
$utf8=[Text.UTF8Encoding]::new($false)
if($Action -eq 'Resume'){
  $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $state.phase='passive-testing'; $state.pauseOrigin=$null; $state.pauseReasonCode=$null
  [IO.File]::WriteAllBytes($statePath, $utf8.GetBytes(($state | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
  @{ outcome='RESUMED'; phase='passive-testing' } | ConvertTo-Json
  exit 0
}
if($Action -eq 'PassiveTest'){
  $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $state.phase='paused'; $state.pausedFromPhase='passive-testing'; $state.pauseOrigin='machine'; $state.pauseReasonCode='environment-failure'
  [IO.File]::WriteAllBytes($statePath, $utf8.GetBytes(($state | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
  @{ outcome='PASSIVE_FAILED'; phase='paused'; pauseReasonCode='environment-failure' } | ConvertTo-Json
  exit 0
}
throw "unexpected action $Action"
`, "utf8");
    const env = {
      ...process.env,
      TANDEM_SUPERVISOR_TEST_RELAY_SCRIPT: fakeRelay,
      TANDEM_SUPERVISOR_TEST_COPY_A: repo,
    };
    const calls = async () => (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    const expireBackoff = async () => {
      const saved = await readJson(state);
      saved.blocker.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
      await writeFile(state, JSON.stringify(saved), "utf8");
    };

    const first = await supervisor(repo, relay, env);
    expect(first.transitionsUsed).toBe(1);
    expect(first.actions[0]).toMatchObject({ kind: "environment-failure-retry", resumeOutcome: "RESUMED", passiveOutcome: "PASSIVE_FAILED" });
    expect(await calls()).toEqual(["Resume", "PassiveTest"]);
    let saved = await readJson(state);
    expect(saved.blocker).toMatchObject({
      category: "auto-recoverable-prerequisite",
      code: "environment-failure",
      attemptCount: 1,
      message: "environment failure reproduced during bounded passive retry",
    });

    const backoff = await supervisor(repo, relay, env);
    expect(backoff.transitionsUsed).toBe(0);
    expect(backoff.actions[0]).toMatchObject({ kind: "retry-backoff", code: "environment-failure", retryable: true });
    expect(await calls()).toEqual(["Resume", "PassiveTest"]);

    await expireBackoff();
    const second = await supervisor(repo, relay, env);
    expect(second.transitionsUsed).toBe(1);
    expect(second.actions[0]).toMatchObject({ kind: "environment-failure-retry" });
    expect(await calls()).toEqual(["Resume", "PassiveTest", "Resume", "PassiveTest"]);
    saved = await readJson(state);
    expect(saved.blocker).toMatchObject({ category: "auto-recoverable-prerequisite", code: "environment-failure", attemptCount: 2 });

    await expireBackoff();
    const third = await supervisor(repo, relay, env);
    expect(third.transitionsUsed).toBe(1);
    expect(third.actions[0]).toMatchObject({ kind: "environment-failure-retry" });
    expect(await calls()).toEqual(["Resume", "PassiveTest", "Resume", "PassiveTest", "Resume", "PassiveTest"]);
    saved = await readJson(state);
    expect(saved.displayState).toBe("hard blocked");
    expect(saved.blocker).toMatchObject({ category: "hard-blocked", code: "environment-failure", attemptCount: 3, nextAction: "surface-actionable-blocker" });

    const hard = await supervisor(repo, relay, env);
    expect(hard.transitionsUsed).toBe(0);
    expect(hard.actions[0]).toMatchObject({ kind: "retry-backoff", code: "environment-failure", retryable: false });
    expect(await calls()).toEqual(["Resume", "PassiveTest", "Resume", "PassiveTest", "Resume", "PassiveTest"]);
  }, 45_000);

  it("D188 canonical relay-state writes are atomic and size capped", async () => {
    const { repo, relay } = await fixture();
    const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
    const pausedState = JSON.stringify({
      schemaVersion: 2,
      phase: "paused",
      pausedFromPhase: "idle",
      pauseOrigin: "machine",
      pauseReasonCode: "environment-failure",
      pauseAfterTurn: false,
      activeRole: null,
      nextRole: "A",
      stableCommit: "0123456789012345678901234567890123456789",
      candidateCommit: null,
      lastSummary: null,
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    await writeFile(statePath, pausedState, "utf8");
    await writeFile(path.join(relay, "control", "WISHLIST.md"), [
      "# Tandem Reciprocal: Wishlist And Progress",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W0099 | P0 | Planning | QUEUED",
      "",
    ].join("\n"), "utf8");
    const normal = await supervisor(repo, relay);
    expect(normal.actions[0]).toMatchObject({ kind: "recover-paused-idle-prerequisite" });
    expect(await readJson(statePath)).toMatchObject({ phase: "idle" });
    await expect(readFile(`${statePath}.tmp-`, "utf8")).rejects.toThrow();

    await writeFile(statePath, pausedState, "utf8");
    await expect(supervisor(repo, relay, { ...process.env, TANDEM_SUPERVISOR_TEST_OVERSIZE_RELAY_SAVE: "1" })).rejects.toThrow(/Refusing to write oversized JSON file/);
    expect(await readFile(statePath, "utf8")).toBe(pausedState);
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

  it("does not reconcile again when stable already contains the source head", async () => {
    const { repo, relay } = await fixture();
    await execa("git", ["config", "user.email", "supervisor@example.test"], { cwd: repo });
    await execa("git", ["config", "user.name", "Supervisor Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "source\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "source"], { cwd: repo });
    const source = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await writeFile(path.join(repo, "STABLE.md"), "relay descendant\n", "utf8");
    await execa("git", ["add", "STABLE.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "stable descendant"], { cwd: repo });
    const stable = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await execa("git", ["reset", "--hard", source], { cwd: repo });
    await writeFile(path.join(repo, ".git", "tandem-relay", "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "idle",
      activeRole: null,
      nextRole: "A",
      stableCommit: stable,
      candidateCommit: null,
      rollbackCommit: null,
    }), "utf8");

    const result = await supervisor(repo, relay);
    expect(result.actions).toEqual([]);
    await expect(readFile(path.join(relay, "control", "source-reconciliation-pending.json"), "utf8")).rejects.toThrow();
  }, 30_000);

  it("continues a PLAN_APPROVED epic before planning a lower-priority queued item", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(path.join(relay, "control", "WISHLIST.md"), [
      "# Tandem Reciprocal: Wishlist And Progress",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W0027 | P0 | Environment resolution | PLAN_APPROVED epic=true autonomy=full revision=1 completed=0 steps=3 next=1/3 plan=process/reciprocal/epics/W0027-plan.md commit=0123456789012345678901234567890123456789 approval=auto",
      "- [ ] W0023 | P1 | Telegram work | QUEUED epic=true autonomy=full",
      "",
    ].join("\n"), "utf8");

    let postedPrompt = "";
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, running: false, projectDir: path.join(relay, "worktrees", "copy-b") }));
        return;
      }
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        postedPrompt = JSON.parse(body).prompt;
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, accepted: true, projectDir: path.join(relay, "worktrees", "copy-b") }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      await mkdir(path.join(relay, "state", "executor-a"), { recursive: true });
      await writeFile(path.join(relay, "state", "executor-a", "automation.json"), JSON.stringify({ port: address.port, token: "test-token" }), "utf8");

      const result = await supervisor(repo, relay);
      expect(result.actions[0]).toMatchObject({ kind: "idle-continuation-prompt", wishlistId: "W0027", nextStep: "1/3", accepted: true });
      expect(postedPrompt).toContain("wishlist W0027 step 1/3");
      expect((await readJson(state)).blocker).toBeNull();
    } finally {
      server.close();
    }
  }, 30_000);

  it("treats an already-running executor as waiting, not an unavailable endpoint", async () => {
    const { repo, relay, state } = await fixture();
    await writeFile(path.join(relay, "control", "WISHLIST.md"), [
      "# Tandem Reciprocal: Wishlist And Progress",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W0027 | P0 | Environment resolution | PLAN_APPROVED epic=true autonomy=full revision=1 completed=0 steps=3 next=1/3 plan=process/reciprocal/epics/W0027-plan.md commit=0123456789012345678901234567890123456789 approval=auto",
      "",
    ].join("\n"), "utf8");

    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, running: true, sessionId: "active-session", acceptedAt: "2026-07-22T12:54:03.689Z", projectDir: path.join(relay, "worktrees", "copy-b") }));
        return;
      }
      posts += 1;
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "A Tandem run is already active." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      await mkdir(path.join(relay, "state", "executor-a"), { recursive: true });
      await writeFile(path.join(relay, "state", "executor-a", "automation.json"), JSON.stringify({ port: address.port, token: "test-token" }), "utf8");

      const result = await supervisor(repo, relay);
      expect(result.actions[0]).toMatchObject({ kind: "idle-continuation-prompt-busy", category: "waiting-not-blocked", code: "executor-busy", wishlistId: "W0027" });
      expect(posts).toBe(0);
      const saved = await readJson(state);
      expect(saved.blocker).toBeNull();
      expect(saved.waiting).toMatchObject({ code: "executor-busy", wishlistId: "W0027", sessionId: "active-session" });
      expect(saved.displayState).toBe("waiting-not-blocked");
    } finally {
      server.close();
    }
  }, 30_000);
});
