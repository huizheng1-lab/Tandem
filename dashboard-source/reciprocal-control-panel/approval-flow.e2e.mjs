import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function findAdminRepo(start) {
  if (process.env.TANDEM_SOURCE_REPO) return path.resolve(process.env.TANDEM_SOURCE_REPO);
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "scripts", "reciprocal-relay.ps1"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(here, "..", "..", "HZ code");
}

const adminRepo = findAdminRepo(here);
const relayScript = path.join(adminRepo, "scripts", "reciprocal-relay.ps1");
const serverScript = path.join(here, "server.mjs");

function execFile(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });
}

async function git(cwd, ...args) {
  return execFile("git", args, cwd);
}

async function waitForServer(port, server) {
  const deadline = Date.now() + 10_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dashboard exited early with ${server.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dashboard did not start: ${lastError}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonl(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeEvidence(name, value) {
  if (!process.env.TANDEM_DASHBOARD_E2E_EVIDENCE) return;
  await mkdir(path.dirname(process.env.TANDEM_DASHBOARD_E2E_EVIDENCE), { recursive: true });
  await appendFile(process.env.TANDEM_DASHBOARD_E2E_EVIDENCE, `${JSON.stringify({ name, ...value })}\n`, "utf8");
}

function commandActions(commands) {
  return commands
    .filter((entry) => entry.args.includes("-Action"))
    .map((entry) => {
      const actionIndex = entry.args.indexOf("-Action");
      return { action: entry.args[actionIndex + 1], args: entry.args };
    });
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-approval-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const relayRoot = path.join(root, "relay");
  const repoRoot = path.join(root, "repo");
  const copyA = path.join(relayRoot, "worktrees", "copy-a");
  const copyB = path.join(relayRoot, "worktrees", "copy-b");
  await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
  await mkdir(path.join(repoRoot, "process", "reciprocal"), { recursive: true });
  await copyFile(relayScript, path.join(repoRoot, "scripts", "reciprocal-relay.ps1"));
  await copyFile(path.join(adminRepo, "scripts", "reciprocal-direction.ps1"), path.join(repoRoot, "scripts", "reciprocal-direction.ps1"));
  await copyFile(path.join(adminRepo, "process", "reciprocal", "gate-taxonomy.json"), path.join(repoRoot, "process", "reciprocal", "gate-taxonomy.json"));
  await writeFile(path.join(repoRoot, "package.json"), "{\"name\":\"fixture\",\"version\":\"0.0.0\"}\n", "utf8");
  await git(repoRoot, "init", "-b", "master");
  await git(repoRoot, "config", "user.email", "fixture@example.invalid");
  await git(repoRoot, "config", "user.name", "Approval Fixture");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-m", "fixture");
  await git(repoRoot, "branch", "codex/reciprocal-a");
  await git(repoRoot, "branch", "codex/reciprocal-b");
  await mkdir(path.dirname(copyA), { recursive: true });
  await git(repoRoot, "worktree", "add", copyA, "codex/reciprocal-a");
  await git(repoRoot, "worktree", "add", copyB, "codex/reciprocal-b");
  const fixtureSha = await git(repoRoot, "rev-parse", "HEAD");
  const oldSha = "0000000000000000000000000000000000000000";
  const statePath = path.join(repoRoot, ".git", "tandem-relay", "state.json");
  const reviewIndexPath = path.join(relayRoot, "control", "UPDATE_REVIEW_INDEX.json");
  const auditPath = path.join(relayRoot, "control", "CONTROL_PANEL_AUDIT.jsonl");
  const commandLog = path.join(relayRoot, "control", "COMMAND_LOG.jsonl");
  await mkdir(path.join(repoRoot, "release", "win-unpacked"), { recursive: true });
  await writeJson(path.join(repoRoot, "release", "win-unpacked", "BUILD_INFO.json"), {
    sourceSha: fixtureSha,
    sourceShortSha: fixtureSha.slice(0, 7),
    builtAt: "2026-07-22T00:00:00.000Z",
  });
  await writeFile(path.join(repoRoot, "release", "win-unpacked", "Tandem.exe"), "fixture candidate\n", "utf8");
  for (const role of ["a", "b"]) {
    const runtimeDir = path.join(relayRoot, "runtimes", `executor-${role}`);
    await mkdir(runtimeDir, { recursive: true });
    await writeJson(path.join(runtimeDir, "BUILD_INFO.json"), { sourceSha: oldSha, sourceShortSha: "0000000" });
    await writeFile(path.join(runtimeDir, "Tandem.exe"), "fixture runtime\n", "utf8");
  }
  await writeJson(reviewIndexPath, {});

  async function setState(overrides = {}) {
    await writeJson(statePath, {
      schemaVersion: 2,
      turn: 7,
      nextRole: "A",
      activeRole: null,
      phase: "a-upgrade-pending",
      pausedFromPhase: null,
      pauseAfterTurn: false,
      resumeCount: 0,
      resumeTurn: null,
      baseCommit: null,
      stableCommit: fixtureSha,
      candidateCommit: null,
      candidateKind: null,
      rollbackCommit: null,
      startedAt: null,
      updatedAt: "2026-07-22T00:00:00.000Z",
      lastCompletedCommit: fixtureSha,
      lastSummary: null,
      lastRecoveryStash: null,
      ...overrides,
    });
  }

  async function setRuntimeShas(sourceSha) {
    for (const role of ["a", "b"]) {
      await writeJson(path.join(relayRoot, "runtimes", `executor-${role}`, "BUILD_INFO.json"), {
        sourceSha,
        sourceShortSha: sourceSha.slice(0, 7),
      });
    }
  }

  return { root, relayRoot, repoRoot, copyA, copyB, fixtureSha, oldSha, statePath, reviewIndexPath, auditPath, commandLog, wishlistPath: path.join(relayRoot, "control", "WISHLIST.md"), setState, setRuntimeShas };
}

async function withServer(t, fixture, runTest) {
  const port = 18_000 + Math.floor(Math.random() * 20_000);
  const server = spawn(process.execPath, [serverScript, `--port=${port}`], {
    cwd: here,
    windowsHide: true,
    env: {
      ...process.env,
      TANDEM_RECIPROCAL_ROOT: fixture.relayRoot,
      TANDEM_SOURCE_REPO: fixture.repoRoot,
      TANDEM_DASHBOARD_TEST_HARNESS: "1",
      TANDEM_DASHBOARD_COMMAND_LOG: fixture.commandLog,
      TANDEM_APPROVAL_WAIT_TIMEOUT_MS: "5000",
      TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION: process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION || "",
    },
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit").catch(() => {});
    }
  });
  const page = await waitForServer(port, server);
  const html = await page.text();
  const token = html.match(/name="control-token" content="([^"]+)"/)?.[1];
  assert.ok(token, `missing control token; stderr=${stderr}`);

  async function post(pathname, body) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-control-token": token },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json();
    return { response, result };
  }

  async function get(pathname) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    const result = await response.json();
    return { response, result };
  }

  async function postWithoutToken(pathname, body) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json();
    return { response, result };
  }

  return runTest({ post, get, postWithoutToken });
}

