import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdtemp, mkdir, readFile, writeFile, copyFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const legacyDashboardMutationTest = process.env.TANDEM_RUN_LEGACY_DASHBOARD_MUTATION_E2E === "1" ? test : test.skip;

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

async function waitForAudit(file, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let audit = [];
  while (Date.now() < deadline) {
    audit = await readJsonl(file);
    if (audit.some(predicate)) return audit;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return audit;
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
  await copyFile(path.join(adminRepo, "scripts", "runtime-package-integrity.mjs"), path.join(repoRoot, "scripts", "runtime-package-integrity.mjs"));
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
  const integrity = await import(pathToFileURL(path.join(adminRepo, "scripts", "runtime-package-integrity.mjs")).href);
  const oldSha = "0000000000000000000000000000000000000000";
  const statePath = path.join(repoRoot, ".git", "tandem-relay", "state.json");
  const reviewIndexPath = path.join(relayRoot, "control", "UPDATE_REVIEW_INDEX.json");
  const auditPath = path.join(relayRoot, "control", "CONTROL_PANEL_AUDIT.jsonl");
  const commandLog = path.join(relayRoot, "control", "COMMAND_LOG.jsonl");
  const candidateRuntimeDir = path.join(repoRoot, "release", "win-unpacked");
  await mkdir(candidateRuntimeDir, { recursive: true });
  await writeFile(path.join(candidateRuntimeDir, "Tandem.exe"), "fixture candidate\n", "utf8");
  const fixtureManifest = await integrity.packageManifest(candidateRuntimeDir);
  const fixturePackage = integrity.packageIdentity(fixtureSha, fixtureManifest, { candidatePreviewArtifactLifecycle: 1 });
  const immutablePackagePath = path.join(repoRoot, "release", "runtime-packages", fixturePackage, "win-unpacked");
  await writeJson(path.join(candidateRuntimeDir, "BUILD_INFO.json"), {
    sourceSha: fixtureSha,
    sourceShortSha: fixtureSha.slice(0, 7),
    builtAt: "2026-07-22T00:00:00.000Z",
    packageIdentity: fixturePackage,
    packageManifest: fixtureManifest,
    immutablePackagePath,
    reciprocalCapabilities: { candidatePreviewArtifactLifecycle: 1 },
  });
  await mkdir(path.dirname(immutablePackagePath), { recursive: true });
  await cp(candidateRuntimeDir, immutablePackagePath, { recursive: true });
  for (const role of ["a", "b"]) {
    const runtimeDir = path.join(relayRoot, "runtimes", `executor-${role}`);
    await mkdir(runtimeDir, { recursive: true });
    await writeJson(path.join(runtimeDir, "BUILD_INFO.json"), { sourceSha: oldSha, sourceShortSha: "0000000", packageIdentity: `old-${role}` });
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

  async function setOrchestratorState(overrides = {}) {
    await writeJson(path.join(relayRoot, "state", "orchestrator-state.json"), {
      phase: "idle",
      currentItem: null,
      stableCommit: fixtureSha,
      consecutiveFailures: 0,
      updatedAt: "2026-07-22T00:00:00.000Z",
      ...overrides,
    });
  }

  async function setRuntimeShas(sourceSha) {
    const candidateBuildInfo = await readJson(path.join(candidateRuntimeDir, "BUILD_INFO.json"));
    const manifest = await integrity.packageManifest(candidateRuntimeDir);
    const packageIdentity = integrity.packageIdentity(sourceSha, manifest, { candidatePreviewArtifactLifecycle: 1 });
    const packagePath = path.join(repoRoot, "release", "runtime-packages", packageIdentity, "win-unpacked");
    await mkdir(path.dirname(packagePath), { recursive: true });
    await rm(packagePath, { recursive: true, force: true });
    await cp(candidateRuntimeDir, packagePath, { recursive: true });
    for (const role of ["a", "b"]) {
      const runtimeDir = path.join(relayRoot, "runtimes", `executor-${role}`);
      await rm(runtimeDir, { recursive: true, force: true });
      await mkdir(runtimeDir, { recursive: true });
      await cp(candidateRuntimeDir, runtimeDir, { recursive: true });
      await writeJson(path.join(relayRoot, "runtimes", `executor-${role}`, "BUILD_INFO.json"), {
        ...candidateBuildInfo,
        sourceSha,
        sourceShortSha: sourceSha.slice(0, 7),
        packageIdentity,
        packageManifest: manifest,
        immutablePackagePath: packagePath,
        reciprocalCapabilities: { candidatePreviewArtifactLifecycle: 1 },
      });
    }
  }

  return { root, relayRoot, repoRoot, copyA, copyB, fixtureSha, fixturePackage, immutablePackagePath, candidateRuntimeDir, oldSha, statePath, reviewIndexPath, auditPath, commandLog, wishlistPath: path.join(relayRoot, "control", "WISHLIST.md"), setState, setOrchestratorState, setRuntimeShas };
}

async function withServer(t, fixture, runTest, options = {}) {
  const port = 18_000 + Math.floor(Math.random() * 20_000);
  const env = {
    ...process.env,
    TANDEM_RECIPROCAL_ROOT: fixture.relayRoot,
    TANDEM_SOURCE_REPO: fixture.repoRoot,
    TANDEM_DASHBOARD_COMMAND_LOG: fixture.commandLog,
    TANDEM_APPROVAL_WAIT_TIMEOUT_MS: "5000",
    TANDEM_SUPERVISOR_TICK_MS: "600000",
    TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION: process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION || "",
    ...(options.env || {}),
  };
  if (options.harness !== false) env.TANDEM_DASHBOARD_TEST_HARNESS = "1";
  else delete env.TANDEM_DASHBOARD_TEST_HARNESS;
  const server = spawn(process.execPath, [serverScript, `--port=${port}`], {
    cwd: here,
    windowsHide: true,
    env,
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

async function createBareOrigin(fixture) {
  const origin = path.join(fixture.root, "origin.git");
  await git(fixture.repoRoot, "init", "--bare", origin);
  await git(fixture.repoRoot, "remote", "add", "origin", origin);
  await git(fixture.repoRoot, "push", "origin", `${fixture.fixtureSha}:refs/heads/master`);
  return origin;
}

async function assertLocalBareOrigin(fixture) {
  const remoteUrl = await git(fixture.repoRoot, "remote", "get-url", "origin");
  assert.equal(path.isAbsolute(remoteUrl), true, `origin must be a local path, got ${remoteUrl}`);
  assert.equal(remoteUrl.startsWith(fixture.root), true, `origin must stay inside fixture root, got ${remoteUrl}`);
  assert.equal(await git(remoteUrl, "rev-parse", "--is-bare-repository"), "true");
}

async function remoteMaster(fixture) {
  const output = await git(fixture.repoRoot, "ls-remote", "origin", "refs/heads/master");
  return output.split(/\s+/)[0] || "";
}

function lifecycleStatuses(state) {
  return (state?.history || []).map((entry) => entry.status);
}

function lastLifecyclePath(state) {
  const statuses = lifecycleStatuses(state);
  const start = statuses.lastIndexOf("requested");
  return start >= 0 ? statuses.slice(start) : statuses;
}

function extractFunction(source, name, nextName) {
  const starts = [source.indexOf(`function ${name}`), source.indexOf(`async function ${name}`)].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.notEqual(end, -1, `missing next function ${nextName}`);
  return source.slice(start, end);
}

async function pollStatusDuring(promise, get) {
  let settled = false;
  promise.finally(() => { settled = true; });
  const polls = [];
  while (!settled) {
    polls.push(await get("/api/status"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return polls;
}

async function prepareVerifiedStable(fixture, fileName = "verified-stable.txt") {
  await writeFile(path.join(fixture.repoRoot, fileName), `${fileName}\n`, "utf8");
  await git(fixture.repoRoot, "add", fileName);
  await git(fixture.repoRoot, "commit", "-m", `verified stable ${fileName}`);
  const stableSha = await git(fixture.repoRoot, "rev-parse", "HEAD");
  await fixture.setRuntimeShas(stableSha);
  await fixture.setOrchestratorState({
    phase: "idle",
    currentItem: null,
    stableCommit: stableSha,
    acceptedSourceSha: stableSha,
    updatedAt: "2026-07-22T00:00:02.000Z",
  });
  await git(fixture.repoRoot, "update-ref", "refs/tandem-relay/stable", stableSha);
  await appendFile(path.join(fixture.relayRoot, "control", "orchestrator-operations.ndjson"), [
    JSON.stringify({ at: "2026-07-22T00:00:01.000Z", action: "stable-ref.updated", sourceSha: stableSha }),
    JSON.stringify({ at: "2026-07-22T00:00:02.000Z", action: "cycle.completed", completedItem: "WTEST" }),
    "",
  ].join("\n"), "utf8");
  return stableSha;
}

test("D184 dashboard reports canonical package state without the test harness", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();
  await withServer(t, fixture, async ({ get }) => {
    const { response, result } = await get("/api/status");
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.candidateUpdate.sourceSha, fixture.fixtureSha);
    assert.equal(result.candidateUpdate.buildInfo.packageIdentity, fixture.fixturePackage);
    assert.equal(result.candidateUpdate.buildInfo.immutablePackagePath.endsWith(path.join("release", "runtime-packages", fixture.fixturePackage, "win-unpacked")), true);
    assert.equal(result.candidateUpdate.pending, true);
    assert.equal(result.runtimeTopology.key, "a-running-verifying-b");
  }, { harness: false });
});

test("D201 launch candidate ignores stale legacy relay state and honors current orchestrator mismatch", async (t) => {
  const fixture = await makeFixture(t);
  const staleSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await fixture.setState({ phase: "a-upgrade-pending", stableCommit: staleSha });
  await fixture.setOrchestratorState({ phase: "idle", stableCommit: fixture.fixtureSha });
  await withServer(t, fixture, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.response.status, 200, JSON.stringify(status.result));
    assert.equal(status.result.candidateUpdate.sourceSha, fixture.fixtureSha);
    assert.equal(status.result.candidateUpdate.matchesRelayExpected, true);
    assert.equal(status.result.candidateUpdate.expectedReason, "independent-candidate-review");
    assert.equal(status.result.legacyRelay.stableCommit, staleSha);

    const launched = await post("/api/update/launch-candidate", {});
    assert.equal(launched.response.status, 200, JSON.stringify(launched.result));
    assert.equal(launched.result.ok, true);
    assert.equal(launched.result.exe.endsWith(path.join("release", "win-unpacked", "Tandem.exe")), true);

    await fixture.setOrchestratorState({
      phase: "swapping",
      acceptedSourceSha: "dddddddddddddddddddddddddddddddddddddddd",
    });
    const blocked = await post("/api/update/launch-candidate", {});
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.result.error, /does not match current accepted source ddddddd/);
  });
});

test("D196 dashboard reports retired mutation paths truthfully", async (t) => {
  const fixture = await makeFixture(t);
  await withServer(t, fixture, async ({ post }) => {
    for (const [endpoint, body] of [
      ["/api/executor/kickstart", {}],
      ["/api/update/approve", { comment: "retired approval path" }],
      ["/api/authority/approve", { decisionId: "authority-test", secret: "dashboard-secret" }],
      ["/api/update/recover-approved", { comment: "retired recovery path" }],
    ]) {
      const { response, result } = await post(endpoint, body);
      assert.equal(response.status, 410, endpoint);
      assert.equal(result.ok, false, endpoint);
      assert.match(result.error, /D196 replaced dashboard mutation paths/);
      assert.match(result.orchestrator, /reciprocal-orchestrator\.mjs/);
      assert.deepEqual(result.allowedMutations, ["/api/github-sync", "/api/implementation-model", "/api/quit", "/api/relay/pause", "/api/update/dismiss-review", "/api/update/launch-candidate", "/api/update/reject", "/api/update/stop-candidate", "/api/wishlist/requeue"]);
    }
  });
});

test("D206 GitHub sync fast-forwards only the verified stable commit and preserves dirty admin files", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);
  await writeFile(path.join(fixture.repoRoot, "verified-stable.txt"), "dirty tracked edit\n", "utf8");
  await writeFile(path.join(fixture.repoRoot, "staged-local.txt"), "staged local admin file\n", "utf8");
  await git(fixture.repoRoot, "add", "staged-local.txt");
  await writeFile(path.join(fixture.repoRoot, "delete-me.txt"), "tracked deletion sentinel\n", "utf8");
  await writeFile(path.join(fixture.repoRoot, "rename-me.txt"), "tracked rename sentinel\n", "utf8");
  await git(fixture.repoRoot, "add", "delete-me.txt", "rename-me.txt");
  await git(fixture.repoRoot, "commit", "-m", "admin dirty baseline");
  await rm(path.join(fixture.repoRoot, "delete-me.txt"), { force: true });
  await rename(path.join(fixture.repoRoot, "rename-me.txt"), path.join(fixture.repoRoot, "renamed-local.txt"));
  await git(fixture.repoRoot, "add", "-A", "delete-me.txt", "rename-me.txt", "renamed-local.txt");
  await writeFile(path.join(fixture.repoRoot, "untracked-local.txt"), "untracked local admin file\n", "utf8");
  const dirtyBefore = await git(fixture.repoRoot, "status", "--porcelain=v1", "--untracked-files=all");
  const cachedBefore = await git(fixture.repoRoot, "diff", "--cached", "--binary");

  await withServer(t, fixture, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.response.status, 200, JSON.stringify(status.result));
    assert.equal(status.result.githubSync.stableSha, stableSha);
    assert.equal(status.result.githubSync.state, "fast-forward-ready");
    assert.equal(status.result.githubSync.canPush, true);

    const unconfirmed = await post("/api/github-sync", {});
    assert.equal(unconfirmed.response.status, 400);
    assert.match(unconfirmed.result.error, /explicit confirmation/);

    const synced = await post("/api/github-sync", { confirmed: true });
    assert.equal(synced.response.status, 200, JSON.stringify(synced.result));
    assert.equal(synced.result.result.state, "succeeded");
    assert.equal(synced.result.result.stableSha, stableSha);
    assert.deepEqual(synced.result.result.last.history.map((entry) => entry.status).slice(-5), ["requested", "validating", "fetching", "pushing", "succeeded"]);
    assert.equal(synced.result.result.last.previousRemoteSha, fixture.fixtureSha);
    assert.equal(synced.result.result.last.resultingRemoteSha, stableSha);
  });

  const remote = await git(fixture.repoRoot, "ls-remote", "origin", "refs/heads/master");
  assert.match(remote, new RegExp(`^${stableSha}\\s+refs/heads/master`));
  const dirtyAfter = await git(fixture.repoRoot, "status", "--porcelain=v1", "--untracked-files=all");
  assert.equal(dirtyAfter, dirtyBefore);
  assert.equal(await git(fixture.repoRoot, "diff", "--cached", "--binary"), cachedBefore);
  assert.equal(await readFile(path.join(fixture.repoRoot, "verified-stable.txt"), "utf8"), "dirty tracked edit\n");
  assert.equal(await readFile(path.join(fixture.repoRoot, "staged-local.txt"), "utf8"), "staged local admin file\n");
  assert.equal(await readFile(path.join(fixture.repoRoot, "renamed-local.txt"), "utf8"), "tracked rename sentinel\n");
  assert.equal(await readFile(path.join(fixture.repoRoot, "untracked-local.txt"), "utf8"), "untracked local admin file\n");
});

