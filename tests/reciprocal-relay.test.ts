import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import net from "node:net";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("reciprocal relay script", () => {
  async function initRepo(repo: string) {
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "relay@example.test"], { cwd: repo });
    await execa("git", ["config", "user.name", "Relay Test"], { cwd: repo });
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await mkdir(path.join(repo, "process", "reciprocal"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
    await writeFile(path.join(repo, ".gitignore"), ".tandem/\nrelease/\nrelease*/\nnode_modules/\n", "utf8");
    await writeFile(
      path.join(repo, "process", "reciprocal", "gate-taxonomy.json"),
      await readFile(path.resolve("process/reciprocal/gate-taxonomy.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "reciprocal-direction.ps1"),
      await readFile(path.resolve("scripts/reciprocal-direction.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "promote-reciprocal-runtime.ps1"),
      await readFile(path.resolve("scripts/promote-reciprocal-runtime.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "package-passive-runtime.ps1"),
      await readFile(path.resolve("scripts/package-passive-runtime.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "start-reciprocal-tandem.ps1"),
      await readFile(path.resolve("scripts/start-reciprocal-tandem.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "runtime-package-integrity.mjs"),
      await readFile(path.resolve("scripts/runtime-package-integrity.mjs"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "recover-reciprocal-relay-state.ps1"),
      await readFile(path.resolve("scripts/recover-reciprocal-relay-state.ps1"), "utf8"),
      "utf8",
    );
    await execa("git", ["add", "README.md", ".gitignore", "process/reciprocal/gate-taxonomy.json", "scripts/reciprocal-direction.ps1", "scripts/promote-reciprocal-runtime.ps1", "scripts/package-passive-runtime.ps1", "scripts/start-reciprocal-tandem.ps1", "scripts/runtime-package-integrity.mjs", "scripts/recover-reciprocal-relay-state.ps1"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });
    await execa("git", ["branch", "codex/reciprocal-a"], { cwd: repo });
    await execa("git", ["branch", "codex/reciprocal-b"], { cwd: repo });
    await execa("git", ["switch", "codex/reciprocal-b"], { cwd: repo });
  }

  async function relay(repo: string, ...args: string[]) {
    const script = path.resolve("scripts/reciprocal-relay.ps1");
    const result = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { cwd: repo });
    return JSON.parse(result.stdout);
  }

  async function relayWithEnv(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
    const script = path.resolve("scripts/reciprocal-relay.ps1");
    const result = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { cwd: repo, env });
    return JSON.parse(result.stdout);
  }

  function relayRoot(repo: string) {
    return path.join(repo, ".tandem", "relay-root");
  }

  function relayEnv(repo: string) {
    return { ...process.env, TANDEM_RECIPROCAL_ROOT: relayRoot(repo) };
  }

  function vitestBinEnv(repo: string) {
    return { ...relayEnv(repo), PATH: `${path.join(repo, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}` };
  }

  function normalizePassiveFailureEvidence(value: unknown): unknown {
    if (typeof value === "string") {
      return value
        .replace(/tandem-stable-baseline-[a-f0-9]+/gi, "tandem-stable-baseline-<id>")
        .replace(/Start at\s+\d{2}:\d{2}:\d{2}/g, "Start at <time>")
        .replace(/Duration\s+[^\r\n]+/g, "Duration <duration>")
        .replace(/\s+\d+(?:\.\d+)?ms/g, " <ms>");
    }
    if (Array.isArray(value)) return value.map((entry) => normalizePassiveFailureEvidence(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizePassiveFailureEvidence(entry)]));
    }
    return value;
  }

  async function enableVitestFixture(repo: string, source: string) {
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await mkdir(path.join(repo, "node_modules", ".bin"), { recursive: true });
    const vitestEntry = path.resolve("node_modules", "vitest", "vitest.mjs").replaceAll("\\", "/");
    await writeFile(
      path.join(repo, "node_modules", ".bin", "vitest.cmd"),
      `@echo off\r\nnode "${vitestEntry}" %*\r\n`,
      "utf8",
    );
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: `node "${vitestEntry}" run --configLoader runner` } }, null, 2),
      "utf8",
    );
    await writeFile(path.join(repo, "tests", "example.test.ts"), source, "utf8");
    await execa("git", ["add", "package.json", "tests/example.test.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "add vitest fixture"], { cwd: repo });
  }

  async function freePort() {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  async function stopProcess(pid: number | undefined) {
    if (!pid) return;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  function signedAuthorityEnv(request: Record<string, string>, decision: "approve" | "deny", secret = "dashboard-secret") {
    const expiresAtUtc = new Date(Date.now() + 120_000).toISOString();
    const binding = [
      decision,
      request.requestId,
      request.id,
      request.owner,
      request.authority,
      request.action,
      request.checkpoint,
      request.resume,
      expiresAtUtc,
    ].join("\n");
    const packet = {
      decision,
      requestId: request.requestId,
      id: request.id,
      owner: request.owner,
      authority: request.authority,
      action: request.action,
      checkpoint: request.checkpoint,
      resume: request.resume,
      expiresAtUtc,
      signature: createHmac("sha256", secret).update(binding).digest("hex"),
    };
    return {
      TANDEM_AUTHORITY_DECISION_SECRET: secret,
      TANDEM_AUTHORITY_DECISION_PACKET: JSON.stringify(packet),
    };
  }

  async function writeSharedBoard(repo: string, line: string) {
    const boardDir = path.join(repo, ".tandem", "shared-control");
    await mkdir(boardDir, { recursive: true });
    const boardPath = path.join(boardDir, "WISHLIST.md");
    await writeFile(
      boardPath,
      [
        "# Tandem Reciprocal: Shared Direction",
        "",
        "AutonomyDefault: plan-gated",
        "",
        "## Wishlist And Progress",
        "",
        "<!-- wishlist-items -->",
        line,
        "",
      ].join("\n"),
      "utf8",
    );
    return boardPath;
  }

  async function withPreparedRuntime<T>(repo: string, run: () => Promise<T>) {
    const preparedRuntime = path.join(repo, ".tandem", "prepared-runtime", "win-unpacked");
    await mkdir(preparedRuntime, { recursive: true });
    await copyFile(process.execPath, path.join(preparedRuntime, "Tandem.exe"));
    const fakeRuntime = path.join(repo, ".tandem", "fake-runtime.mjs");
    await writeFile(fakeRuntime, `
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const value = (name) => process.argv.find((arg) => arg.startsWith(\`--\${name}=\`))?.slice(name.length + 3) || "";
const port = Number(value("automation-port"));
const tokenFile = value("automation-token-file");
const projectDir = path.resolve(value("automation-project-dir"));
const token = "fixture-token-" + process.pid;
const buildInfoPath = process.env.TANDEM_RUNTIME_BUILD_INFO;
const buildInfo = buildInfoPath ? JSON.parse(await readFile(buildInfoPath, "utf8")) : {};
await mkdir(path.dirname(tokenFile), { recursive: true });
await writeFile(tokenFile, JSON.stringify({ port, token, pid: process.pid, instanceId: process.env.TANDEM_INSTANCE_ID || null, projectDir, createdAt: new Date().toISOString() }, null, 2) + "\\n", "utf8");
const server = createServer((request, response) => {
  if (request.headers.authorization !== \`Bearer \${token}\`) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid automation token." }));
    return;
  }
  if (request.method === "GET" && request.url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      port,
      instanceId: process.env.TANDEM_INSTANCE_ID || null,
      allowedProjectDir: projectDir,
      projectDir,
      tokenFile,
      sourceSha: buildInfo.sourceSha,
      packageIdentity: buildInfo.packageIdentity,
      capabilities: buildInfo.reciprocalCapabilities || { candidatePreviewArtifactLifecycle: 1 },
      running: false
    }));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});
server.listen(port, "127.0.0.1");
`, "utf8");
    const previousPrepared = process.env.TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED;
    const previousBEntry = process.env.TANDEM_EXECUTOR_B_NODE_ENTRY;
    const previousRelayRoot = process.env.TANDEM_RECIPROCAL_ROOT;
    const previousPortB = process.env.TANDEM_AUTOMATION_PORT_B;
    process.env.TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED = preparedRuntime;
    process.env.TANDEM_EXECUTOR_B_NODE_ENTRY = fakeRuntime;
    process.env.TANDEM_RECIPROCAL_ROOT = relayRoot(repo);
    process.env.TANDEM_AUTOMATION_PORT_B = String(await freePort());
    try {
      return await run();
    } finally {
      if (previousPrepared === undefined) {
        delete process.env.TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED;
      } else {
        process.env.TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED = previousPrepared;
      }
      if (previousBEntry === undefined) {
        delete process.env.TANDEM_EXECUTOR_B_NODE_ENTRY;
      } else {
        process.env.TANDEM_EXECUTOR_B_NODE_ENTRY = previousBEntry;
      }
      if (previousRelayRoot === undefined) {
        delete process.env.TANDEM_RECIPROCAL_ROOT;
      } else {
        process.env.TANDEM_RECIPROCAL_ROOT = previousRelayRoot;
      }
      if (previousPortB === undefined) {
        delete process.env.TANDEM_AUTOMATION_PORT_B;
      } else {
        process.env.TANDEM_AUTOMATION_PORT_B = previousPortB;
      }
    }
  }

  async function stopRelayProcess(relayRoot: string, role = "b") {
    try {
      const token = JSON.parse(await readFile(path.join(relayRoot, "state", `executor-${role}`, "automation.json"), "utf8"));
      await stopProcess(Number(token.pid));
    } catch {
      // Best-effort cleanup for isolated fixture processes.
    }
    try {
      const psRelayRoot = relayRoot.replaceAll("'", "''");
      spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `$root='${psRelayRoot}'; $deadline=(Get-Date).AddSeconds(5); do { $procs=@(Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } catch { $false } }); if($procs.Count -gt 0){ $procs | Stop-Process -Force; Start-Sleep -Milliseconds 250 } } while($procs.Count -gt 0 -and (Get-Date) -lt $deadline)`,
      ], { windowsHide: true });
    } catch {
      // Best-effort cleanup for isolated fixture processes.
    }
  }

  async function passiveAccept(repo: string, summary = "passive checks green") {
    return withPreparedRuntime(repo, () =>
      relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-Summary",
        summary,
        "-ValidationChecks",
        "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
      ),
    );
  }

  async function createCandidate(repo: string, fileText = "initial\ncandidate\n") {
    await relay(repo, "-Action", "Reset", "-Force");
    const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
    expect(claimed).toMatchObject({ outcome: "CLAIMED", phase: "working", activeRole: "A" });
    await writeFile(path.join(repo, "README.md"), fileText, "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
    const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
    expect(completed).toMatchObject({ outcome: "COMPLETED", phase: "passive-testing", nextRole: "A", activeRole: null });
    return completed.candidateCommit as string;
  }

  async function createCandidateWithTestSource(repo: string, testSource: string) {
    await relay(repo, "-Action", "Reset", "-Force");
    const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
    expect(claimed).toMatchObject({ outcome: "CLAIMED", phase: "working", activeRole: "A" });
    await writeFile(path.join(repo, "README.md"), "initial\ncandidate\n", "utf8");
    await writeFile(path.join(repo, "tests", "example.test.ts"), testSource, "utf8");
    await execa("git", ["add", "README.md", "tests/example.test.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
    const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
    expect(completed).toMatchObject({ outcome: "COMPLETED", phase: "passive-testing", nextRole: "A", activeRole: null });
    return completed.candidateCommit as string;
  }

  async function writeNodeModulesSentinel(repo: string) {
    const sentinel = path.join(repo, "node_modules", "d190-sentinel.txt");
    await writeFile(sentinel, "workspace dependencies stay intact\n", "utf8");
    return sentinel;
  }

  async function expectNodeModulesIntact(repo: string, sentinel: string) {
    expect(await readFile(sentinel, "utf8")).toBe("workspace dependencies stay intact\n");
    expect(await readFile(path.join(repo, "node_modules", ".bin", "vitest.cmd"), "utf8")).toContain("vitest.mjs");
  }

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
  }, 30_000);

  windowsIt("D132: pause closes a clean no-work active A turn", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d132-pause-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");

      const paused = await relay(repo, "-Action", "Pause", "-Role", "A", "-Summary", "no queued human item");
      expect(paused).toMatchObject({
        outcome: "PAUSED",
        activeRole: null,
        phase: "paused",
        pauseAfterTurn: false,
        baseCommit: null,
        nextRole: "A",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D168: claim refuses stale pre-D167 wishlist tooling", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d168-stale-tooling-"));
    try {
      await initRepo(repo);
      await writeSharedBoard(repo, "- [ ] W0022 | P0 | real work | QUEUED added=now");
      await writeFile(
        path.join(repo, ".tandem", "shared-control", "SHARED_DIRECTION.md"),
        "# Shared Direction\n\n## General Direction\n\nDurable only.\n",
        "utf8",
      );
      await writeFile(
        path.join(repo, "scripts", "reciprocal-direction.ps1"),
        [
          "param([Parameter(Mandatory = $true)][ValidateSet(\"Show\")][string]$Action)",
          "$path = Join-Path (Get-Location).Path \".tandem\\shared-control\\SHARED_DIRECTION.md\"",
          "if ($Action -eq \"Show\" -and (Test-Path -LiteralPath $path)) { Get-Content -LiteralPath $path -Raw }",
        ].join("\n"),
        "utf8",
      );
      await execa("git", ["add", "scripts/reciprocal-direction.ps1"], { cwd: repo });
      await execa("git", ["commit", "-m", "stale direction tooling"], { cwd: repo });
      await relay(repo, "-Action", "Reset", "-Force");

      await expect(relay(repo, "-Action", "Claim", "-Role", "A")).rejects.toThrow(/stale pre-D167 wishlist tooling/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D168: claim refuses stale pre-D167 wishlist tooling", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d168-stale-tooling-"));
    try {
      await initRepo(repo);
      await writeSharedBoard(repo, "- [ ] W0022 | P0 | real work | QUEUED added=now");
      await writeFile(
        path.join(repo, ".tandem", "shared-control", "SHARED_DIRECTION.md"),
        "# Shared Direction\n\n## General Direction\n\nDurable only.\n",
        "utf8",
      );
      await writeFile(
        path.join(repo, "scripts", "reciprocal-direction.ps1"),
        [
          "param([Parameter(Mandatory = $true)][ValidateSet(\"Show\")][string]$Action)",
          "$path = Join-Path (Get-Location).Path \".tandem\\shared-control\\SHARED_DIRECTION.md\"",
          "if ($Action -eq \"Show\" -and (Test-Path -LiteralPath $path)) { Get-Content -LiteralPath $path -Raw }",
        ].join("\n"),
        "utf8",
      );
      await execa("git", ["add", "scripts/reciprocal-direction.ps1"], { cwd: repo });
      await execa("git", ["commit", "-m", "stale direction tooling"], { cwd: repo });
      await relay(repo, "-Action", "Reset", "-Force");

      await expect(relay(repo, "-Action", "Claim", "-Role", "A")).rejects.toThrow(/stale pre-D167 wishlist tooling/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D133: repeated RESUME claims still auto-pause A recovery loops", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d133-resume-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(repo, ".tandem"), { recursive: true });
      await writeFile(path.join(repo, ".tandem", "reciprocal-checkpoint.md"), "resume checkpoint\n", "utf8");

      const firstResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      const secondResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      const thirdResume = await relay(repo, "-Action", "Claim", "-Role", "A");

      expect(firstResume).toMatchObject({ outcome: "RESUME", resumeCount: 1, resumeThreshold: 3 });
      expect(secondResume).toMatchObject({ outcome: "RESUME", resumeCount: 2, resumeThreshold: 3 });
      expect(thirdResume).toMatchObject({
        outcome: "PAUSED",
        phase: "paused",
        pausedFromPhase: "working",
        pauseOrigin: "machine",
        pauseReasonCode: "repeated-genuine-blocker",
        activeRole: "A",
        resumeCount: 3,
        resumeThreshold: 3,
      });

      await relay(repo, "-Action", "Resume", "-Summary", "human inspected the stalled turn");
      const afterResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(afterResume).toMatchObject({ outcome: "RESUME", resumeCount: 1 });

      const abandoned = await relay(repo, "-Action", "Abandon", "-Role", "A", "-Summary", "reset stalled no-work turn");
      expect(abandoned).toMatchObject({ outcome: "ABANDONED", resumeCount: 0, activeRole: null });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  windowsIt("D178: relay pause metadata comes from the canonical taxonomy fixture", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d178-taxonomy-"));
    let taxonomyDir = "";
    try {
      await initRepo(repo);
      taxonomyDir = await mkdtemp(path.join(tmpdir(), "tandem-relay-taxonomy-fixture-"));
      const taxonomy = path.join(taxonomyDir, "gate-taxonomy.json");
      await writeFile(taxonomy, JSON.stringify({
        version: 1,
        categories: {
          autoRecoverablePrerequisite: "fixture-auto",
          hardBlocked: "fixture-hard",
          hardHumanGate: "fixture-human",
          waitingNotBlocked: "fixture-wait",
        },
        pauseOrigins: { human: "fixture-human", machine: "fixture-machine", unknown: "fixture-unknown" },
        pauseReasonCodes: {
          explicitHumanPause: "fixture-human-pause",
          resumeCircuitBreaker: "fixture-repeat",
          candidateFailure: "fixture-candidate",
          environmentFailure: "fixture-environment",
        },
        displayStates: {
          working: "fixture-working",
          testing: "fixture-testing",
          waitingForReview: "fixture-review",
          humanPaused: "fixture-human-paused",
          machineBlocked: "fixture-machine-blocked",
          hardBlocked: "fixture-hard-blocked",
          retryBackoff: "fixture-backoff",
          retryingPrerequisite: "fixture-retry",
          planning: "fixture-planning",
          unknown: "fixture-unknown",
          waitingNotBlocked: "fixture-waiting",
        },
      }), "utf8");

      const env = { TANDEM_RECIPROCAL_TAXONOMY: taxonomy };
      await relayWithEnv(repo, env, "-Action", "Reset", "-Force");
      await relayWithEnv(repo, env, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(repo, ".tandem"), { recursive: true });
      await writeFile(path.join(repo, ".tandem", "reciprocal-checkpoint.md"), "resume checkpoint\n", "utf8");

      await relayWithEnv(repo, env, "-Action", "Claim", "-Role", "A");
      await relayWithEnv(repo, env, "-Action", "Claim", "-Role", "A");
      const paused = await relayWithEnv(repo, env, "-Action", "Claim", "-Role", "A");

      expect(paused).toMatchObject({
        outcome: "PAUSED",
        pauseOrigin: "fixture-machine",
        pauseReasonCode: "fixture-repeat",
      });
      const state = JSON.parse(await readFile(path.join(repo, ".git", "tandem-relay", "state.json"), "utf8"));
      expect(state.pauseOrigin).toBe("fixture-machine");
      expect(state.pauseReasonCode).toBe("fixture-repeat");
    } finally {
      await rm(repo, { recursive: true, force: true });
      if (taxonomyDir) await rm(taxonomyDir, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("migrates legacy null pause metadata only for the exact machine circuit-breaker signature", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-legacy-pause-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.phase = "paused";
      state.pausedFromPhase = "working";
      state.pauseOrigin = null;
      state.pauseReasonCode = null;
      state.lastSummary = "Auto-paused turn 1: executor A received 3 consecutive RESUME claims without completing. Human attention is required before resuming.";
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      const migrated = await relay(repo, "-Action", "Status");
      expect(migrated).toMatchObject({
        phase: "paused",
        pauseOrigin: "machine",
        pauseReasonCode: "repeated-genuine-blocker"
      });
    } finally {
      await stopRelayProcess(relayRoot(repo));
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D179: trusted authority checkpoint resumes once and consumes on completion", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d179-authority-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
      const boardPath = await writeSharedBoard(
        repo,
        "- [ ] W0001 | P0 | Sensitive step | IN_PROGRESS epic=true autonomy=full phase=STEP revision=1 completed=0 step=1/1 plan=process/reciprocal/epics/W0001-plan.md role=A started=now",
      );

      const declared = await relay(repo, "-Action", "DeclareAuthority", "-Role", "A", "-Id", "W0001", "-AuthKind", "permission", "-AuthVerb", "enableLoopback", "-Checkpoint", "step1", "-ResumeToken", "resumeStep1");
      expect(declared).toMatchObject({
        outcome: "AUTHORITY_DECLARED",
        phase: "paused",
        activeRole: "A",
        authorityRequest: { id: "W0001", owner: "A", status: "pending", checkpoint: "step1", resume: "resumeStep1" },
      });
      expect(declared.authorityRequest.decisionProof).toBeUndefined();
      expect(await readFile(boardPath, "utf8")).toContain("authorityStatus=pending");

      await expect(relay(repo, "-Action", "ApproveAuthority")).rejects.toThrow(/authenticated dashboard decision packet/);
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.authorityRequest.decisionProof).toBeUndefined();
      expect(state.authorityRequest.requestDigest).toMatch(/^[a-f0-9]{64}$/);
      const forgedPacket = signedAuthorityEnv({ ...state.authorityRequest, checkpoint: "wrongStep" }, "approve");
      await expect(relayWithEnv(repo, forgedPacket, "-Action", "ApproveAuthority")).rejects.toThrow(/checkpoint mismatch/);
      const approved = await relayWithEnv(repo, signedAuthorityEnv(state.authorityRequest, "approve"), "-Action", "ApproveAuthority");
      expect(approved).toMatchObject({
        outcome: "AUTHORITY_APPROVED",
        phase: "working",
        activeRole: "A",
        authorityRequest: { id: "W0001", status: "approved" },
      });
      expect(await readFile(boardPath, "utf8")).toContain("authorityStatus=approved");

      await writeFile(path.join(repo, "README.md"), `initial\n${claimed.stableCommit}\nauthority\n`, "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "authority candidate"], { cwd: repo });
      const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await execa("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.join(repo, "scripts", "reciprocal-direction.ps1"),
        "-Action", "Candidate", "-Id", "W0001", "-Commit", head, "-ControlPath", boardPath,
      ], { cwd: repo });
      expect(await readFile(boardPath, "utf8")).toContain("authorityStatus=consumed");

      const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "authority step done");
      expect(completed).toMatchObject({ outcome: "COMPLETED", authorityRequest: { id: "W0001", status: "consumed" } });
      const repeat = await relay(repo, "-Action", "ApproveAuthority");
      expect(repeat).toMatchObject({ outcome: "AUTHORITY_APPROVED_NOOP", authorityRequest: { status: "consumed" } });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D162: completes a clean artifact-only A turn without changing stable or creating a candidate", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d162-artifact-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
      const stableBefore = claimed.stableCommit;
      const completed = await relay(repo, "-Action", "CompleteArtifact", "-Role", "A", "-Summary", "candidate preview built; BUILD_INFO and smoke verified");

      expect(completed).toMatchObject({
        outcome: "ARTIFACT_COMPLETED",
        phase: "idle",
        activeRole: null,
        candidateCommit: null,
        stableCommit: stableBefore,
        lastCompletedCommit: stableBefore,
      });
      const stableAfter = (await execa("git", ["rev-parse", "refs/tandem-relay/stable"], { cwd: repo })).stdout.trim();
      await expect(execa("git", ["rev-parse", "--verify", "refs/tandem-relay/candidate"], { cwd: repo })).rejects.toThrow();
      expect(stableAfter).toBe(stableBefore);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D164: Claim exposes deterministic artifact-only instructions for declared preview work", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d164-artifact-claim-"));
    try {
      await initRepo(repo);
      await writeSharedBoard(
        repo,
        "- [ ] W0099 | P0 | Build preview | QUEUED artifact=candidate-preview source=feed4343ec17e79cb8398c069120c100c7b2f1be declared=2026-07-20T00:00:00Z",
      );
      await relay(repo, "-Action", "Reset", "-Force");

      const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(claimed).toMatchObject({
        outcome: "CLAIMED",
        phase: "working",
        activeRole: "A",
        artifactWork: {
          kind: "candidate-preview",
          wishlistId: "W0099",
          sourceSha: "feed4343ec17e79cb8398c069120c100c7b2f1be",
          completionReportShape: {
            status: "complete",
            filesChanged: [],
            reciprocalArtifact: {
              kind: "candidate-preview",
              wishlistId: "W0099",
              sourceSha: "feed4343ec17e79cb8398c069120c100c7b2f1be",
            },
          },
        },
      });
      expect(claimed.artifactWork.startCommand).toContain("-Action Start -Id W0099 -Role A");
      expect(claimed.artifactWork.instruction).toContain("filesChanged=[]");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D165: Status advertises candidate preview artifact lifecycle capability", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d165-status-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");

      const status = await relay(repo, "-Action", "Status");
      expect(status.capabilities).toMatchObject({ candidatePreviewArtifactLifecycle: 1 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D165: blocks declared preview artifact claims when capability is disabled", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d165-artifact-block-"));
    try {
      await initRepo(repo);
      await writeSharedBoard(
        repo,
        "- [ ] W0100 | P0 | Build preview | QUEUED artifact=candidate-preview source=feed4343ec17e79cb8398c069120c100c7b2f1be declared=2026-07-20T00:00:00Z",
      );
      await relay(repo, "-Action", "Reset", "-Force");

      const blocked = await relayWithEnv(repo, { TANDEM_DISABLE_CANDIDATE_PREVIEW_ARTIFACT_CAPABILITY: "1" }, "-Action", "Claim", "-Role", "A");
      expect(blocked).toMatchObject({
        outcome: "CAPABILITY_BLOCKED",
        phase: "idle",
        activeRole: null,
        artifactBlocked: {
          kind: "candidate-preview",
          wishlistId: "W0100",
          requiredCapability: { candidatePreviewArtifactLifecycle: 1 },
          reason: "Artifact build workflow requires Reciprocal executor upgrade.",
        },
      });
      expect(blocked.artifactWork).toBeUndefined();
      const board = await readFile(path.join(repo, ".tandem", "shared-control", "WISHLIST.md"), "utf8");
      expect(board).toContain("W0100 | P0 | Build preview | QUEUED");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D165: disabled artifact capability does not block ordinary source work", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d165-source-"));
    try {
      await initRepo(repo);
      await writeSharedBoard(repo, "- [ ] W0101 | P1 | Implement normal work | QUEUED added=2026-07-20T00:00:00Z");
      await relay(repo, "-Action", "Reset", "-Force");

      const claimed = await relayWithEnv(repo, { TANDEM_DISABLE_CANDIDATE_PREVIEW_ARTIFACT_CAPABILITY: "1" }, "-Action", "Claim", "-Role", "A");
      expect(claimed).toMatchObject({ outcome: "CLAIMED", phase: "working", activeRole: "A" });
      expect(claimed.artifactBlocked).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D162: refuses artifact completion when the clean turn has a source commit", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d162-commit-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await writeFile(path.join(repo, "README.md"), "initial\nunexpected source\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "unexpected source"], { cwd: repo });

      await expect(relay(repo, "-Action", "CompleteArtifact", "-Role", "A", "-Summary", "must fail")).rejects.toThrow(/HEAD changed from base|requires no source commits/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D162: completes an auto-paused artifact-only working turn", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d162-paused-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(repo, ".tandem"), { recursive: true });
      await writeFile(path.join(repo, ".tandem", "reciprocal-checkpoint.md"), "resume checkpoint\n", "utf8");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      const paused = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(paused).toMatchObject({ phase: "paused", pausedFromPhase: "working", pauseOrigin: "machine", pauseReasonCode: "repeated-genuine-blocker", activeRole: "A" });

      const completed = await relay(repo, "-Action", "CompleteArtifact", "-Role", "A", "-Summary", "candidate preview completed after human review of paused turn");
      expect(completed).toMatchObject({ outcome: "ARTIFACT_COMPLETED", phase: "idle", activeRole: null, resumeCount: 0 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("does not trip the resume circuit breaker while app-layer finalization is pending", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-finalization-pending-"));
    const reciprocalRoot = path.join(repo, ".reciprocal-root");
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(reciprocalRoot, "state"), { recursive: true });
      await writeFile(
        path.join(reciprocalRoot, "state", "finalization-a.json"),
        JSON.stringify({ schemaVersion: 1, role: "A", wishlistId: "W0027", stage: "committed", commit: "abc123" }),
        "utf8",
      );

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const resumed = await relayWithEnv(repo, { TANDEM_RECIPROCAL_ROOT: reciprocalRoot }, "-Action", "Claim", "-Role", "A");
        expect(resumed).toMatchObject({
          outcome: "RESUME",
          phase: "working",
          activeRole: "A",
          resumeCount: 0,
          reason: "app-layer-finalization-pending",
          finalizationPending: true,
          wishlistId: "W0027",
        });
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("completes a legacy multi-commit app-layer range only with matching durable finalization proof", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-finalization-range-"));
    const reciprocalRoot = await mkdtemp(path.join(tmpdir(), "tandem-relay-finalization-state-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await writeFile(path.join(repo, "README.md"), "initial\nfirst app-layer pass\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "relay: first interrupted finalization"], { cwd: repo });
      await writeFile(path.join(repo, "README.md"), "initial\nfirst app-layer pass\nsecond app-layer pass\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "relay: second interrupted finalization"], { cwd: repo });
      const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await mkdir(path.join(reciprocalRoot, "state"), { recursive: true });
      await writeFile(
        path.join(reciprocalRoot, "state", "finalization-a.json"),
        JSON.stringify({ schemaVersion: 1, role: "A", wishlistId: "W0027", stage: "committed", commit: head, files: ["README.md"] }),
        "utf8",
      );

      const completed = await relayWithEnv(
        repo,
        { TANDEM_RECIPROCAL_ROOT: reciprocalRoot },
        "-Action",
        "Complete",
        "-Role",
        "A",
        "-Summary",
        "recovered durable app-layer finalization",
      );
      expect(completed).toMatchObject({ outcome: "COMPLETED", phase: "passive-testing", candidateCommit: head, activeRole: null });
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(reciprocalRoot, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D151: B never receives an agentic claim and A routes candidates to passive testing", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-claim-"));
    try {
      await initRepo(repo);
      const passiveB = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(passiveB).toMatchObject({ outcome: "WAIT", passiveOnly: true });

      const candidateCommit = await createCandidate(repo);
      const aClaim = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(aClaim).toMatchObject({ outcome: "PASSIVE_TEST", phase: "passive-testing", candidateCommit });

      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const bClaim = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(bClaim).toMatchObject({ outcome: "WAIT", passiveOnly: true, candidateCommit });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D151: passive test accepts a candidate and stops at the A-upgrade human gate", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-passive-"));
    const root = relayRoot(repo);
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const boardPath = await writeSharedBoard(
        repo,
        `- [ ] W0001 | P3 | passive candidate | CANDIDATE commit=${candidateCommit} updated=2026-07-18T00:00:00Z`,
      );
      const accepted = await passiveAccept(repo);
      expect(accepted, JSON.stringify(accepted.passiveChecks || accepted, null, 2)).toMatchObject({
        outcome: "PASSIVE_ACCEPTED",
        phase: "a-upgrade-pending",
        stableCommit: candidateCommit,
        candidateCommit: null,
        nextRole: "A",
        activeRole: null,
      });

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain(`- [x] W0001 | P3 | passive candidate | DONE stable=${candidateCommit}`);
      const buildInfo = JSON.parse(await readFile(path.join(repo, "release", "win-unpacked", "BUILD_INFO.json"), "utf8"));
      expect(buildInfo.sourceSha).toBe(candidateCommit);
      expect(buildInfo.packageIdentity).toMatch(/^[0-9A-F]{64}$/);
      expect(buildInfo.immutablePackagePath).toContain(path.join("release", "runtime-packages", buildInfo.packageIdentity, "win-unpacked"));
      await execa("node", [path.resolve("scripts/runtime-package-integrity.mjs"), "verify", buildInfo.immutablePackagePath, "--source-sha", candidateCommit, "--package-identity", buildInfo.packageIdentity], { cwd: repo });
      expect(accepted.recoveryRuntime).toMatchObject({ role: "B", sourceSha: candidateCommit, stage: "b-runtime-verified" });
      const recoveryBuildInfo = JSON.parse(await readFile(path.join(root, "runtimes", "executor-b", "BUILD_INFO.json"), "utf8"));
      expect(recoveryBuildInfo.sourceSha).toBe(candidateCommit);
      expect(recoveryBuildInfo.packageIdentity).toBe(buildInfo.packageIdentity);
      expect(recoveryBuildInfo.immutablePackagePath).toBe(buildInfo.immutablePackagePath);
      expect(recoveryBuildInfo.reciprocalCapabilities.candidatePreviewArtifactLifecycle).toBe(1);
      const journal = JSON.parse(await readFile(path.join(root, "state", "runtime-recovery-flow.json"), "utf8"));
      expect(journal).toMatchObject({ sourceSha: candidateCommit, packageIdentity: buildInfo.packageIdentity, immutablePackagePath: buildInfo.immutablePackagePath, stage: "b-verified" });
      expect(journal.proof.bEndpoint).toMatchObject({ sourceSha: candidateCommit, packageIdentity: buildInfo.packageIdentity });
      await writeFile(path.join(buildInfo.immutablePackagePath, "D184_TAMPER.txt"), "tampered\n", "utf8");
      await expect(execa("node", [path.resolve("scripts/runtime-package-integrity.mjs"), "verify", buildInfo.immutablePackagePath, "--source-sha", candidateCommit, "--package-identity", buildInfo.packageIdentity], { cwd: repo })).rejects.toThrow(/manifest mismatch/i);

      const waitingClaim = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(waitingClaim).toMatchObject({ outcome: "A_UPGRADE_PENDING" });

      const ready = await relay(repo, "-Action", "PrepareAUpgrade", "-Role", "A", "-DryRun");
      expect(ready).toMatchObject({ outcome: "A_UPGRADE_READY", sourceSha: candidateCommit });
      expect(ready.promotionCommand).toContain("-TargetRole A");

      const completed = await relay(repo, "-Action", "CompleteAUpgrade", "-Role", "A", "-Force", "-Summary", "human confirmed A rebuild");
      expect(completed).toMatchObject({ outcome: "A_UPGRADE_COMPLETED", phase: "idle", nextRole: "A" });
    } finally {
      await stopRelayProcess(root);
      await rm(repo, { recursive: true, force: true });
    }
  }, 90_000);

  windowsIt("uses the relay's paired direction controller when accepting an external worktree candidate", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-paired-control-"));
    const root = relayRoot(repo);
    try {
      await initRepo(repo);
      await writeFile(
        path.join(repo, "scripts", "reciprocal-direction.ps1"),
        [
          "param([string]$Action)",
          "# Compatibility markers: Get-WishlistPath WISHLIST.md",
          "if ($Action -eq 'Show') { '<!-- wishlist-items -->' } else { throw 'stale direction controller must not finalize an admin relay acceptance' }",
        ].join("\n"),
        "utf8",
      );
      await execa("git", ["add", "scripts/reciprocal-direction.ps1"], { cwd: repo });
      await execa("git", ["commit", "-m", "simulate stale but claim-compatible direction controller"], { cwd: repo });

      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const boardPath = await writeSharedBoard(
        repo,
        `- [ ] W0001 | P1 | autonomous plan | CANDIDATE epic=true autonomy=full candidate=PLAN revision=1 completed=0 steps=1 plan=process/reciprocal/epics/W0001-plan.md commit=${candidateCommit.slice(0, 7)} updated=now`,
      );

      const accepted = await passiveAccept(repo);
      expect(accepted).toMatchObject({ outcome: "PASSIVE_ACCEPTED", phase: "idle", stableCommit: candidateCommit });
      expect(await readFile(boardPath, "utf8")).toContain(`PLAN_APPROVED epic=true autonomy=full revision=1 completed=0 steps=1 next=1/1 plan=process/reciprocal/epics/W0001-plan.md commit=${candidateCommit}`);
    } finally {
      await stopRelayProcess(root);
      await rm(repo, { recursive: true, force: true });
    }
  }, 90_000);

  windowsIt("D155: intermediate autonomous epic steps return to idle while final steps keep the A-upgrade gate", async () => {
    const intermediateRepo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d155-intermediate-"));
    try {
      await initRepo(intermediateRepo);
      const step1Commit = await createCandidate(intermediateRepo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: intermediateRepo });
      const boardPath = await writeSharedBoard(
        intermediateRepo,
        `- [ ] W0001 | P1 | approved plan-gated epic | CANDIDATE epic=true autonomy=plan-gated candidate=STEP revision=1 completed=0 step=1/2 plan=process/reciprocal/epics/W0001-plan.md commit=${step1Commit} updated=2026-07-19T00:00:00Z`,
      );

      const accepted = await passiveAccept(intermediateRepo, "step 1 passive checks green");
      expect(accepted).toMatchObject({
        outcome: "PASSIVE_ACCEPTED",
        phase: "idle",
        stableCommit: step1Commit,
        candidateCommit: null,
        nextRole: "A",
        activeRole: null,
      });
      expect(accepted).not.toHaveProperty("aUpgradeCommand");
      expect(accepted.autonomousContinuation).toMatchObject({
        available: true,
        wishlistId: "W0001",
        nextStep: "2/2",
        role: "A",
        requiresHumanGate: false,
        maxExtraLifecycleActions: 0,
      });

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain("IN_PROGRESS epic=true autonomy=plan-gated phase=STEP revision=1 completed=1 step=1/2 next=2/2");

      await execa("git", ["switch", "codex/reciprocal-b"], { cwd: intermediateRepo });
      const nextClaim = await relay(intermediateRepo, "-Action", "Claim", "-Role", "A");
      expect(nextClaim).toMatchObject({ outcome: "CLAIMED", phase: "working", activeRole: "A" });
    } finally {
      await stopRelayProcess(relayRoot(intermediateRepo));
      await rm(intermediateRepo, { recursive: true, force: true });
    }

    const finalRepo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d155-final-"));
    try {
      await initRepo(finalRepo);
      const step2Commit = await createCandidate(finalRepo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: finalRepo });
      await writeSharedBoard(
        finalRepo,
        `- [ ] W0001 | P1 | autonomous epic | CANDIDATE epic=true autonomy=full candidate=STEP revision=1 completed=1 step=2/2 plan=process/reciprocal/epics/W0001-plan.md commit=${step2Commit} updated=2026-07-19T00:00:00Z`,
      );

      const acceptedFinal = await passiveAccept(finalRepo, "final step passive checks green");
      expect(acceptedFinal).toMatchObject({
        outcome: "PASSIVE_ACCEPTED",
        phase: "a-upgrade-pending",
        stableCommit: step2Commit,
        candidateCommit: null,
        nextRole: "A",
        activeRole: null,
        autonomousContinuation: null,
      });
      expect(acceptedFinal.aUpgradeCommand).toContain("-TargetRole A");

      const waitingClaim = await relay(finalRepo, "-Action", "Claim", "-Role", "A");
      expect(waitingClaim).toMatchObject({ outcome: "A_UPGRADE_PENDING" });
    } finally {
      await stopRelayProcess(relayRoot(finalRepo));
      await rm(finalRepo, { recursive: true, force: true });
    }
  }, 90_000);

  windowsIt("D151: passive check failure pauses without handing work to B", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-fail-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });

      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('README.md','utf8').includes('candidate') ? 1 : 0)\"",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pausedFromPhase: "passive-testing",
        pauseReasonCode: "candidate-failure",
        activeRole: null,
        candidateCommit,
      });
      expect(result.stableBaseline).toMatchObject({
        classifier: "stable-baseline-control",
        classification: "candidate-failure",
        reproducedOnStable: false,
      });

      const bClaim = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(bClaim).toMatchObject({ outcome: "WAIT", passiveOnly: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D185: passive check failure that reproduces on stable is classified as environment failure", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d185-env-fail-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";

it("suite > same failure", () => {
  expect("❯ × 智能路径").toBe("stable");
});
`);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });

      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "npm test -- tests/example.test.ts",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pausedFromPhase: "passive-testing",
        pauseReasonCode: "environment-failure",
        activeRole: null,
        candidateCommit,
      });
      expect(result.stableBaseline).toMatchObject({
        classifier: "stable-baseline-control",
        classification: "environment-failure",
        reproducedOnStable: true,
        stableCommit: expect.any(String),
        candidateCommit,
      });
      expect(result.passiveFailure).toMatchObject({
        classification: "environment-failure",
        reproducedOnStable: true,
      });
      expect(result.passiveFailure.matchingFailureIdentities[0]).toMatchObject({
        file: "tests\\example.test.ts",
        name: "suite > same failure",
      });
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      const beforeStatus = await readFile(statePath);
      for (let index = 0; index < 100; index += 1) {
        await relay(repo, "-Action", "Status");
      }
      const afterStatus = await readFile(statePath);
      expect(afterStatus.equals(beforeStatus)).toBe(true);

      const status = await relay(repo, "-Action", "Status");
      expect(status).toMatchObject({
        phase: "paused",
        pauseReasonCode: "environment-failure",
        candidateCommit,
      });
      expect(status.passiveFailure).toMatchObject({
        classification: "environment-failure",
        reproducedOnStable: true,
      });

      await relay(repo, "-Action", "Resume", "-Summary", "retry after restoring the environment");
      const resumed = await relay(repo, "-Action", "Status");
      expect(resumed).toMatchObject({
        phase: "passive-testing",
        pauseReasonCode: null,
        passiveFailure: null,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  windowsIt("D186: a different stable failure in the same file is not an environment failure", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d186-different-fail-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const candidate = readFileSync("README.md", "utf8").includes("candidate");
it("suite > " + (candidate ? "candidate-only failure" : "stable-only failure"), () => {
  expect(candidate ? "❯ candidate" : "× stable").toBe("pass");
});
`);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });

      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "npm test -- tests/example.test.ts",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pauseReasonCode: "candidate-failure",
        candidateCommit,
      });
      expect(result.stableBaseline).toMatchObject({
        classification: "candidate-failure",
        reproducedOnStable: false,
      });
      expect(result.stableBaseline.candidateFailureIdentities[0]).toMatchObject({ name: "suite > candidate-only failure" });
      expect(result.stableBaseline.stableFailureIdentities[0]).toMatchObject({ name: "suite > stable-only failure" });
      expect(result.stableBaseline.matchingFailureIdentities).toHaveLength(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D187: spoofed node and chained validation commands are not stable-baseline replayed", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d187-spoof-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });

      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "node -e \"console.log('FAIL tests/example.test.ts > suite > fake'); process.exit(1)\" & exit /b 1",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pauseReasonCode: "candidate-failure",
        candidateCommit,
      });
      expect(result.stableBaseline.baselineChecks).toHaveLength(0);
      expect(result.stableBaseline.skippedControls[0]).toMatchObject({
        reason: "not-read-only-validation-control",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D186: package lifecycle failures are not replayed as stable baseline controls", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d186-package-fail-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const missingPreparedRuntime = path.join(repo, ".tandem", "missing-runtime", "win-unpacked");

      const result = await relayWithEnv(
        repo,
        { ...process.env, TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED: missingPreparedRuntime },
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pauseReasonCode: "environment-failure",
        candidateCommit,
      });
      expect(result.stableBaseline).toMatchObject({
        classifier: "lifecycle-operation",
        classification: "environment-failure",
        baselineControlSkipped: true,
        skipReason: "mutating-lifecycle-command",
        operationKind: "package",
        baselineChecks: [],
      });
      expect(result.stableBaseline.failedCandidateCommands).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 45_000);

  windowsIt("D188: B promotion lifecycle failures are not replayed as stable baseline controls", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-promote-fail-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const sentinel = path.join(repo, ".tandem", "promotion-sentinel.txt");

      const result = await withPreparedRuntime(repo, () =>
        relayWithEnv(
          repo,
          { ...relayEnv(repo), TANDEM_TEST_FAIL_B_PROMOTION_SENTINEL: sentinel },
          "-Action",
          "PassiveTest",
          "-Role",
          "A",
          "-ValidationChecks",
          "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
        ),
      );

      expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", pauseReasonCode: "environment-failure", candidateCommit });
      expect(result.stableBaseline).toMatchObject({
        classifier: "lifecycle-operation",
        baselineControlSkipped: true,
        operationKind: "b-runtime-promotion",
        baselineChecks: [],
      });
      expect((await readFile(sentinel, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(relayRoot(repo), "state", "runtime-recovery-flow.json"), "utf8")).stage).toBe("b-promote-started");
      await expect(readFile(path.join(relayRoot(repo), "runtimes", "executor-b", "BUILD_INFO.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D188: B launch lifecycle failures are not replayed and do not leave a running B", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-launch-fail-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const sentinel = path.join(repo, ".tandem", "launch-sentinel.txt");

      const result = await withPreparedRuntime(repo, () =>
        relayWithEnv(
          repo,
          { ...relayEnv(repo), TANDEM_TEST_FAIL_B_LAUNCH_SENTINEL: sentinel },
          "-Action",
          "PassiveTest",
          "-Role",
          "A",
          "-ValidationChecks",
          "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
        ),
      );

      expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", pauseReasonCode: "environment-failure", candidateCommit });
      expect(result.stableBaseline).toMatchObject({
        classifier: "lifecycle-operation",
        baselineControlSkipped: true,
        operationKind: "b-runtime-launch",
        baselineChecks: [],
      });
      expect((await readFile(sentinel, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(relayRoot(repo), "state", "runtime-recovery-flow.json"), "utf8")).stage).toBe("b-start-started");
      await expect(readFile(path.join(relayRoot(repo), "state", "executor-b", "automation.json"), "utf8")).rejects.toThrow();
    } finally {
      await stopRelayProcess(relayRoot(repo));
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D188: stable baseline command grammar rejects hidden executable options", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-grammar-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";
it("suite > grammar failure", () => expect(1).toBe(2));
`);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      for (const command of [
        "npm test -- tests/example.test.ts --config tests/side-effect.ts",
        "npx vitest run tests/example.test.ts --setupFiles tests/side-effect.ts",
        "vitest run tests/example.test.ts ../outside.test.ts",
        "npm test -- tests/../outside.test.ts",
        "npm test -- \"tests/../outside.test.ts\"",
        "npx vitest run tests\\..\\outside.test.ts",
        "vitest run \"tests\\..\\outside.test.ts\"",
        "npm test -- tests/example.test.ts README.md",
      ]) {
        const result = await relay(repo, "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", command);
        expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", phase: "paused", candidateCommit });
        expect(result.stableBaseline.baselineChecks).toHaveLength(0);
        expect(result.stableBaseline.skippedControls[0]).toMatchObject({ command, reason: "not-read-only-validation-control" });
        await relay(repo, "-Action", "Resume", "-Summary", "continue command grammar negative checks");
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 90_000);

  windowsIt("D189: stable baseline command grammar accepts only supported test command families", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d189-grammar-positive-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";
it("suite > grammar positive", () => expect(1).toBe(2));
`);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      for (const command of [
        "npm test -- tests/example.test.ts",
        "npx vitest run tests/example.test.ts",
        "vitest run tests/example.test.ts",
      ]) {
        const result = await relayWithEnv(repo, vitestBinEnv(repo), "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", command);
        expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", phase: "paused", candidateCommit });
        expect(result.stableBaseline).toMatchObject({ classification: "environment-failure", reproducedOnStable: true });
        expect(result.stableBaseline.baselineChecks).toHaveLength(1);
        expect(result.stableBaseline.skippedControls).toHaveLength(0);
        await relay(repo, "-Action", "Resume", "-Summary", "continue command grammar positive checks");
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  windowsIt("D188: persisted diagnostics are limited by UTF-8 bytes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-byte-limit-"));
    try {
      await initRepo(repo);
      await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "node -e \"process.stdout.write('❯ × 智能路径'.repeat(2000)); process.exit(1)\"",
      );
      const output = result.stableBaseline.failedCandidateCommands[0].output;
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(3000);
      expect(output).toContain("UTF-8 bytes");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D188: repeated mutating failure saves preserve non-timestamp evidence", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-save-stability-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";
it("suite > same failure", () => expect("❯ × 智能路径").toBe("stable"));
`);
      await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const snapshots: unknown[] = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await relay(repo, "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", "npm test -- tests/example.test.ts");
        expect(result.stableBaseline).toMatchObject({ classification: "environment-failure", reproducedOnStable: true });
        const persisted = JSON.parse(await readFile(path.join(repo, ".git", "tandem-relay", "state.json"), "utf8"));
        expect(Buffer.byteLength(persisted.passiveFailure.failedCandidateCommands[0].output, "utf8")).toBeLessThanOrEqual(3000);
        expect(Buffer.byteLength(persisted.passiveFailure.baselineChecks[0].output, "utf8")).toBeLessThanOrEqual(3000);
        snapshots.push({
          classification: persisted.passiveFailure.classification,
          reproducedOnStable: persisted.passiveFailure.reproducedOnStable,
          failingTestFiles: persisted.passiveFailure.failingTestFiles,
          candidateFailureIdentities: persisted.passiveFailure.candidateFailureIdentities,
          stableFailureIdentities: persisted.passiveFailure.stableFailureIdentities,
          matchingFailureIdentities: persisted.passiveFailure.matchingFailureIdentities,
        });
        await relay(repo, "-Action", "Resume", "-Summary", "repeat evidence save stability check");
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(snapshots[2]).toEqual(snapshots[0]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  windowsIt("D189: repeated mutating failure saves preserve complete passiveFailure evidence bytes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d189-save-stability-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";
it("suite > \\u276f \\u00d7 \\u667a\\u80fd\\u8def\\u5f84", () => expect("\\u276f \\u00d7 \\u667a\\u80fd\\u8def\\u5f84").toBe("stable"));
`);
      await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const exactUnicode = "\u276f \u00d7 \u667a\u80fd\u8def\u5f84";
      const snapshots: Array<{ evidenceText: string; evidenceBytes: number; stateBytes: number }> = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await relay(repo, "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", "npm test -- tests/example.test.ts");
        expect(result.stableBaseline).toMatchObject({ classification: "environment-failure", reproducedOnStable: true });
        const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
        const persisted = JSON.parse(await readFile(statePath, "utf8"));
        expect(persisted.passiveFailure.baselineChecks).toHaveLength(1);
        expect(persisted.passiveFailure.skippedControls).toHaveLength(0);
        expect(Buffer.byteLength(persisted.passiveFailure.failedCandidateCommands[0].output, "utf8")).toBeLessThanOrEqual(3000);
        expect(Buffer.byteLength(persisted.passiveFailure.baselineChecks[0].output, "utf8")).toBeLessThanOrEqual(3000);
        const evidenceText = JSON.stringify(normalizePassiveFailureEvidence(persisted.passiveFailure));
        const stateBytes = Buffer.byteLength(JSON.stringify(normalizePassiveFailureEvidence(persisted)), "utf8");
        expect(evidenceText).toContain(exactUnicode);
        snapshots.push({ evidenceText, evidenceBytes: Buffer.byteLength(evidenceText, "utf8"), stateBytes });
        await relay(repo, "-Action", "Resume", "-Summary", "repeat complete evidence save stability check");
      }
      expect(snapshots[1].evidenceText).toBe(snapshots[0].evidenceText);
      expect(snapshots[2].evidenceText).toBe(snapshots[0].evidenceText);
      expect(snapshots[1].evidenceBytes).toBe(snapshots[0].evidenceBytes);
      expect(snapshots[2].evidenceBytes).toBe(snapshots[0].evidenceBytes);
      expect(snapshots[1].stateBytes).toBeLessThanOrEqual(snapshots[0].stateBytes);
      expect(snapshots[2].stateBytes).toBeLessThanOrEqual(snapshots[1].stateBytes);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  windowsIt("D190: stable baseline cleanup preserves workspace node_modules junction target", async () => {
    const cases: Array<{
      name: string;
      stableSource: string;
      createCandidate: (repo: string) => Promise<string>;
      env?: NodeJS.ProcessEnv;
      expectedClassification: string;
    }> = [
      {
        name: "stable-pass",
        stableSource: `
import { expect, it } from "vitest";
it("suite > candidate only", () => expect(1).toBe(1));
`,
        createCandidate: (repo) =>
          createCandidateWithTestSource(
            repo,
            `
import { expect, it } from "vitest";
it("suite > candidate only", () => expect(1).toBe(2));
`,
          ),
        expectedClassification: "candidate-failure",
      },
      {
        name: "stable-fail",
        stableSource: `
import { expect, it } from "vitest";
it("suite > stable reproduced", () => expect(1).toBe(2));
`,
        createCandidate: (repo) => createCandidate(repo),
        expectedClassification: "environment-failure",
      },
      {
        name: "worktree-remove-fallback",
        stableSource: `
import { expect, it } from "vitest";
it("suite > fallback reproduced", () => expect(1).toBe(2));
`,
        createCandidate: (repo) => createCandidate(repo),
        env: { TANDEM_TEST_FAIL_STABLE_WORKTREE_REMOVE: "1" },
        expectedClassification: "environment-failure",
      },
    ];

    for (const item of cases) {
      const repo = await mkdtemp(path.join(tmpdir(), `tandem-relay-d190-junction-${item.name}-`));
      try {
        await initRepo(repo);
        await enableVitestFixture(repo, item.stableSource);
        const sentinel = await writeNodeModulesSentinel(repo);
        const candidateCommit = await item.createCandidate(repo);
        await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
        const env = { ...relayEnv(repo), ...item.env };
        const result = await relayWithEnv(repo, env, "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", "npm test -- tests/example.test.ts");
        expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", phase: "paused", candidateCommit });
        expect(result.stableBaseline).toMatchObject({ classification: item.expectedClassification });
        expect(result.stableBaseline.baselineChecks).toHaveLength(1);
        await expectNodeModulesIntact(repo, sentinel);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  }, 180_000);

  windowsIt("D190: copy-a passive gate uses admin relay script instead of checkout script", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d190-admin-gate-"));
    try {
      await initRepo(repo);
      await enableVitestFixture(repo, `
import { expect, it } from "vitest";
it("suite > admin gate evidence", () => expect(1).toBe(2));
`);
      await writeFile(
        path.join(repo, "scripts", "reciprocal-relay.ps1"),
        "throw 'stale checkout relay script executed'\n",
        "utf8",
      );
      await execa("git", ["add", "scripts/reciprocal-relay.ps1"], { cwd: repo });
      await execa("git", ["commit", "-m", "stale checkout relay script"], { cwd: repo });
      const candidateCommit = await createCandidate(repo);

      const claim = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(claim).toMatchObject({ outcome: "PASSIVE_TEST" });
      expect(claim.passiveTestCommand).toContain(path.resolve("scripts", "reciprocal-relay.ps1"));
      expect(claim.passiveTestCommand).not.toContain("-File scripts/reciprocal-relay.ps1");

      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const result = await relay(repo, "-Action", "PassiveTest", "-Role", "A", "-ValidationChecks", "npm test -- tests/example.test.ts");
      expect(result).toMatchObject({ outcome: "PASSIVE_FAILED", phase: "paused", candidateCommit });
      expect(result.stableBaseline).toMatchObject({ classification: "environment-failure", reproducedOnStable: true });
      const persisted = JSON.parse(await readFile(path.join(repo, ".git", "tandem-relay", "state.json"), "utf8"));
      expect(persisted.passiveFailure).toMatchObject({ classifier: "stable-baseline-control", classification: "environment-failure" });
      expect(persisted.passiveFailure.baselineChecks).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 90_000);

  windowsIt("D187: oversized relay state fails closed before whole-file parsing", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d187-oversized-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      await writeFile(statePath, `{"phase":"paused","padding":"${"×❯".repeat(3_000_000)}"}`, "utf8");

      await expect(relay(repo, "-Action", "Status")).rejects.toThrow(/oversized JSON file|Refusing to read oversized/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D188: invalid relay state fails closed without mutation", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d188-invalid-state-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      const invalid = Buffer.from([0xff, 0xfe, 0xfd, 0x7b, 0x22]);
      await writeFile(statePath, invalid);
      await expect(relay(repo, "-Action", "Status")).rejects.toThrow(/strict UTF-8 JSON|Failed to read/);
      expect((await readFile(statePath)).equals(invalid)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D187: recovery compacts amplified state and is idempotent", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d187-recovery-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      const stableCommit = (await execa("git", ["rev-parse", "refs/tandem-relay/stable"], { cwd: repo })).stdout.trim();
      const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
      const amplified = {
        schemaVersion: 2,
        phase: "paused",
        pausedFromPhase: "passive-testing",
        pauseOrigin: "machine",
        pauseReasonCode: "candidate-failure",
        stableCommit,
        candidateCommit,
        passiveFailure: {
          candidateFailureIdentities: [{ file: "tests/example.test.ts", name: "suite > ❯ × 智能路径" }],
          output: "❯ × 智能路径 ".repeat(10_000),
        },
      };
      await writeFile(statePath, JSON.stringify(amplified), "utf8");

      const script = path.resolve("scripts/recover-reciprocal-relay-state.ps1");
      const first = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-MaxStateBytes", "32768", "-Force"], { cwd: repo });
      const recovered = JSON.parse(first.stdout);
      expect(recovered).toMatchObject({
        ok: true,
        alreadyCompact: false,
        phase: "paused",
        pauseOrigin: "machine",
        pauseReasonCode: "candidate-failure",
        candidateCommit,
        stableCommit,
      });
      expect(recovered.oldSizeBytes).toBeGreaterThan(recovered.newSizeBytes);
      expect(recovered.quarantinePath).toMatch(/state\.quarantine-D187-/);
      const compactState = JSON.parse(await readFile(statePath, "utf8"));
      expect(compactState.passiveFailure.recovery.oldSizeBytes).toBe(recovered.oldSizeBytes);
      expect(compactState.passiveFailure.failedCandidateCommands[0].output.length).toBeLessThan(1000);

      const second = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-MaxStateBytes", "32768"], { cwd: repo });
      expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, alreadyCompact: true, candidateCommit });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 45_000);

  windowsIt("D188: recovery rejects missing prefix candidate or stable commits", async () => {
    for (const missing of ["candidateCommit", "stableCommit"]) {
      const repo = await mkdtemp(path.join(tmpdir(), `tandem-relay-d188-recovery-missing-${missing}-`));
      try {
        await initRepo(repo);
        const candidateCommit = await createCandidate(repo);
        const stableCommit = (await execa("git", ["rev-parse", "refs/tandem-relay/stable"], { cwd: repo })).stdout.trim();
        const statePath = path.join(repo, ".git", "tandem-relay", "state.json");
        const amplified: Record<string, unknown> = {
          schemaVersion: 2,
          phase: "paused",
          pausedFromPhase: "passive-testing",
          pauseOrigin: "machine",
          pauseReasonCode: "candidate-failure",
          stableCommit,
          candidateCommit,
          padding: "❯ ×".repeat(20_000),
        };
        delete amplified[missing];
        const original = JSON.stringify(amplified);
        await writeFile(statePath, original, "utf8");
        const script = path.resolve("scripts/recover-reciprocal-relay-state.ps1");
        await expect(execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-MaxStateBytes", "1024", "-Force"], { cwd: repo })).rejects.toThrow(new RegExp(`missing ${missing}`));
        expect(await readFile(statePath, "utf8")).toBe(original);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