test("D181 Kickstart starts only Executor A and treats B dormant as healthy", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState({ phase: "idle", activeRole: null });
  const old = process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION;
  process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION = "1";
  try {
    await withServer(t, fixture, async ({ post }) => {
      const { response, result } = await post("/api/executor/kickstart", {});
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.ok, true);
      assert.equal(result.result.executor, "A");
      assert.match(result.result.steps.find((step) => step.step === "endpoint-ready")?.detail || "", /B dormant by phase policy/);
    });
  } finally {
    if (old === undefined) delete process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION;
    else process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION = old;
  }

  const commands = await readJsonl(fixture.commandLog);
  const startCommands = commands.filter((entry) => String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1"));
  assert.equal(startCommands.length, 1);
  assert.equal(startCommands[0].args.includes("-Role"), true);
  assert.equal(startCommands[0].args[startCommands[0].args.indexOf("-Role") + 1], "A");
  assert.equal(commands.some((entry) => entry.args.includes("B") && String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1")), false);
  const actions = commandActions(commands);
  assert.deepEqual(actions.map((entry) => entry.action), []);
});

test("approval flow uses the real relay to complete an inactive A-upgrade boundary", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "fixture approval" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
    assert.deepEqual(result.result.steps.map((step) => step.step), [
      "a-upgrade-boundary",
      "review-recorded",
      "executors-stopped",
      "runtime-promoted",
      "executors-restarted",
      "a-upgrade-completed",
    ]);
  });

  const commands = await readJsonl(fixture.commandLog);
  const actions = commandActions(commands);
  assert.equal(actions.some((entry) => entry.action === "Pause"), false);
  assert.equal(actions.some((entry) => entry.action === "Resume"), false);
  const completions = actions.filter((entry) => entry.action === "CompleteAUpgrade");
  assert.equal(completions.length, 1);
  const completeArgs = completions[0].args;
  assert.equal(completeArgs.includes("-Role") && completeArgs[completeArgs.indexOf("-Role") + 1] === "A", true);
  assert.equal(completeArgs.includes("-Force"), true);
  assert.equal(completeArgs.includes("-Workspace") && path.resolve(completeArgs[completeArgs.indexOf("-Workspace") + 1]) === path.resolve(fixture.copyA), true);
  assert.equal(completeArgs.includes("-Summary") && completeArgs[completeArgs.indexOf("-Summary") + 1].trim().length > 0, true);
  assert.equal(commands.filter((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1")).length, 1);

  const state = await readJson(fixture.statePath);
  assert.equal(state.phase, "idle");
  assert.equal(state.activeRole, null);
  assert.equal(state.nextRole, "A");
  assert.equal(state.stableCommit, fixture.fixtureSha);
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.some((entry) => entry.step === "a-upgrade-completed" && /a_upgrade_completed/.test(entry.detail)), true);
  await writeEvidence("approval-flow", { commands, actions, state, auditSteps: audit.filter((entry) => entry.action === "update.approvalStep").map((entry) => ({ step: entry.step, detail: entry.detail })) });
});