test("D210 GitHub sync reports already-synced as a successful no-op", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);
  await git(fixture.repoRoot, "push", "origin", `${stableSha}:refs/heads/master`);

  await withServer(t, fixture, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.response.status, 200, JSON.stringify(status.result));
    assert.equal(status.result.githubSync.state, "already-synced");
    assert.equal(status.result.githubSync.canPush, false);
    assert.equal(status.result.githubSync.remoteFreshness, "fresh");

    const synced = await post("/api/github-sync", { confirmed: true });
    assert.equal(synced.response.status, 200, JSON.stringify(synced.result));
    assert.equal(synced.result.result.state, "already-synced");
    assert.equal(synced.result.result.last.previousRemoteSha, stableSha);
    assert.equal(await remoteMaster(fixture), stableSha);
  });
});

test("D210 GitHub sync refuses GitHub-ahead and divergent remotes without mutating refs", async (t) => {
  const ahead = await makeFixture(t);
  await createBareOrigin(ahead);
  await assertLocalBareOrigin(ahead);
  const stableSha = await prepareVerifiedStable(ahead);
  await writeFile(path.join(ahead.repoRoot, "remote-ahead.txt"), "ahead\n", "utf8");
  await git(ahead.repoRoot, "add", "remote-ahead.txt");
  await git(ahead.repoRoot, "commit", "-m", "remote ahead");
  const aheadSha = await git(ahead.repoRoot, "rev-parse", "HEAD");
  await git(ahead.repoRoot, "push", "origin", `${aheadSha}:refs/heads/master`);
  await git(ahead.repoRoot, "reset", "--soft", stableSha);
  await withServer(t, ahead, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.result.githubSync.state, "github-ahead");
    const blocked = await post("/api/github-sync", { confirmed: true });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.result.error, /ahead/);
    assert.equal(await remoteMaster(ahead), aheadSha);
  });

  const divergent = await makeFixture(t);
  await createBareOrigin(divergent);
  await assertLocalBareOrigin(divergent);
  const divergentStableSha = await prepareVerifiedStable(divergent);
  await git(divergent.repoRoot, "checkout", "--detach", divergent.fixtureSha);
  await writeFile(path.join(divergent.repoRoot, "remote-diverged.txt"), "diverged\n", "utf8");
  await git(divergent.repoRoot, "add", "remote-diverged.txt");
  await git(divergent.repoRoot, "commit", "-m", "remote diverged");
  const divergedSha = await git(divergent.repoRoot, "rev-parse", "HEAD");
  await git(divergent.repoRoot, "push", "origin", `${divergedSha}:refs/heads/master`);
  await git(divergent.repoRoot, "checkout", "master");
  await withServer(t, divergent, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.result.githubSync.state, "diverged");
    const blocked = await post("/api/github-sync", { confirmed: true });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.result.error, /diverges/);
    assert.equal(await remoteMaster(divergent), divergedSha);
    assert.notEqual(divergedSha, divergentStableSha);
  });
});