test("authority flow uses authenticated dashboard API to approve one relay checkpoint", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState({
    phase: "working",
    activeRole: "A",
    pausedFromPhase: null,
    baseCommit: fixture.fixtureSha,
    startedAt: "2026-07-22T00:00:00.000Z",
  });
  await writeFile(fixture.wishlistPath, [
    "# Tandem Reciprocal: Shared Direction",
    "",
    "AutonomyDefault: plan-gated",
    "",
    "## Wishlist And Progress",
    "",
    "<!-- wishlist-items -->",
    "- [ ] W0001 | P0 | Sensitive step | IN_PROGRESS epic=true autonomy=full phase=STEP revision=1 completed=0 step=1/1 plan=process/reciprocal/epics/W0001-plan.md role=A started=now",
    "",
  ].join("\n"), "utf8");

  await withServer(t, fixture, async ({ post, postWithoutToken }) => {
    const declared = await post("/api/authority/declare", {
      id: "W0001",
      role: "A",
      kind: "permission",
      action: "enableLoopback",
      checkpoint: "step1",
      resume: "resumeStep1",
    });
    assert.equal(declared.response.status, 200, JSON.stringify(declared.result));
    assert.equal(declared.result.result.outcome, "AUTHORITY_DECLARED");
    assert.equal(declared.result.result.authorityRequest.decisionProof, undefined);

    const unauthenticated = await postWithoutToken("/api/authority/approve", {});
    assert.equal(unauthenticated.response.status, 403);

    const approved = await post("/api/authority/approve", { confirmed: true });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.result));
    assert.equal(approved.result.result.outcome, "AUTHORITY_APPROVED");
    assert.equal(approved.result.result.phase, "working");
    assert.match(await readFile(fixture.wishlistPath, "utf8"), /authorityStatus=approved/);

    const repeat = await post("/api/authority/approve", { confirmed: true });
    assert.equal(repeat.response.status, 200, JSON.stringify(repeat.result));
    assert.equal(repeat.result.noop, true);
    const audit = await readFile(fixture.auditPath, "utf8");
    assert.match(audit, /"action":"authority\.declare"/);
    assert.match(audit, /"action":"authority\.approve"/);
  });
});