test("D206 GitHub sync refuses unsafe boundaries and reports dashboard hooks", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);
  await fixture.setOrchestratorState({
    phase: "failed-paused",
    currentItem: { id: "W0023" },
    stableCommit: stableSha,
    acceptedSourceSha: stableSha,
  });

  await withServer(t, fixture, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.response.status, 200, JSON.stringify(status.result));
    assert.equal(status.result.githubSync.ok, false);
    assert.equal(status.result.githubSync.canPush, false);
    assert.match(status.result.githubSync.message, /phase=failed-paused/);

    const blocked = await post("/api/github-sync", { confirmed: true });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.result.error, /phase=failed-paused/);
  });

  const html = await readFile(path.join(here, "public", "index.html"), "utf8");
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  assert.match(html, /github-sync-button/);
  assert.match(html, /Push verified stable to origin\/master \(fast-forward only\)/);
  assert.match(app, /window\.confirm\(`Push verified stable/);
  assert.match(app, /\/api\/github-sync/);
});

test("D212 dashboard removes dead main-update client path and keeps server endpoint retired", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  await prepareVerifiedStable(fixture);
  await withServer(t, fixture, async ({ post }) => {
    const retired = await post("/api/main/update", { comment: "must remain retired", confirmed: true });
    assert.equal(retired.response.status, 410);
    assert.match(retired.result.error, /D196 replaced dashboard mutation paths/);
  });

  const html = await readFile(path.join(here, "public", "index.html"), "utf8");
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const publicText = `${html}\n${app}`;
  assert.doesNotMatch(publicText, /main\/update/);
  assert.doesNotMatch(publicText, /main-update-form/);
  assert.doesNotMatch(publicText, /main-update-comment/);
  assert.doesNotMatch(publicText, /Update main branch/);
});

test("D212 Versions tab renders one explicit GitHub sync push control", async () => {
  const html = await readFile(path.join(here, "public", "index.html"), "utf8");
  const panel = html.match(/<section class="panel update-panel github-sync-panel"[\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(panel, "missing GitHub sync panel");
  assert.equal([...panel.matchAll(/<button\b/g)].length, 1);
  assert.match(panel, /id="github-sync-button"/);
  assert.match(panel, /Push verified stable to origin\/master \(fast-forward only\)/);
  assert.doesNotMatch(panel, /<form\b/);
  assert.doesNotMatch(panel, /Update main branch|Integration comment/);
});

test("D212 GitHub sync panel renders disabled reason as visible text", async () => {
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", disabled: false, title: "", classList: { toggle() {} } });
    return elements.get(selector);
  };
  const renderGithubSync = new Function("state", "$", "relative", `${extractFunction(app, "githubSyncSummary", "renderVersions")}; return renderGithubSync;`)({}, get, () => "now");
  renderGithubSync({
    ok: false,
    canPush: false,
    state: "fast-forward-ready",
    disabledReason: "phase=failed-paused currentItem=W0032",
    message: "origin/master can fast-forward to the verified stable version.",
    stableShortSha: "abcdef0",
    remoteShortSha: "1234567",
    remoteFreshness: "fresh",
    remoteCheckedAt: "2026-08-07T00:00:00.000Z",
    last: { status: "succeeded", message: "Old success must not hide the current disabled reason." },
  });
  assert.equal(elements.get("#github-sync-message").textContent, "phase=failed-paused currentItem=W0032");
  assert.equal(elements.get("#github-sync-button").disabled, true);
});

test("D213 GitHub sync message prefers current boundary over stale last operation", async () => {
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", disabled: false, title: "", classList: { toggle() {} } });
    return elements.get(selector);
  };
  const renderGithubSync = new Function("state", "$", "relative", `${extractFunction(app, "githubSyncSummary", "renderVersions")}; return renderGithubSync;`)({}, get, () => "now");
  renderGithubSync({
    ok: true,
    canPush: false,
    state: "already-synced",
    disabledReason: "",
    message: "GitHub master already points at the verified stable version.",
    stableShortSha: "e585e77",
    remoteShortSha: "e585e77",
    remoteFreshness: "fresh",
    remoteCheckedAt: "2026-08-07T00:00:00.000Z",
    last: { status: "succeeded", message: "GitHub master now points at verified stable 1471762.", at: "2026-08-03T00:00:00.000Z" },
  });
  assert.equal(elements.get("#github-sync-message").textContent, "GitHub master already points at the verified stable version.");
  assert.doesNotMatch(elements.get("#github-sync-message").textContent, /1471762/);
  assert.equal(elements.get("#github-sync-summary").textContent, "origin/master is in sync with verified stable e585e77.");
  assert.doesNotMatch(elements.get("#github-sync-summary").textContent, /1471762/);
});

test("D213 GitHub sync panel renders surviving flow text without deleted main-update wording", async () => {
  const html = await readFile(path.join(here, "public", "index.html"), "utf8");
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const elements = new Map();
  const visibleValues = [];
  const get = (selector) => {
    if (!elements.has(selector)) {
      const element = {
        disabled: false,
        title: "",
        classList: { toggle() {} },
        get textContent() { return this._textContent || ""; },
        set textContent(value) {
          this._textContent = value;
          visibleValues.push(String(value));
        },
      };
      elements.set(selector, element);
    }
    return elements.get(selector);
  };
  const renderers = new Function("state", "$", "relative", `${extractFunction(app, "renderMainVersion", "renderVersions")}; return { renderMainVersion, renderGithubSync };`)({}, get, () => "now");
  for (const version of [
    { tag: "main-update-099", label: "main-update-099", stableShortSha: "abc0001", pendingStableCommits: 105 },
    { tag: null, label: "No tagged baseline", stableShortSha: "abc0001", pendingStableCommits: null },
  ]) {
    visibleValues.length = 0;
    renderers.renderMainVersion(version, { phase: "idle", activeRole: null });
    renderers.renderGithubSync({
      ok: true,
      canPush: true,
      state: "fast-forward-ready",
      message: "origin/master can fast-forward to the verified stable version.",
      stableShortSha: "abc0001",
      remoteShortSha: "abc0000",
      remoteFreshness: "fresh",
    });
    assert.doesNotMatch(visibleValues.join("\n"), /main update|main-update|main-update-001/i);
  }
  const panel = html.match(/<section class="panel update-panel github-sync-panel"[\s\S]*?<\/section>/)?.[0] || "";
  assert.doesNotMatch(panel, /main update|main-update|main-update-001/i);
});

test("D213 GitHub sync and relay-turn chips have separate visible owners", async () => {
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", disabled: false, title: "", classList: { toggle() {} } });
    return elements.get(selector);
  };
  const renderers = new Function("state", "$", "relative", `${extractFunction(app, "renderMainVersion", "renderVersions")}; return { renderMainVersion, renderGithubSync };`)({}, get, () => "now");
  renderers.renderMainVersion(
    { tag: "main-update-099", label: "main-update-099", stableShortSha: "e585e77", pendingStableCommits: 105 },
    { phase: "working", activeRole: "A" },
  );
  renderers.renderGithubSync({
    ok: true,
    canPush: false,
    state: "already-synced",
    message: "GitHub master already points at the verified stable version.",
    stableShortSha: "e585e77",
    remoteShortSha: "e585e77",
    remoteFreshness: "fresh",
  });
  assert.equal(elements.get("#github-sync-state").textContent, "Synced");
  assert.equal(elements.get("#github-sync-turn-state").textContent, "Active turn");
});

test("D212 GitHub sync cancellation is visible instead of a silent no-op", async () => {
  const app = await readFile(path.join(here, "public", "app.js"), "utf8");
  const elements = new Map([["#github-sync-message", { textContent: "" }], ["#approve-backup", { hidden: false }]]);
  const toasts = [];
  const githubSyncAction = new Function("state", "$", "window", "toast", "clearInterval", "setInterval", "refresh", "api", "setAlert", `let githubSyncPollTimer = null; ${extractFunction(app, "githubSyncAction", "renderApprovalFlow")}; return githubSyncAction;`)(
    { busy: false, data: { githubSync: { stableShortSha: "abcdef0", remoteShortSha: "1234567" } } },
    (selector) => elements.get(selector) || { textContent: "", hidden: false },
    { confirm: () => false },
    (message) => toasts.push(message),
    () => {},
    () => 1,
    async () => {},
    async () => { throw new Error("api must not run when confirmation is cancelled"); },
    () => {},
  );
  await githubSyncAction();
  assert.equal(elements.get("#github-sync-message").textContent, "GitHub sync cancelled before any remote change.");
  assert.deepEqual(toasts, ["GitHub sync cancelled"]);
});

test("D210 GitHub sync rejects unsafe D196 phases, evidence mismatches, and runtime integrity failures", async (t) => {
  for (const phase of ["improving", "swapping"]) {
    const fixture = await makeFixture(t);
    await createBareOrigin(fixture);
    await assertLocalBareOrigin(fixture);
    const stableSha = await prepareVerifiedStable(fixture);
    await fixture.setOrchestratorState({ phase, stableCommit: stableSha, acceptedSourceSha: stableSha });
    await withServer(t, fixture, async ({ get, post }) => {
      const status = await get("/api/status");
      assert.equal(status.result.githubSync.ok, false);
      assert.match(status.result.githubSync.message, new RegExp(`phase=${phase}`));
      const blocked = await post("/api/github-sync", { confirmed: true });
      assert.equal(blocked.response.status, 400);
    });
  }

  const cases = [
    {
      name: "accepted source",
      setup: async (fixture, stableSha) => fixture.setOrchestratorState({ stableCommit: stableSha, acceptedSourceSha: fixture.fixtureSha }),
      pattern: /Accepted source/,
    },
    {
      name: "stable ref",
      setup: async (fixture) => git(fixture.repoRoot, "update-ref", "refs/tandem-relay/stable", fixture.fixtureSha),
      pattern: /Stable ref/,
    },
    {
      name: "operation evidence",
      setup: async (fixture) => writeFile(path.join(fixture.relayRoot, "control", "orchestrator-operations.ndjson"), "", "utf8"),
      pattern: /Stable operation evidence/,
    },
    {
      name: "executor build",
      setup: async (fixture) => writeJson(path.join(fixture.relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"), { sourceSha: fixture.fixtureSha }),
      pattern: /Executor A build/,
    },
    {
      name: "runtime integrity",
      setup: async (fixture) => writeFile(path.join(fixture.relayRoot, "runtimes", "executor-a", "Tandem.exe"), "tampered runtime\n", "utf8"),
      pattern: /Executor A integrity/,
    },
  ];

  for (const item of cases) {
    const fixture = await makeFixture(t);
    await createBareOrigin(fixture);
    await assertLocalBareOrigin(fixture);
    const stableSha = await prepareVerifiedStable(fixture);
    await item.setup(fixture, stableSha);
    await withServer(t, fixture, async ({ get, post }) => {
      const status = await get("/api/status");
      assert.equal(status.result.githubSync.ok, false, item.name);
      assert.match(status.result.githubSync.message, item.pattern, item.name);
      const blocked = await post("/api/github-sync", { confirmed: true });
      assert.equal(blocked.response.status, 400, item.name);
      assert.match(blocked.result.error, item.pattern, item.name);
      assert.equal(await remoteMaster(fixture), fixture.fixtureSha, item.name);
    });
  }
});

test("D210 GitHub sync sanitizes remote fetch failures and labels stale status", async (t) => {
  const fixture = await makeFixture(t);
  const origin = await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);
  await git(fixture.repoRoot, "push", "origin", `${stableSha}:refs/heads/master`);
  await git(fixture.repoRoot, "remote", "set-url", "origin", "https://user:super-secret@example.invalid/repo.git?token=top-secret");

  await withServer(t, fixture, async ({ get, post }) => {
    const status = await get("/api/status");
    assert.equal(status.response.status, 200, JSON.stringify(status.result));
    assert.doesNotMatch(JSON.stringify(status.result.githubSync), /super-secret|top-secret/);
    assert.ok(["stale", "unavailable"].includes(status.result.githubSync.remoteFreshness));

    const blocked = await post("/api/github-sync", { confirmed: true });
    assert.equal(blocked.response.status, 400);
    assert.doesNotMatch(blocked.result.error, /super-secret|top-secret/);
  }, { env: { TANDEM_GITHUB_REMOTE_STATUS_TIMEOUT_MS: "1" } });

  await git(fixture.repoRoot, "remote", "set-url", "origin", origin);
});

test("D206 GitHub sync deduplicates concurrent requests", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  await prepareVerifiedStable(fixture);

  await withServer(t, fixture, async ({ post }) => {
    const [first, second] = await Promise.all([
      post("/api/github-sync", { confirmed: true }),
      post("/api/github-sync", { confirmed: true }),
    ]);
    const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    const busy = [first, second].find((item) => item.response.status === 409);
    assert.match(busy.result.error, /already in progress/);
  }, { env: { TANDEM_GITHUB_SYNC_HOLD_MS: "300" } });
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.filter((entry) => entry.action === "github.sync" && entry.ok).length, 1);
});

test("D211 GitHub sync keeps success lifecycle history while status polling refreshes remote probes", async (t) => {
  const fixture = await makeFixture(t);
  await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);

  await withServer(t, fixture, async ({ get, post }) => {
    const syncPromise = post("/api/github-sync", { confirmed: true });
    const polls = await pollStatusDuring(syncPromise, get);
    const synced = await syncPromise;
    assert.equal(synced.response.status, 200, JSON.stringify(synced.result));
    assert.ok(polls.length > 0, "status polling overlapped the active sync operation");

    const durable = await readJson(path.join(fixture.relayRoot, "control", "GITHUB_SYNC_STATE.json"));
    assert.deepEqual(lastLifecyclePath(durable), ["requested", "validating", "fetching", "pushing", "succeeded"]);
    assert.equal(durable.stableSha, stableSha);
    assert.equal(durable.previousRemoteSha, fixture.fixtureSha);
    assert.equal(durable.resultingRemoteSha, stableSha);
    assert.equal(durable.remoteProbe.sha, stableSha);

    const status = await get("/api/status");
    assert.deepEqual(lastLifecyclePath(status.result.githubSync.last), ["requested", "validating", "fetching", "pushing", "succeeded"]);
    assert.equal(status.result.githubSync.last.remoteProbe.sha, stableSha);
    assert.equal(await remoteMaster(fixture), stableSha);
  }, { env: { TANDEM_GITHUB_SYNC_HOLD_MS: "200", TANDEM_GITHUB_SYNC_STATE_WRITE_HOLD_MS: "30" } });
});

test("D211 GitHub sync keeps failed lifecycle history and sanitized error while status polling refreshes remote probes", async (t) => {
  const fixture = await makeFixture(t);
  const origin = await createBareOrigin(fixture);
  await assertLocalBareOrigin(fixture);
  const stableSha = await prepareVerifiedStable(fixture);
  await git(fixture.repoRoot, "push", "origin", `${stableSha}:refs/heads/master`);
  await git(fixture.repoRoot, "remote", "set-url", "origin", "https://user:super-secret@example.invalid/repo.git?token=top-secret");

  await withServer(t, fixture, async ({ get, post }) => {
    const syncPromise = post("/api/github-sync", { confirmed: true });
    const polls = await pollStatusDuring(syncPromise, get);
    const failed = await syncPromise;
    assert.equal(failed.response.status, 400, JSON.stringify(failed.result));
    assert.ok(polls.length > 0, "status polling overlapped the failed sync operation");

    const durable = await readJson(path.join(fixture.relayRoot, "control", "GITHUB_SYNC_STATE.json"));
    assert.deepEqual(lastLifecyclePath(durable), ["requested", "validating", "fetching", "failed"]);
    assert.equal(durable.stableSha, stableSha);
    assert.equal(durable.status, "failed");
    assert.doesNotMatch(durable.error, /super-secret|top-secret/);
    assert.doesNotMatch(JSON.stringify(durable), /super-secret|top-secret/);
    assert.ok(durable.remoteProbe || durable.updatedAt);

    const status = await get("/api/status");
    assert.equal(status.result.githubSync.last.status, "failed");
    assert.deepEqual(lastLifecyclePath(status.result.githubSync.last), ["requested", "validating", "fetching", "failed"]);
    assert.doesNotMatch(JSON.stringify(status.result.githubSync.last), /super-secret|top-secret/);
  }, { env: { TANDEM_GITHUB_REMOTE_STATUS_TIMEOUT_MS: "1", TANDEM_GITHUB_SYNC_STATE_WRITE_HOLD_MS: "30" } });

  await git(fixture.repoRoot, "remote", "set-url", "origin", origin);
});

test("D197 dashboard watchdog audits orchestrator status without retired supervisor calls", async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), {
    phase: "idle",
    currentItem: null,
    stableCommit: fixture.fixtureSha,
  });
  await withServer(t, fixture, async () => {
    const audit = await waitForAudit(fixture.auditPath, (entry) => entry.action === "orchestrator.status" && entry.source === "dashboard-startup");
    assert.equal(audit.some((entry) => entry.action === "orchestrator.status" && entry.source === "dashboard-startup"), true);
    assert.equal(audit.some((entry) => entry.action === "supervisor.tick"), false);
  }, { env: { TANDEM_DASHBOARD_ENABLE_TEST_ORCHESTRATOR_STATUS: "1" } });
});

test("D199 dashboard reports admin-repo orchestrator trigger freshness", async (t) => {
  const fixture = await makeFixture(t);
  const updatedAt = new Date().toISOString();
  await writeJson(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), {
    phase: "idle",
    currentItem: null,
    stableCommit: fixture.fixtureSha,
    updatedAt,
  });
  const trigger = {
    exists: true,
    taskName: "TandemReciprocalOrchestrator",
    state: "Ready",
    executable: path.join("C:", "Windows", "System32", "wscript.exe"),
    arguments: `"${path.join(fixture.repoRoot, "scripts", "reciprocal-orchestrator-hidden.vbs")}" "${process.execPath}" "${path.join(fixture.repoRoot, "scripts", "reciprocal-orchestrator.mjs")}" --repo "${fixture.repoRoot}" --relay-root "${fixture.relayRoot}"`,
    workingDirectory: fixture.repoRoot,
    lastRunTime: updatedAt,
    nextRunTime: new Date(Date.now() + 300_000).toISOString(),
    lastTaskResult: 0,
  };
  await withServer(t, fixture, async ({ get }) => {
    const { response, result } = await get("/api/status");
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.orchestrator.trigger.configured, true);
    assert.equal(result.orchestrator.trigger.ok, true);
    assert.equal(result.orchestrator.trigger.scriptMatchesAdminRepo, true);
    assert.equal(result.orchestrator.trigger.launcherWindowless, true);
    assert.equal(result.orchestrator.trigger.workingDirectoryMatchesAdminRepo, true);
    assert.equal(result.health.some((entry) => entry.label === "Orchestrator trigger" && entry.ok), true);
  }, { env: { TANDEM_ORCHESTRATOR_TRIGGER_JSON: JSON.stringify(trigger) } });
});

test("D199 dashboard warns when the orchestrator trigger points outside the admin repo", async (t) => {
  const fixture = await makeFixture(t);
  await writeJson(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), {
    phase: "idle",
    currentItem: null,
    stableCommit: fixture.fixtureSha,
    updatedAt: new Date().toISOString(),
  });
  const wrongWorktree = path.join(fixture.relayRoot, "worktrees", "copy-b");
  const trigger = {
    exists: true,
    taskName: "TandemReciprocalOrchestrator",
    state: "Ready",
    executable: "powershell.exe",
    arguments: `-NoProfile -ExecutionPolicy Bypass -File "${path.join(wrongWorktree, "scripts", "reciprocal-orchestrator.ps1")}"`,
    workingDirectory: wrongWorktree,
    lastRunTime: new Date().toISOString(),
    nextRunTime: new Date(Date.now() + 300_000).toISOString(),
    lastTaskResult: 0,
  };
  await withServer(t, fixture, async ({ get }) => {
    const { response, result } = await get("/api/status");
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.orchestrator.trigger.configured, false);
    assert.equal(result.orchestrator.trigger.ok, false);
    assert.match(result.orchestrator.trigger.detail, /does not target/);
    assert.equal(result.health.some((entry) => entry.label === "Orchestrator trigger" && !entry.ok), true);
  }, { env: { TANDEM_ORCHESTRATOR_TRIGGER_JSON: JSON.stringify(trigger) } });
});

test("D199 scheduler installer targets the admin repo orchestrator script", async () => {
  const source = await readFile(path.join(adminRepo, "scripts", "register-reciprocal-orchestrator-task.ps1"), "utf8");
  assert.doesNotMatch(source, /New-ScheduledTaskAction -Execute "powershell\.exe"/);
  assert.match(source, /Get-Command node\.exe/);
  assert.match(source, /reciprocal-orchestrator-hidden\.vbs/);
  assert.match(source, /reciprocal-orchestrator\.mjs/);
  assert.match(source, /--repo/);
  assert.match(source, /--relay-root/);
  assert.match(source, /-WorkingDirectory \$Repo/);
  assert.match(source, /MultipleInstances IgnoreNew/);
});

const windowsHiddenLauncherTest = process.platform === "win32" ? test : test.skip;

async function runHiddenLauncher(fixture, extraEnv = {}, extraArgs = []) {
  const launcher = path.join(adminRepo, "scripts", "reciprocal-orchestrator-hidden.vbs");
  const script = path.join(adminRepo, "scripts", "reciprocal-orchestrator.mjs");
  const child = spawn("wscript.exe", [launcher, process.execPath, script, "--repo", fixture.repoRoot, "--relay-root", fixture.relayRoot, ...extraArgs], {
    cwd: fixture.repoRoot,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  const [code] = await once(child, "close");
  return code;
}

windowsHiddenLauncherTest("D207 hidden orchestrator launcher preserves idle success logging and exit code", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setOrchestratorState({ phase: "idle", currentItem: null });
  await writeFile(fixture.wishlistPath, "", "utf8");
  const code = await runHiddenLauncher(fixture);
  assert.equal(code, 0);
  const operations = await readJsonl(path.join(fixture.relayRoot, "control", "orchestrator-operations.ndjson"));
  assert.equal(operations.some((entry) => entry.action === "idle.no-work"), true);
});

windowsHiddenLauncherTest("D207 hidden orchestrator launcher propagates failing exit code with operations log evidence", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setOrchestratorState({ phase: "idle", currentItem: null });
  const code = await runHiddenLauncher(fixture, {}, ["--cutover"]);
  assert.equal(code, 3);
  const operations = await readJsonl(path.join(fixture.relayRoot, "control", "orchestrator-operations.ndjson"));
  assert.equal(operations.some((entry) => entry.action === "package-b.failed" && entry.exitCode !== 0), true);
  assert.equal(operations.some((entry) => entry.action === "cutover.swap.failed-paused"), true);
});

test("D198 dashboard source has no legacy Kickstart supervisor implementation", async () => {
  const source = await readFile(serverScript, "utf8");
  assert.equal(source.includes("runSupervisorController"), false);
  assert.equal(source.includes("kickstartPrompt"), false);
  assert.equal(source.includes("manual-kickstart"), false);
  assert.equal(source.includes("continue-reciprocal-automation.ps1"), false);
  assert.match(source, /D196 replaced dashboard mutation paths/);
});

legacyDashboardMutationTest("D181 Kickstart starts only Executor A and treats B dormant as healthy", async (t) => {
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

legacyDashboardMutationTest("approval flow uses the real relay to complete an inactive A-upgrade boundary", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "fixture approval" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
    assert.deepEqual(result.result.steps.map((step) => step.step), [
      "recovery-authority-promoted",
      "recovery-authority-ready",
      "review-recorded",
      "a-upgrade-boundary",
      "executor-a-stopped",
      "runtime-a-promoted",
      "executor-a-restarted",
      "a-upgrade-completed",
      "recovery-authority-stopped",
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
  const promoteCommands = commands.filter((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1"));
  assert.equal(promoteCommands.length, 2);
  assert.deepEqual(promoteCommands.map((entry) => entry.args[entry.args.indexOf("-TargetRole") + 1]), ["B", "A"]);
  assert.equal(promoteCommands.every((entry) => entry.args.includes("-SourceSha") && entry.args[entry.args.indexOf("-SourceSha") + 1] === fixture.fixtureSha), true);
  const approvalStartCommands = commands.filter((entry) => String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1"));
  assert.equal(approvalStartCommands.length, 2);
  assert.deepEqual(approvalStartCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["B", "A"]);
  const stopCommands = commands.filter((entry) => String(entry.args[1]).endsWith("stop-reciprocal-tandem.ps1"));
  assert.deepEqual(stopCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["A", "B"]);
  const automationCalls = commands.filter((entry) => entry.args[0] === "AUTOMATION");
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/prompt"), false);
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/status"), true);

  const state = await readJson(fixture.statePath);
  assert.equal(state.phase, "idle");
  assert.equal(state.activeRole, null);
  assert.equal(state.nextRole, "A");
  assert.equal(state.stableCommit, fixture.fixtureSha);
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.some((entry) => entry.step === "a-upgrade-completed" && /a_upgrade_completed/.test(entry.detail)), true);
  const journal = await readJson(path.join(fixture.relayRoot, "state", "runtime-recovery-flow.json"));
  assert.equal(journal.stage, "b-stopped");
  assert.deepEqual(journal.durableStages, [
    "package-ready",
    "b-promote-started",
    "b-promoted",
    "b-start-started",
    "b-started",
    "b-verified",
    "approval-recorded",
    "a-stop-started",
    "a-stopped",
    "a-promote-started",
    "a-promoted",
    "a-start-started",
    "a-started",
    "a-verified",
    "relay-completed",
    "b-stop-started",
    "b-stopped",
  ]);
  await writeEvidence("approval-flow", { commands, actions, state, journal, auditSteps: audit.filter((entry) => entry.action === "update.approvalStep").map((entry) => ({ step: entry.step, detail: entry.detail })) });
});

legacyDashboardMutationTest("D183 approval adopts relay-verified B without re-promoting or restarting it", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState({ runtimeRecoveryStage: "b-runtime-verified" });
  await writeJson(path.join(fixture.relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"), {
    sourceSha: fixture.oldSha,
    sourceShortSha: "0000000",
    packageIdentity: "old-a",
  });
  const runtimeBDir = path.join(fixture.relayRoot, "runtimes", "executor-b");
  await rm(runtimeBDir, { recursive: true, force: true });
  await mkdir(runtimeBDir, { recursive: true });
  await cp(fixture.candidateRuntimeDir, runtimeBDir, { recursive: true });
  await writeJson(path.join(fixture.relayRoot, "state", "executor-b", "automation.json"), {
    port: 4102,
    token: "test-token-B",
    pid: 4102,
    projectDir: fixture.copyA,
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  await writeJson(path.join(fixture.relayRoot, "state", "runtime-recovery-flow.json"), {
    schemaVersion: 1,
    id: "relay-recovery-fixture",
    status: "running",
    stage: "b-verified",
    durableStages: [
      "package-ready",
      "b-promote-started",
      "b-promoted",
      "b-start-started",
      "b-started",
      "b-verified",
      "approval-recorded",
      "a-stop-started",
      "a-stopped",
      "a-promote-started",
      "a-promoted",
      "a-start-started",
      "a-started",
      "a-verified",
      "relay-completed",
      "b-stop-started",
      "b-stopped",
    ],
    sourceSha: fixture.fixtureSha,
    packageIdentity: fixture.fixturePackage,
    immutablePackagePath: fixture.immutablePackagePath,
    proof: { bEndpoint: { sourceSha: fixture.fixtureSha, packageIdentity: fixture.fixturePackage, allowedProjectDir: fixture.copyA } },
    flags: { recoveryAuthorityReady: true },
    steps: [{ step: "recovery-authority-ready", ok: true, detail: "relay verified B", at: "2026-07-22T00:00:00.000Z" }],
    updatedAt: "2026-07-22T00:00:00.000Z",
  });

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "adopt relay B" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
  });

  const commands = await readJsonl(fixture.commandLog);
  const promoteCommands = commands.filter((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1"));
  assert.deepEqual(promoteCommands.map((entry) => entry.args[entry.args.indexOf("-TargetRole") + 1]), ["A"]);
  const startCommands = commands.filter((entry) => String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1"));
  assert.deepEqual(startCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["A"]);
  const automationCalls = commands.filter((entry) => entry.args[0] === "AUTOMATION");
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/prompt"), false);
  const finalJournal = await readJson(path.join(fixture.relayRoot, "state", "runtime-recovery-flow.json"));
  assert.equal(finalJournal.stage, "b-stopped");
  assert.equal(finalJournal.packageIdentity, fixture.fixturePackage);
});

legacyDashboardMutationTest("D195 approval accepts older endpoint status without optional echo fields", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "old endpoint schema approval" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
  }, { env: { TANDEM_DASHBOARD_TEST_STATUS_SCHEMA: "old-no-echoes" } });

  const commands = await readJsonl(fixture.commandLog);
  const automationCalls = commands.filter((entry) => entry.args[0] === "AUTOMATION");
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/status"), true);
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/prompt"), false);
  const state = await readJson(fixture.statePath);
  assert.equal(state.phase, "idle");
  assert.equal(state.nextRole, "A");
});

legacyDashboardMutationTest("D195 approval still rejects hard endpoint identity mismatches", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "bad endpoint identity" });
    assert.equal(response.status, 400, JSON.stringify(result));
    assert.match(result.error, /endpoint instance mismatch/i);
  }, { env: { TANDEM_DASHBOARD_TEST_STATUS_B_InstanceId: "wrong-B" } });

  const commands = await readJsonl(fixture.commandLog);
  assert.equal(commandActions(commands).some((entry) => entry.action === "CompleteAUpgrade"), false);
  const state = await readJson(fixture.statePath);
  assert.equal(state.phase, "a-upgrade-pending");
  assert.equal(state.activeRole, null);
});

legacyDashboardMutationTest("D181 failed A restart leaves B online as recovery authority", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();
  const previousFailRole = process.env.TANDEM_DASHBOARD_TEST_FAIL_WAIT_ROLE;
  process.env.TANDEM_DASHBOARD_TEST_FAIL_WAIT_ROLE = "A";
  try {
    await withServer(t, fixture, async ({ post }) => {
      const { response, result } = await post("/api/update/approve", { comment: "fixture approval with restart failure" });
      assert.equal(response.status, 400, JSON.stringify(result));
      assert.match(result.error, /executor A automation failed/i);
    });
  } finally {
    if (previousFailRole === undefined) delete process.env.TANDEM_DASHBOARD_TEST_FAIL_WAIT_ROLE;
    else process.env.TANDEM_DASHBOARD_TEST_FAIL_WAIT_ROLE = previousFailRole;
  }

  const commands = await readJsonl(fixture.commandLog);
  const promoteCommands = commands.filter((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1"));
  assert.deepEqual(promoteCommands.map((entry) => entry.args[entry.args.indexOf("-TargetRole") + 1]), ["B", "A"]);
  const startCommands = commands.filter((entry) => String(entry.args[1]).endsWith("start-reciprocal-tandem.ps1"));
  assert.deepEqual(startCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["B", "A"]);
  const stopCommands = commands.filter((entry) => String(entry.args[1]).endsWith("stop-reciprocal-tandem.ps1"));
  assert.deepEqual(stopCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["A"]);
  assert.equal(commandActions(commands).some((entry) => entry.action === "CompleteAUpgrade"), false);
  const automationCalls = commands.filter((entry) => entry.args[0] === "AUTOMATION");
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/prompt"), false);
  const state = await readJson(fixture.statePath);
  assert.equal(state.phase, "a-upgrade-pending");
  assert.equal(state.activeRole, null);

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "retry after A restart failure" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
    assert.equal(result.result.steps.filter((step) => step.step === "review-recorded").length, 1);
  });
  const recoveredState = await readJson(fixture.statePath);
  assert.equal(recoveredState.phase, "idle");
  assert.equal(recoveredState.nextRole, "A");
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.filter((entry) => entry.action === "update.review" && entry.decision === "approve").length, 1);
});

legacyDashboardMutationTest("D182 dashboard crash after A stop resumes from durable recovery journal", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.setState();
  const previousCrash = process.env.TANDEM_DASHBOARD_TEST_CRASH_AFTER_STEP;
  process.env.TANDEM_DASHBOARD_TEST_CRASH_AFTER_STEP = "executor-a-stopped";
  try {
    await withServer(t, fixture, async ({ post }) => {
      await assert.rejects(
        () => post("/api/update/approve", { comment: "crash-boundary approval" }),
        /fetch failed|terminated|other side closed|socket hang up/i,
      );
    });
  } finally {
    if (previousCrash === undefined) delete process.env.TANDEM_DASHBOARD_TEST_CRASH_AFTER_STEP;
    else process.env.TANDEM_DASHBOARD_TEST_CRASH_AFTER_STEP = previousCrash;
  }

  const journalAfterCrash = await readJson(path.join(fixture.relayRoot, "state", "runtime-recovery-flow.json"));
  assert.equal(journalAfterCrash.stage, "a-stopped");
  assert.equal(journalAfterCrash.sourceSha, fixture.fixtureSha);

  await withServer(t, fixture, async ({ post }) => {
    const { response, result } = await post("/api/update/approve", { comment: "resume after dashboard crash" });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.result.current, "complete");
  });

  const commands = await readJsonl(fixture.commandLog);
  const promoteCommands = commands.filter((entry) => String(entry.args[1]).endsWith("promote-reciprocal-runtime.ps1"));
  assert.deepEqual(promoteCommands.map((entry) => entry.args[entry.args.indexOf("-TargetRole") + 1]), ["B", "A"]);
  const stopCommands = commands.filter((entry) => String(entry.args[1]).endsWith("stop-reciprocal-tandem.ps1"));
  assert.deepEqual(stopCommands.map((entry) => entry.args[entry.args.indexOf("-Role") + 1]), ["A", "B"]);
  const automationCalls = commands.filter((entry) => entry.args[0] === "AUTOMATION");
  assert.equal(automationCalls.some((entry) => entry.args[1] === "B" && entry.args[3] === "/prompt"), false);
  const audit = await readJsonl(fixture.auditPath);
  assert.equal(audit.filter((entry) => entry.action === "update.review" && entry.decision === "approve").length, 1);
  const finalJournal = await readJson(path.join(fixture.relayRoot, "state", "runtime-recovery-flow.json"));
  assert.equal(finalJournal.stage, "b-stopped");
  await writeEvidence("approval-crash-boundary", { commands, journalAfterCrash, finalJournal });
});

legacyDashboardMutationTest("authority flow uses authenticated dashboard API to approve one relay checkpoint", async (t) => {
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

legacyDashboardMutationTest("recovery flow closes the stranded gate without promotion and rejects unsafe states", async (t) => {
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