test("recovery flow closes the stranded gate without promotion and rejects unsafe states", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState({ phase: "paused", pausedFromPhase: "a-upgrade-pending" });
  await fixture.setRuntimeShas(fixture.fixtureSha);
  await writeJson(fixture.reviewIndexPath, {
    [fixture.fixtureSha]: { decision: "approve", shortSha: fixture.fixtureSha.slice(0, 7), at: "2026-07-22T00:00:00.000Z" },
  });

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve/recover-a-upgrade", {
      sourceSha: fixture.fixtureSha,
      comment: "fixture recovery",
    });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.steps.at(-1).step, "a-upgrade-recovered");
  });

  let commands = await readJsonl(fixture.commandLog);
  let actions = commandActions(commands);
  assert.deepEqual(actions.map((entry) => entry.action), ["CompleteAUpgrade"]);
  assert.equal(commands.some((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1")), false);
  assert.equal(commands.some((entry) => String(entry.args[1]).endsWith("stop-reciprocal-tandem.ps1")), false);
  assert.equal(commands.some((entry) => String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1")), false);
  assert.equal(actions.some((entry) => entry.action === "Resume"), false);
  assert.equal(commands.some((entry) => String(entry.args[1]).endsWith("reciprocal-direction.ps1")), false);
  assert.equal((await readJson(fixture.statePath)).phase, "idle");
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.some((entry) => entry.action === "update.approvePromoteRecovery" && entry.mode === "already-promoted-relay-gate-recovered"), true);
  await writeEvidence("recovery-flow", { commands, actions, state: await readJson(fixture.statePath), recoveryAudit: audit.filter((entry) => entry.action === "update.approvePromoteRecovery") });

  const cases = [
    { name: "wrong paused origin", state: { phase: "paused", pausedFromPhase: "working", activeRole: null, stableCommit: fixture.fixtureSha } },
    { name: "active role", state: { phase: "paused", pausedFromPhase: "a-upgrade-pending", activeRole: "A", stableCommit: fixture.fixtureSha } },
    { name: "stable mismatch", state: { phase: "paused", pausedFromPhase: "a-upgrade-pending", activeRole: null, stableCommit: fixture.oldSha } },
    { name: "review rejected", review: { decision: "reject" } },
    { name: "runtime A mismatch", runtimeA: fixture.oldSha },
    { name: "runtime B mismatch", runtimeB: fixture.oldSha },
  ];

  for (const item of cases) {
    await writeFile(fixture.commandLog, "", "utf8");
    await fixture.setState({ phase: "paused", pausedFromPhase: "a-upgrade-pending", activeRole: null, stableCommit: fixture.fixtureSha, ...(item.state || {}) });
    await fixture.setRuntimeShas(fixture.fixtureSha);
    if (item.runtimeA) {
      await writeJson(path.join(fixture.relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"), { sourceSha: item.runtimeA, sourceShortSha: item.runtimeA.slice(0, 7) });
    }
    if (item.runtimeB) {
      await writeJson(path.join(fixture.relayRoot, "runtimes", "executor-b", "BUILD_INFO.json"), { sourceSha: item.runtimeB, sourceShortSha: item.runtimeB.slice(0, 7) });
    }
    await writeJson(fixture.reviewIndexPath, {
      [fixture.fixtureSha]: item.review || { decision: "approve", shortSha: fixture.fixtureSha.slice(0, 7), at: "2026-07-22T00:00:00.000Z" },
    });

    await withServer(t, fixture, async ({ post }) => {
      const before = await readJson(fixture.statePath);
      const { response } = await post("/api/update/approve/recover-a-upgrade", { sourceSha: fixture.fixtureSha, comment: item.name });
      assert.equal(response.status, 400, item.name);
      assert.deepEqual(await readJson(fixture.statePath), before, item.name);
    });
    commands = await readJsonl(fixture.commandLog);
    actions = commandActions(commands);
    assert.deepEqual(actions.map((entry) => entry.action), [], item.name);
    assert.equal(commands.some((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1")), false, item.name);
    await writeEvidence(`recovery-negative-${item.name}`, { commands, actions, state: await readJson(fixture.statePath) });
  }
});
