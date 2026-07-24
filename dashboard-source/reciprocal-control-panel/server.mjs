import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  approvalBoundaryPlan,
  approvalFailureDetail,
  approvalCompletionRelayAction,
  approvalFlowRuntimeTopology,
  approvalRemainingActions,
  candidatePreviewArtifactCapabilityStatus,
  capabilityVersion,
  classifyReciprocalGate,
  detailMetadata,
  expectedRuntimeTopology,
  parseDirection,
  recoveryPlan,
  rejectedCandidateOriginRetirement,
  rejectedCandidateRelayAction,
  rejectedCandidateWishlist,
  requiredReciprocalCapabilities,
  runtimeTopologyHealth,
  reviewOriginItem,
  shortSha,
  validateAlreadyPromotedAUpgradeRecovery,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.resolve(process.env.TANDEM_RECIPROCAL_ROOT || path.join(here, ".."));
const repoRoot = path.resolve(process.env.TANDEM_SOURCE_REPO || path.join(relayRoot, "..", "HZ code"));
const controlPath = path.join(relayRoot, "control", "SHARED_DIRECTION.md");
const wishlistPath = path.join(relayRoot, "control", "WISHLIST.md");
const statePath = path.join(repoRoot, ".git", "tandem-relay", "state.json");
const orchestratorStatePath = path.join(relayRoot, "state", "orchestrator-state.json");
const auditPath = path.join(relayRoot, "control", "CONTROL_PANEL_AUDIT.jsonl");
const supervisorStatePath = path.join(relayRoot, "control", "continuation-supervisor-state.json");
const sourceReconciliationPendingPath = path.join(relayRoot, "control", "source-reconciliation-pending.json");
const runtimeRecoveryJournalPath = path.join(relayRoot, "state", "runtime-recovery-flow.json");
const finalizationPaths = {
  A: path.join(relayRoot, "state", "finalization-a.json"),
  B: path.join(relayRoot, "state", "finalization-b.json"),
};
const serverLogPath = path.join(relayRoot, "control", "dashboard-server.log");
const updateReviewPath = path.join(relayRoot, "control", "UPDATE_REVIEWS.md");
const updateReviewIndexPath = path.join(relayRoot, "control", "UPDATE_REVIEW_INDEX.json");
const mainUpdateReviewPath = path.join(relayRoot, "control", "MAIN_UPDATES.md");
const candidateSource = path.join(repoRoot, "release", "win-unpacked");
const candidateExe = path.join(candidateSource, "Tandem.exe");
const candidateHome = path.join(relayRoot, "state", "candidate-preview");
const candidateUserData = path.join(relayRoot, "user-data", "candidate-preview");
const candidateProject = path.join(relayRoot, "candidate-preview-project");
const token = randomBytes(24).toString("hex");
const authorityDecisionSecret = randomBytes(32).toString("hex");
const port = Number(process.env.PORT || process.argv.find((value) => value.startsWith("--port="))?.split("=")[1] || 4782);
const stopSignalPath = path.join(relayRoot, "control", `dashboard-stop-${port}.signal`);

const worktrees = {
  a: { label: "Copy A", path: path.join(relayRoot, "worktrees", "copy-a"), branch: "codex/reciprocal-a", executor: "Passive B target" },
  b: { label: "Copy B", path: path.join(relayRoot, "worktrees", "copy-b"), branch: "codex/reciprocal-b", executor: "Producer A" },
};
const automation = {
  A: { tokenFile: path.join(relayRoot, "state", "executor-a", "automation.json"), projectDir: worktrees.b.path },
  B: { tokenFile: path.join(relayRoot, "state", "executor-b", "automation.json"), projectDir: worktrees.a.path },
};
const activeRelayPhases = new Set(["working", "validating", "rollback-verification", "passive-testing", "a-upgrade-pending"]);
const approvalWaitTimeoutMs = Number(process.env.TANDEM_APPROVAL_WAIT_TIMEOUT_MS || 18_000_000);
const testHarness = process.env.TANDEM_DASHBOARD_TEST_HARNESS === "1";
const testCommandLogPath = process.env.TANDEM_DASHBOARD_COMMAND_LOG || "";
const testHarnessStartedRoles = new Set();
const packageIntegrityPromise = import(pathToFileURL(path.join(repoRoot, "scripts", "runtime-package-integrity.mjs")).href);
let approvalFlow = null;

const durableRecoveryStages = [
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
];

function rotateServerLog() {
  try {
    if (!existsSync(serverLogPath) || statSync(serverLogPath).size < 2 * 1024 * 1024) return;
    const rotated = `${serverLogPath}.1`;
    rmSync(rotated, { force: true });
    renameSync(serverLogPath, rotated);
  } catch {
    // Logging must never take down the control process.
  }
}

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function serverLog(event, detail = "") {
  try {
    rotateServerLog();
    const clean = String(detail || "").replace(/\r?\n/g, "\\n");
    const suffix = clean ? ` ${clean.length > 4000 ? `${clean.slice(0, 4000)}... [truncated ${clean.length} chars]` : clean}` : "";
    appendFileSync(serverLogPath, `${new Date().toISOString()} pid=${process.pid} port=${port} ${event}${suffix}\n`, "utf8");
  } catch {
    // A failed diagnostic write must not become a second process failure.
  }
}

process.on("uncaughtException", (error) => {
  serverLog("uncaughtException", errorText(error));
});

process.on("unhandledRejection", (reason) => {
  serverLog("unhandledRejection", errorText(reason));
});

function run(command, args, cwd = repoRoot, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`)));
  });
}

function runResult(command, args, cwd = repoRoot, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ ok: false, code: null, stdout: "", stderr: error.message, output: error.message }));
    child.on("close", (code) => resolve({
      ok: code === 0,
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
    }));
  });
}

const git = (cwd, ...args) => run("git", args, cwd);

async function runtimePackageIdentity(runtimeDir) {
  const integrity = await packageIntegrityPromise;
  return (await integrity.verifyPackage(runtimeDir)).packageIdentity;
}

async function verifyCandidatePackage(candidate) {
  const integrity = await packageIntegrityPromise;
  const proof = await integrity.verifyPackage(candidateSource, { sourceSha: candidate.sourceSha });
  const build = proof.buildInfo;
  const immutablePackagePath = build.immutablePackagePath ? path.resolve(build.immutablePackagePath) : path.resolve(candidateSource);
  if (immutablePackagePath !== path.resolve(candidateSource)) {
    const immutableProof = await integrity.verifyPackage(immutablePackagePath, {
      sourceSha: candidate.sourceSha,
      packageIdentity: proof.packageIdentity,
    });
    return { ...immutableProof, mutableAliasProof: proof, immutablePackagePath };
  }
  return { ...proof, immutablePackagePath };
}

function packageSourceForFlow(flow) {
  return flow?.immutablePackagePath || candidateSource;
}

async function recordHarnessCommand(args, cwd = repoRoot) {
  if (!testCommandLogPath) return;
  await appendFile(testCommandLogPath, `${JSON.stringify({ at: new Date().toISOString(), cwd, args })}\n`, "utf8");
}

async function powershellWithEnv(env, ...args) {
  await recordHarnessCommand(args);
  return run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], repoRoot, env);
}

async function powershell(...args) {
  await recordHarnessCommand(args);
  if (testHarness && args[0] === "-File") {
    const scriptName = path.basename(args[1] || "").toLowerCase();
    if (scriptName === "stop-reciprocal-tandem.ps1") {
      const roleIndex = args.findIndex((value) => value === "-Role");
      const role = roleIndex >= 0 ? args[roleIndex + 1] : "Both";
      const roles = role === "Both" ? ["A", "B"] : [role];
      for (const item of roles) testHarnessStartedRoles.delete(item);
      return roles.map((item) => `TEST stopped executor ${item}.`).join("\n");
    }
    if (scriptName === "start-reciprocal-tandem.ps1") {
      const roleIndex = args.findIndex((value) => value === "-Role");
      const role = roleIndex >= 0 ? args[roleIndex + 1] : "A";
      const roles = role === "Both" ? ["A"] : [role];
      for (const item of roles) {
        if (!["A", "B"].includes(item)) continue;
        await mkdir(path.dirname(automation[item].tokenFile), { recursive: true });
        await writeFile(automation[item].tokenFile, `${JSON.stringify({
          port: item === "A" ? 4101 : 4102,
          token: `test-token-${item}`,
          pid: item === "A" ? 4101 : 4102,
          instanceId: item,
          projectDir: automation[item].projectDir,
          tokenFile: automation[item].tokenFile,
        }, null, 2)}\n`, "utf8");
      }
      if (role === "Both") testHarnessStartedRoles.add("A");
      else {
        testHarnessStartedRoles.add(role);
      }
      return role === "Both" ? "TEST started expected topology." : `TEST started executor ${role}.`;
    }
    if (scriptName === "promote-reciprocal-runtime.ps1") {
      const sourceIndex = args.findIndex((value) => value === "-Source");
      const source = sourceIndex >= 0 ? args[sourceIndex + 1] : candidateSource;
      const roleIndex = args.findIndex((value) => value === "-TargetRole");
      const targetRole = roleIndex >= 0 ? args[roleIndex + 1] : "Both";
      const roles = targetRole === "Both" ? ["a", "b"] : [targetRole.toLowerCase()];
      const buildInfo = await jsonFile(path.join(source, "BUILD_INFO.json"), {});
      for (const role of roles) {
        const runtimeDir = path.join(relayRoot, "runtimes", `executor-${role}`);
        await rm(runtimeDir, { recursive: true, force: true });
        await mkdir(runtimeDir, { recursive: true });
        await cp(source, runtimeDir, { recursive: true });
        await writeFile(path.join(runtimeDir, "BUILD_INFO.json"), `${JSON.stringify({ ...buildInfo, promotedBy: "dashboard-test-harness" }, null, 2)}\n`, "utf8");
      }
      return `TEST promoted executor ${targetRole} runtime to ${shortSha(buildInfo.sourceSha)}.`;
    }
  }
  return run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args]);
}

function authorityDecisionBinding(request, decision, expiresAtUtc) {
  return [
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
}

function signedAuthorityDecisionPacket(request, decision) {
  const expiresAtUtc = new Date(Date.now() + 120_000).toISOString();
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
  };
  packet.signature = createHmac("sha256", authorityDecisionSecret)
    .update(authorityDecisionBinding(request, decision, expiresAtUtc))
    .digest("hex");
  return packet;
}

function readErrorFallback(file, fallback, error) {
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    return { ...fallback, _readError: { file, message: error.message || String(error) } };
  }
  return fallback;
}

async function jsonFile(file, fallback = null, maxBytes = 256 * 1024) {
  try {
    const info = await stat(file);
    if (info.size > maxBytes) throw new Error(`JSON file is too large (${info.size} bytes; max ${maxBytes})`);
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    return readErrorFallback(file, fallback, error);
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

async function loadRuntimeRecoveryJournal() {
  const journal = await jsonFile(runtimeRecoveryJournalPath, null);
  if (!journal) return null;
  if (typeof journal !== "object" || journal._readError) {
    throw new Error(`Runtime recovery journal is unreadable or corrupt: ${journal?._readError?.message || "invalid JSON"}.`);
  }
  if (journal.schemaVersion !== 1) throw new Error(`Runtime recovery journal schema ${journal.schemaVersion || "unknown"} is not supported.`);
  if (!durableRecoveryStages.includes(journal.stage)) throw new Error(`Runtime recovery journal has unknown stage ${journal.stage || "missing"}.`);
  if (!/^[0-9a-f]{40}$/i.test(String(journal.sourceSha || ""))) throw new Error("Runtime recovery journal is missing an exact source SHA.");
  if (!journal.packageIdentity) throw new Error("Runtime recovery journal is missing package identity.");
  return journal;
}

async function saveRuntimeRecoveryJournal(flow, durableStage = null, proof = {}) {
  if (!flow?.sourceSha) return null;
  const existing = await loadRuntimeRecoveryJournal();
  const stage = durableStage || flow.durableStage || existing?.stage || "package-ready";
  if (!durableRecoveryStages.includes(stage)) throw new Error(`Refusing to persist unknown runtime recovery stage ${stage}.`);
  const stageIndex = durableRecoveryStages.indexOf(stage);
  if (existing) {
    if (existing.sourceSha !== flow.sourceSha) throw new Error(`Runtime recovery journal source mismatch: ${shortSha(existing.sourceSha)} != ${shortSha(flow.sourceSha)}.`);
    const existingIndex = durableRecoveryStages.indexOf(existing.stage);
    if (stageIndex < existingIndex) throw new Error(`Runtime recovery journal refuses stage regression: ${existing.stage} -> ${stage}.`);
    if (stageIndex > existingIndex + 1) throw new Error(`Runtime recovery journal refuses stage skip: ${existing.stage} -> ${stage}.`);
    if (flow.packageIdentity && existing.packageIdentity !== flow.packageIdentity) throw new Error("Runtime recovery journal package identity mismatch.");
    if (flow.immutablePackagePath && existing.immutablePackagePath && path.resolve(existing.immutablePackagePath) !== path.resolve(flow.immutablePackagePath)) {
      throw new Error("Runtime recovery journal immutable package path mismatch.");
    }
  } else if (stage !== "package-ready" && !flow.recoveryOnly) {
    throw new Error(`Runtime recovery journal must start at package-ready, not ${stage}.`);
  }
  const journal = {
    schemaVersion: 1,
    id: flow.id,
    status: flow.status || existing?.status || "running",
    stage,
    durableStages: durableRecoveryStages,
    sourceSha: flow.sourceSha,
    candidateShortSha: shortSha(flow.sourceSha),
    packageIdentity: flow.packageIdentity || existing?.packageIdentity || null,
    immutablePackagePath: flow.immutablePackagePath || existing?.immutablePackagePath || null,
    approvalReviewKey: flow.sourceSha,
    expected: {
      worktrees: { A: automation.A.projectDir, B: automation.B.projectDir },
      endpoints: { A: automation.A.tokenFile, B: automation.B.tokenFile },
    },
    previousStableA: flow.previousStableA || existing?.previousStableA || null,
    interruptedPhase: flow.interruptedPhase || existing?.interruptedPhase || null,
    interruptedRole: flow.interruptedRole || existing?.interruptedRole || null,
    flags: {
      pausedByFlow: Boolean(flow.pausedByFlow ?? existing?.flags?.pausedByFlow),
      relayResumed: Boolean(flow.relayResumed ?? existing?.flags?.relayResumed),
      recoveryAuthorityReady: Boolean(flow.recoveryAuthorityReady ?? existing?.flags?.recoveryAuthorityReady),
      executorsStopped: Boolean(flow.executorsStopped ?? existing?.flags?.executorsStopped),
      promoted: Boolean(flow.promoted ?? existing?.flags?.promoted),
      executorsRestarted: Boolean(flow.executorsRestarted ?? existing?.flags?.executorsRestarted),
    },
    steps: flow.steps || existing?.steps || [],
    proof: { ...(existing?.proof || {}), ...proof },
    updatedAt: new Date().toISOString(),
    completedAt: flow.completedAt || existing?.completedAt || null,
    error: flow.error || existing?.error || null,
  };
  if (!journal.packageIdentity) throw new Error("Runtime recovery journal cannot be saved without package identity.");
  if (!journal.immutablePackagePath) throw new Error("Runtime recovery journal cannot be saved without immutable package path.");
  flow.durableStage = stage;
  await writeJsonAtomic(runtimeRecoveryJournalPath, journal);
  return journal;
}

function flowFromRuntimeRecoveryJournal(journal, candidate) {
  if (!journal || journal.sourceSha !== candidate.sourceSha) return null;
  return {
    id: journal.id || `approval-recovery-${Date.now()}`,
    status: journal.status === "completed" ? "completed" : "running",
    current: journal.steps?.at?.(-1)?.step || "durable-recovery",
    sourceSha: journal.sourceSha,
    startedAt: journal.startedAt || journal.updatedAt || new Date().toISOString(),
    steps: Array.isArray(journal.steps) ? journal.steps : [],
    pausedByFlow: Boolean(journal.flags?.pausedByFlow),
    relayResumed: Boolean(journal.flags?.relayResumed),
    recoveryAuthorityReady: Boolean(journal.flags?.recoveryAuthorityReady || durableRecoveryStages.indexOf(journal.stage) >= durableRecoveryStages.indexOf("b-verified")),
    executorsStopped: Boolean(journal.flags?.executorsStopped || durableRecoveryStages.indexOf(journal.stage) >= durableRecoveryStages.indexOf("a-stopped")),
    promoted: Boolean(journal.flags?.promoted || durableRecoveryStages.indexOf(journal.stage) >= durableRecoveryStages.indexOf("a-promoted")),
    executorsRestarted: Boolean(journal.flags?.executorsRestarted || durableRecoveryStages.indexOf(journal.stage) >= durableRecoveryStages.indexOf("a-started")),
    interruptedPhase: journal.interruptedPhase || "a-upgrade-pending",
    interruptedRole: journal.interruptedRole || null,
    packageIdentity: journal.packageIdentity || null,
    immutablePackagePath: journal.immutablePackagePath || journal.proof?.package?.immutablePackagePath || null,
    previousStableA: journal.previousStableA || null,
    durableStage: journal.stage || "package-ready",
    cancelRequested: false,
    forceRequested: false,
  };
}

function durableStageReached(flow, stage) {
  const current = durableRecoveryStages.indexOf(flow?.durableStage || "");
  const target = durableRecoveryStages.indexOf(stage);
  return current >= 0 && target >= 0 && current >= target;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hasEndpointEcho = (value) => value !== undefined && value !== null && String(value).trim() !== "";

function applyTestStatusSchema(role, status) {
  if (!testHarness) return status;
  const schema = process.env.TANDEM_DASHBOARD_TEST_STATUS_SCHEMA || "";
  const result = { ...status };
  if (schema === "old-no-echoes") {
    delete result.port;
    delete result.tokenFile;
    delete result.sourceSha;
    delete result.packageIdentity;
  }
  const overridePrefix = `TANDEM_DASHBOARD_TEST_STATUS_${role}_`;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(overridePrefix)) continue;
    const field = key.slice(overridePrefix.length);
    if (!field) continue;
    result[field[0].toLowerCase() + field.slice(1)] = value;
  }
  return result;
}

async function automationRequest(role, pathname, method = "GET", payload) {
  const config = automation[role];
  if (testHarness) await recordHarnessCommand(["AUTOMATION", role, method, pathname]);
  const testStatus = async () => {
    const build = await jsonFile(path.join(relayRoot, "runtimes", `executor-${role.toLowerCase()}`, "BUILD_INFO.json"), {});
    const status = {
      ok: true,
      running: false,
      pid: role === "A" ? 4101 : 4102,
      instanceId: role,
      projectDir: config.projectDir,
      allowedProjectDir: config.projectDir,
      tokenFile: config.tokenFile,
      sourceSha: build.sourceSha,
      packageIdentity: build.packageIdentity,
      capabilities: build.reciprocalCapabilities || build.sourceBuildInfo?.reciprocalCapabilities || { candidatePreviewArtifactLifecycle: 1 },
    };
    return applyTestStatusSchema(role, status);
  };
  if (testHarness && testHarnessStartedRoles.has(role) && pathname === "/status") {
    return testStatus();
  }
  if (testHarness && pathname === "/status" && existsSync(config.tokenFile)) {
    return testStatus();
  }
  if (testHarness && process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION === "1") {
    if (!testHarnessStartedRoles.has(role)) throw new Error(`TEST executor ${role} automation is not started.`);
    if (pathname === "/status") {
      return testStatus();
    }
    if (pathname === "/prompt" && method === "POST") {
      if (role === "A") {
        const current = await jsonFile(statePath, {});
        await writeFile(statePath, `${JSON.stringify({
          ...current,
          phase: "working",
          activeRole: "A",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
      }
      return { ok: true, accepted: true, projectDir: payload?.projectDir || config.projectDir, allowedProjectDir: config.projectDir };
    }
  }
  const credentials = await jsonFile(config.tokenFile, null);
  if (!credentials?.port || !credentials?.token) throw new Error(`Executor ${role} automation token is not ready.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://127.0.0.1:${credentials.port}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Executor ${role} automation returned HTTP ${response.status}.`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAutomation(role, timeoutMs = 30_000) {
  if (testHarness) {
    if (process.env.TANDEM_DASHBOARD_TEST_FAIL_WAIT_ROLE === role) {
      throw new Error(`TEST executor ${role} automation failed during wait.`);
    }
    if (process.env.TANDEM_DASHBOARD_TEST_REQUIRE_STARTED_AUTOMATION === "1" && !testHarnessStartedRoles.has(role)) {
      throw new Error(`TEST executor ${role} automation is not started.`);
    }
    return { pid: role === "A" ? 4101 : 4102, allowedProjectDir: automation[role].projectDir };
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = "endpoint unavailable";
  while (Date.now() < deadline) {
    try {
      const status = await automationRequest(role, "/status");
      if (path.resolve(status.allowedProjectDir).toLowerCase() !== path.resolve(automation[role].projectDir).toLowerCase()) {
        throw new Error(`endpoint targets ${status.allowedProjectDir}`);
      }
      return status;
    } catch (error) {
      lastError = error.message;
      await delay(300);
    }
  }
  throw new Error(`Executor ${role} automation did not become ready: ${lastError}`);
}

async function textFile(file, fallback = "") {
  try {
    const info = await stat(file);
    if (info.size > 1024 * 1024) throw new Error(`Text file is too large (${info.size} bytes)`);
    return await readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

async function getUpdateReviewIndex() {
  const index = await jsonFile(updateReviewIndexPath, {});
  const raw = await textFile(updateReviewPath, "");
  for (const section of raw.split(/^## /m).slice(1)) {
    const [header, ...body] = section.split(/\r?\n/);
    const headerMatch = header.match(/^(\S+)\s+-\s+([A-Z]+)\s+([0-9a-f]+)/i);
    const shaMatch = body.join("\n").match(/^- Candidate SHA:\s+([0-9a-f]{7,40})\s*$/m);
    const sourceSha = shaMatch?.[1] || "";
    if (!sourceSha || (index[sourceSha] && index[sourceSha].source !== "markdown-log")) continue;
    index[sourceSha] = {
      decision: (headerMatch?.[2] || "reviewed").toLowerCase(),
      at: headerMatch?.[1] || null,
      shortSha: shortSha(sourceSha) || headerMatch?.[3] || "",
      source: "markdown-log",
    };
  }
  return index;
}

async function persistUpdateReview(decision, comment, candidate) {
  const sourceSha = candidate.sourceSha || "";
  if (!sourceSha) return;
  const index = await getUpdateReviewIndex();
  index[sourceSha] = {
    decision,
    at: new Date().toISOString(),
    shortSha: candidate.shortSha || shortSha(sourceSha),
    builtAt: candidate.builtAt || null,
    comment: String(comment || "").trim() || null,
  };
  await mkdir(path.dirname(updateReviewIndexPath), { recursive: true });
  await writeFile(updateReviewIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

async function fileSignature(file) {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

async function currentRevision() {
  const files = [
    statePath,
    controlPath,
    wishlistPath,
    auditPath,
    path.join(relayRoot, "state", "executor-a", "config.json"),
    path.join(relayRoot, "state", "executor-b", "config.json"),
    path.join(relayRoot, "state", "executor-a", ".env"),
    path.join(relayRoot, "state", "executor-b", ".env"),
    automation.A.tokenFile,
    automation.B.tokenFile,
    path.join(repoRoot, "src", "providers", "registry.ts"),
    path.join(repoRoot, "src", "config", "schema.ts"),
    path.join(repoRoot, "app", "renderer", "src", "cli-model-options.ts"),
    path.join(relayRoot, "runtimes", "executor-a", "Tandem.exe"),
    path.join(relayRoot, "runtimes", "executor-b", "Tandem.exe"),
    path.join(relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"),
    path.join(relayRoot, "runtimes", "executor-b", "BUILD_INFO.json"),
    path.join(repoRoot, "release", "win-unpacked", "Tandem.exe"),
    path.join(repoRoot, "release", "win-unpacked", "BUILD_INFO.json"),
    path.join(repoRoot, "scripts", "reciprocal-relay.ps1"),
    path.join(here, "lib.mjs"),
    path.join(here, "server.mjs"),
    path.join(here, "public", "index.html"),
    path.join(here, "public", "app.js"),
    path.join(here, "public", "update-gate.css"),
    updateReviewPath,
    updateReviewIndexPath,
    mainUpdateReviewPath,
  ];
  const [headA, headB, dirtyA, dirtyB, processA, processB, versionRefs, ...fileStats] = await Promise.all([
    git(worktrees.a.path, "rev-parse", "HEAD").catch(() => ""),
    git(worktrees.b.path, "rev-parse", "HEAD").catch(() => ""),
    git(worktrees.a.path, "status", "--porcelain", "--untracked-files=all").catch(() => ""),
    git(worktrees.b.path, "status", "--porcelain", "--untracked-files=all").catch(() => ""),
    getRuntime("A").then((runtime) => `${runtime.running}:${runtime.pid}:${runtime.builtAt}`).catch(() => "A:unknown"),
    getRuntime("B").then((runtime) => `${runtime.running}:${runtime.pid}:${runtime.builtAt}`).catch(() => "B:unknown"),
    git(repoRoot, "for-each-ref", "--format=%(refname):%(objectname)", "refs/tags/main-update-*", "refs/remotes/origin/master").catch(() => ""),
    ...files.map((file) => fileSignature(file)),
  ]);
  const revision = createHash("sha256")
    .update(JSON.stringify({ headA, headB, dirtyA, dirtyB, processA, processB, versionRefs, fileStats }))
    .digest("hex")
    .slice(0, 16);
  return { revision, checkedAt: new Date().toISOString() };
}

async function getWorktree(key) {
  const config = worktrees[key];
  const [branch, head, subject, dirty, checkpoint, version, drift] = await Promise.all([
    git(config.path, "branch", "--show-current").catch(() => "missing"),
    git(config.path, "rev-parse", "HEAD").catch(() => ""),
    git(config.path, "log", "-1", "--format=%s").catch(() => "Unavailable"),
    git(config.path, "status", "--porcelain", "--untracked-files=all").catch(() => ""),
    textFile(path.join(config.path, ".tandem", "reciprocal-checkpoint.md")),
    jsonFile(path.join(config.path, "package.json"), {}),
    getBranchDrift(config.branch),
  ]);
  return { ...config, branch, head, shortHead: shortSha(head), subject, dirtyCount: dirty ? dirty.split(/\r?\n/).length : 0, checkpoint, version: version.version || "unknown", drift };
}

async function getBranchDrift(branch) {
  const raw = await git(repoRoot, "rev-list", "--left-right", "--count", `master...${branch}`).catch(() => "");
  const [behindMaster, aheadOfMaster] = raw.split(/\s+/).map((value) => Number(value || 0));
  return {
    aheadOfMaster: Number.isFinite(aheadOfMaster) ? aheadOfMaster : null,
    behindMaster: Number.isFinite(behindMaster) ? behindMaster : null,
    upToDate: aheadOfMaster === 0 && behindMaster === 0,
  };
}

async function getRuntime(role) {
  const slug = role.toLowerCase();
  const exe = path.join(relayRoot, "runtimes", `executor-${slug}`, "Tandem.exe");
  const buildInfo = await jsonFile(path.join(relayRoot, "runtimes", `executor-${slug}`, "BUILD_INFO.json"), null);
  const info = existsSync(exe) ? await stat(exe) : null;
  const escaped = exe.replaceAll("'", "''");
  const processJson = await powershell("-Command", `$p=Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '${escaped}' } catch { $false } } | Select-Object -First 1 Id,StartTime,Path; if ($p) { $p | ConvertTo-Json -Compress }`).catch(() => "");
  const process = processJson ? JSON.parse(processJson) : null;
  const version = existsSync(exe)
    ? await powershell("-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`).catch(() => "unknown")
    : "missing";
  return { role, path: exe, exists: Boolean(info), running: Boolean(process), pid: process?.Id || null, startedAt: process?.StartTime || null, version: version || "unknown", builtAt: info?.mtime.toISOString() || null, size: info?.size || 0, buildInfo };
}

async function getProducerRelayStatus(worktree = worktrees.b) {
  const output = await powershell("-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"), "-Action", "Status", "-Workspace", worktree.path)
    .catch((error) => JSON.stringify({ capabilities: {}, error: error.message }));
  try {
    const status = JSON.parse(output.replace(/^\uFEFF/, ""));
    return {
      ...status,
      path: worktree.path,
      workspace: worktree.path,
      sha: await git(worktree.path, "rev-parse", "HEAD").catch(() => ""),
    };
  } catch (error) {
    return {
      capabilities: {},
      path: worktree.path,
      workspace: worktree.path,
      sha: await git(worktree.path, "rev-parse", "HEAD").catch(() => ""),
      error: error.message,
    };
  }
}

async function getArtifactCapabilityStatus(runtimeA, runtimeB, producerStatus = null, topology = null) {
  return candidatePreviewArtifactCapabilityStatus({
    producer: producerStatus || await getProducerRelayStatus(),
    runtimeA,
    runtimeB,
    topology,
  });
}

function artifactCapabilityActivationPlan({ masterHead, relayState, candidateUpdate, runtimeA, runtimeB, capability }) {
  const sourceCommit = masterHead || null;
  const currentStable = relayState?.stableCommit || null;
  const currentPreview = candidateUpdate?.sourceSha || null;
  const currentRuntimeA = runtimeA?.buildInfo?.sourceSha || null;
  const currentRuntimeB = runtimeB?.buildInfo?.sourceSha || null;
  const required = { candidatePreviewArtifactLifecycle: 1 };
  const warning = currentPreview
    ? `Approving or promoting current preview ${shortSha(currentPreview)} alone will not enable candidatePreviewArtifactLifecycle v1.`
    : "No current preview can enable candidatePreviewArtifactLifecycle v1 by itself.";
  return {
    requiredCapability: required,
    sourceCommit,
    sourceShortSha: shortSha(sourceCommit),
    currentStable,
    currentStableShortSha: shortSha(currentStable),
    currentCandidatePreview: currentPreview,
    currentCandidatePreviewShortSha: shortSha(currentPreview),
    currentRuntimeBuilds: {
      A: { sourceSha: currentRuntimeA, shortSha: shortSha(currentRuntimeA), capabilityVersion: capabilityVersion(runtimeA?.buildInfo, "candidatePreviewArtifactLifecycle") },
      B: { sourceSha: currentRuntimeB, shortSha: shortSha(currentRuntimeB), capabilityVersion: capabilityVersion(runtimeB?.buildInfo, "candidatePreviewArtifactLifecycle") },
    },
    atomicRuntimePromotionRequired: true,
    operational: Boolean(capability?.compatible),
    warning,
    nextSafeHumanAction: "Finish the current W0021 preview review first; keep it separate from the protocol upgrade.",
    steps: [
      "Finish the current W0021 candidate-preview review without overwriting or repackaging it.",
      "Reconcile a source commit containing the D162-D165 artifact lifecycle capability into both reciprocal worktrees through the existing human main/protocol gate.",
      "Package and passive-test that exact source commit; verify BUILD_INFO advertises candidatePreviewArtifactLifecycle v1.",
      "Use the existing human runtime promotion/restart gate to promote Executor A and Executor B atomically.",
      "Treat candidate-preview artifact creation as operational only after the producer relay and both pinned runtimes report candidatePreviewArtifactLifecycle >= 1.",
    ],
    refusedActions: [
      "force push",
      "automatic branch reconciliation",
      "automatic runtime promotion",
      "overwriting release/win-unpacked while W0021 remains under review",
      "claiming v1 is operational while any capability check is below v1",
    ],
  };
}

async function getProcessByPath(exe) {
  const escaped = exe.replaceAll("'", "''");
  const processJson = await powershell("-Command", `$p=Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '${escaped}' } catch { $false } } | Select-Object -First 1 Id,StartTime,Path; if ($p) { $p | ConvertTo-Json -Compress }`).catch(() => "");
  return processJson ? JSON.parse(processJson) : null;
}

async function getProcessesByPath(exe) {
  const escaped = exe.replaceAll("'", "''");
  const processJson = await powershell("-Command", `$p=Get-Process -Name Tandem -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq '${escaped}' } catch { $false } } | Select-Object Id,StartTime,Path; if ($p) { @($p) | ConvertTo-Json -Compress }`).catch(() => "");
  if (!processJson) return [];
  const parsed = JSON.parse(processJson);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getCandidateUpdate(runtimeA, runtimeB, relayState = {}, reviewIndex = {}) {
  const exeExists = existsSync(candidateExe);
  const buildInfoPath = path.join(candidateSource, "BUILD_INFO.json");
  const buildInfo = await jsonFile(buildInfoPath, null);
  const previewProcesses = exeExists ? await getProcessesByPath(candidateExe) : [];
  const previewProcess = previewProcesses[0] || null;
  const promoted = [
    { role: "A", sourceSha: runtimeA.buildInfo?.sourceSha || "", shortSha: runtimeA.buildShortSha || shortSha(runtimeA.buildInfo?.sourceSha) },
    { role: "B", sourceSha: runtimeB.buildInfo?.sourceSha || "", shortSha: runtimeB.buildShortSha || shortSha(runtimeB.buildInfo?.sourceSha) },
  ];
  const candidateSha = buildInfo?.sourceSha || "";
  const candidateShortSha = shortSha(candidateSha);
  const unknown = exeExists && !candidateSha;
  const relayExpectedSha = relayState.phase === "a-upgrade-pending" ? relayState.stableCommit || "" : "";
  const expectedShortSha = shortSha(relayExpectedSha);
  const matchesRelayExpected = Boolean(!relayExpectedSha || candidateSha === relayExpectedSha);
  const reviewed = candidateSha ? reviewIndex[candidateSha] || null : null;
  const pending = Boolean(exeExists && candidateSha && matchesRelayExpected && !reviewed && promoted.some((item) => item.sourceSha !== candidateSha));
  const message = unknown
    ? "Unknown candidate provenance - rebuild to enable update detection"
    : relayExpectedSha && !exeExists
      ? `Accepted stable ${expectedShortSha} has no preview build yet`
      : relayExpectedSha && candidateSha && candidateSha !== relayExpectedSha
        ? `Accepted stable ${expectedShortSha} is waiting; release/win-unpacked is ${candidateShortSha || "unknown"}`
        : reviewed
          ? `Candidate ${candidateShortSha} was already reviewed`
          : pending
            ? "Update available"
            : exeExists
              ? "No pending update"
              : "No candidate build found";
  const aheadCounts = {};
  if (candidateSha) {
    for (const item of promoted) {
      aheadCounts[item.role] = item.sourceSha
        ? Number(await git(repoRoot, "rev-list", "--count", `${item.sourceSha}..${candidateSha}`).catch(() => "0"))
        : null;
    }
  }
  return {
    sourceDir: candidateSource,
    exe: candidateExe,
    exists: exeExists,
    buildInfoPath,
    buildInfo,
    immutablePackagePath: buildInfo?.immutablePackagePath || null,
    sourceSha: candidateSha,
    shortSha: candidateShortSha,
    expectedSha: relayExpectedSha,
    expectedShortSha,
    matchesRelayExpected,
    reviewed,
    builtAt: buildInfo?.builtAt || null,
    pending,
    unknownProvenance: unknown,
    message,
    aheadCounts,
    promoted,
    preview: {
      running: Boolean(previewProcess),
      pid: previewProcess?.Id || null,
      pids: previewProcesses.map((item) => item.Id),
      startedAt: previewProcess?.StartTime || null,
      home: candidateHome,
      userData: candidateUserData,
      project: candidateProject,
    },
  };
}

function providerFor(model, custom) {
  if (custom?.provider) return custom.provider;
  if (model === "codex/cli") return "codex-cli";
  if (model === "claude-code/cli") return "claude-code-cli";
  if (model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("google/")) return "google";
  if (model.startsWith("openai/")) return "openai";
  return "openai-compatible";
}

function mediaFor(provider, custom) {
  if (custom?.media) return custom.media;
  if (["anthropic", "google", "claude-code-cli"].includes(provider)) return { images: true, pdf: true };
  if (provider === "openai") return { images: true, pdf: false };
  return { images: false, pdf: false };
}

function parseModelSelection(value) {
  if (value.startsWith("claude-code/cli::model:")) {
    const variant = value.slice("claude-code/cli::model:".length);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(variant)) throw new Error("Invalid Claude CLI model selection");
    return { id: "claude-code/cli", claudeCliModel: variant === "default" ? "" : variant };
  }
  if (value.startsWith("codex/cli::effort:")) {
    const effort = value.slice("codex/cli::effort:".length);
    if (!["default", "minimal", "low", "medium", "high"].includes(effort)) throw new Error("Invalid Codex CLI reasoning selection");
    return { id: "codex/cli", codexCliReasoningEffort: effort === "default" ? "" : effort };
  }
  return { id: value };
}

function readStringProperty(source, property) {
  return source.match(new RegExp(`\\b${property}:\\s*"([^"]+)"`))?.[1] || "";
}

function defaultCustomModelsFromSchema(source) {
  const section = source.match(/customModels:\s*\[([\s\S]*?)\n\s*\]\s*\n};/)?.[1] || "";
  return [...section.matchAll(/\{[\s\S]*?\n\s*\}/g)].map((match) => {
    const block = match[0];
    const id = readStringProperty(block, "id");
    if (!id) return null;
    const model = { id };
    for (const property of ["provider", "baseURL", "apiKeyEnv", "modelName"]) {
      const value = readStringProperty(block, property);
      if (value) model[property] = value;
    }
    return model;
  }).filter(Boolean);
}

function configuredEnvKeys(value) {
  const keys = new Set();
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match && match[2] && !/^['"]?['"]?$/.test(match[2])) keys.add(match[1]);
  }
  return keys;
}

function parseEnvFile(value) {
  const env = { ...process.env };
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let next = match[2];
    if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
      next = next.slice(1, -1);
    }
    env[match[1]] = next;
  }
  return env;
}

function wishlistItemForReview(direction, stableSha) {
  const explicitOrigin = reviewOriginItem(direction, stableSha);
  if (explicitOrigin) return explicitOrigin;
  const items = direction.items || [];
  return items.find((item) => {
    const metadata = detailMetadata(item.detail);
    return metadata.stable === stableSha || metadata.commit === stableSha;
  }) || items.find((item) => {
    const metadata = detailMetadata(item.detail);
    return item.status === "IN_PROGRESS" && metadata.role === "A";
  }) || items.find((item) => item.status === "CANDIDATE") || null;
}

function reviewSummaryForItem(item) {
  if (!item) return "A verified build is waiting for functional review.";
  const metadata = detailMetadata(item.detail);
  const step = metadata.step || metadata.next || "";
  if (/session search/i.test(item.text || "")) {
    if (step && !step.startsWith("3/")) return "Session search backend work only - nothing new to see yet.";
    return "Session search now has a UI search box for finding past sessions.";
  }
  if (/telegram remote control/i.test(item.text || "")) {
    return "Telegram remote control has a reviewed plan ready; no runtime behavior changed yet.";
  }
  const visibleText = String(item.text || "")
    .replace(/\s*Evidence:[\s\S]*$/i, "")
    .replace(/^.+?:\s*/, "")
    .trim();
  return visibleText
    ? `${visibleText.replace(/[. ]+$/, "")}.`
    : "A verified build is waiting for functional review.";
}

function reviewNoteForRelay(relayState, direction, candidateUpdate, reviewIndex) {
  const stableSha = relayState.phase === "a-upgrade-pending" ? relayState.stableCommit || "" : "";
  if (!stableSha) return { ready: false, visible: false };
  const review = reviewIndex[stableSha] || null;
  const previewReady = Boolean(candidateUpdate.exists && candidateUpdate.sourceSha === stableSha && !candidateUpdate.unknownProvenance);
  const item = wishlistItemForReview(direction, stableSha);
  const short = shortSha(stableSha);
  const message = review
    ? `Accepted stable ${short} was already reviewed.`
    : previewReady
      ? `Accepted stable ${short} has a matching Launch Candidate preview.`
      : candidateUpdate.exists && candidateUpdate.sourceSha
        ? `Accepted stable ${short} is ready, but automated packaging has not replaced stale release/win-unpacked ${candidateUpdate.shortSha}.`
        : `Accepted stable ${short} is ready, but automated packaging has not produced the Launch Candidate preview yet.`;
  return {
    ready: true,
    visible: !review,
    stableSha,
    shortSha: short,
    previewReady,
    reviewed: Boolean(review),
    review,
    summary: reviewSummaryForItem(item),
    wishlistId: item?.id || null,
    message,
  };
}

function claudeCliModelOptionsFromSource(source) {
  const match = source.match(/claudeCliModelOptions\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).filter(Boolean);
}

let locatorPromise;
async function cliLocators() {
  locatorPromise ||= (async () => {
    const repoTsxApi = path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs");
    const sourceRoot = path.resolve(here, "..", "..");
    const sourceTsxApi = path.join(sourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs");
    const tsxApi = existsSync(repoTsxApi) ? repoTsxApi : sourceTsxApi;
    const { tsImport } = await import(pathToFileURL(tsxApi).href);
    const locatorRoot = existsSync(path.join(repoRoot, "src", "agents")) ? repoRoot : sourceRoot;
    const parentURL = pathToFileURL(path.join(locatorRoot, "dashboard-model-resolution.mjs")).href;
    const tsconfig = path.join(locatorRoot, "tsconfig.json");
    const [codex, claude] = await Promise.all([
      tsImport(pathToFileURL(path.join(locatorRoot, "src", "agents", "codex-cli", "locate.ts")).href, { parentURL, tsconfig }),
      tsImport(pathToFileURL(path.join(locatorRoot, "src", "agents", "claude-code-cli", "locate.ts")).href, { parentURL, tsconfig }),
    ]);
    return { locateCodexCli: codex.locateCodexCli, locateClaudeCli: claude.locateClaudeCli };
  })();
  return locatorPromise;
}

function resolveLocator(locator, options) {
  return Promise.resolve()
    .then(() => locator(options))
    .catch(() => null);
}

async function getModelSettings(role, runtime) {
  const slug = role.toLowerCase();
  const configPath = path.join(relayRoot, "state", `executor-${slug}`, "config.json");
  const envPath = path.join(relayRoot, "state", `executor-${slug}`, ".env");
  const config = await jsonFile(configPath, {});
  const envText = await textFile(envPath);
  const env = parseEnvFile(envText);
  const source = await textFile(path.join(repoRoot, "src", "providers", "registry.ts"));
  const schemaSource = await textFile(path.join(repoRoot, "src", "config", "schema.ts"));
  const cliModelOptionsSource = await textFile(path.join(repoRoot, "app", "renderer", "src", "cli-model-options.ts"));
  const builtIns = [...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  const defaultCustom = defaultCustomModelsFromSchema(schemaSource);
  const custom = Array.isArray(config.customModels) ? config.customModels : [];
  const mergedCustom = [...custom, ...defaultCustom.filter((model) => !custom.some((existing) => existing.id === model.id))];
  const ids = [...new Set([...mergedCustom.map((model) => model.id), ...builtIns])].filter(Boolean);
  const envKeys = configuredEnvKeys(envText);
  const { locateCodexCli, locateClaudeCli } = await cliLocators();
  const cliResolved = {
    "codex-cli": await resolveLocator(locateCodexCli, { env, overridePath: config.codexCliPath }),
    "claude-code-cli": await resolveLocator(locateClaudeCli, { env, overridePath: config.claudeCliPath }),
  };
  const defaultEnv = { anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" };
  const models = ids.map((id) => {
    const customModel = mergedCustom.find((model) => model.id === id);
    const provider = providerFor(id, customModel);
    const requirement = customModel?.apiKeyEnv || defaultEnv[provider] || null;
    const resolvedPath = Object.hasOwn(cliResolved, provider) ? cliResolved[provider] : null;
    const available = Object.hasOwn(cliResolved, provider) ? Boolean(resolvedPath) : requirement ? envKeys.has(requirement) : false;
    return { id, provider, available, envKey: requirement, media: mediaFor(provider, customModel), custom: Boolean(customModel), resolvedPath };
  });
  return {
    role,
    configPath,
    running: runtime.running,
    leader: config.leader || "",
    worker: config.worker || "",
    codexCliModel: config.codexCliModel || "",
    claudeCliModel: config.claudeCliModel || "",
    claudeCliModelOptions: claudeCliModelOptionsFromSource(cliModelOptionsSource),
    codexCliReasoningEffort: config.codexCliReasoningEffort || "",
    cliResolved,
    models,
    defaultCustomModels: defaultCustom,
  };
}

async function mainTagForSha(sha) {
  if (!sha) return null;
  const tags = await git(repoRoot, "tag", "--points-at", sha, "--list", "main-update-*", "--sort=-version:refname").catch(() => "");
  return tags.split(/\r?\n/).filter(Boolean)[0] || null;
}

async function getMainVersionStatus(masterHead, stableSha, candidate, runtimeA, runtimeB) {
  const tags = await git(repoRoot, "tag", "--merged", "master", "--list", "main-update-*", "--sort=-version:refname").catch(() => "");
  const tag = tags.split(/\r?\n/).filter(Boolean)[0] || null;
  const [tagSha, tagDate, candidateTag, runtimeATag, runtimeBTag] = await Promise.all([
    tag ? git(repoRoot, "rev-list", "-n", "1", tag).catch(() => "") : "",
    tag ? git(repoRoot, "for-each-ref", `refs/tags/${tag}`, "--format=%(creatordate:iso-strict)").catch(() => "") : "",
    mainTagForSha(candidate?.sourceSha),
    mainTagForSha(runtimeA.buildInfo?.sourceSha),
    mainTagForSha(runtimeB.buildInfo?.sourceSha),
  ]);
  let pendingStableCommits = null;
  if (stableSha) {
    if (!tag) {
      pendingStableCommits = Number(await git(repoRoot, "rev-list", "--count", stableSha).catch(() => "0"));
    } else {
      const ancestor = await git(repoRoot, "merge-base", "--is-ancestor", tag, stableSha).then(() => true).catch(() => false);
      pendingStableCommits = ancestor ? Number(await git(repoRoot, "rev-list", "--count", `${tag}..${stableSha}`).catch(() => "0")) : null;
    }
  }
  return {
    tag,
    sha: tagSha,
    shortSha: shortSha(tagSha),
    date: tagDate || null,
    masterHead,
    masterShortSha: shortSha(masterHead),
    stableSha,
    stableShortSha: shortSha(stableSha),
    pendingStableCommits,
    candidateTag,
    runtimeTags: { A: runtimeATag, B: runtimeBTag },
    label: tag ? `${tag} (${shortSha(tagSha)}, ${tagDate ? new Date(tagDate).toLocaleDateString() : "unknown date"})` : `untagged master (${shortSha(masterHead) || "unknown"})`,
  };
}

async function getStatus() {
  const [legacyState, orchestratorState, directionText, wishlistText, supervisorState, sourceReconciliationPending, finalizationA, finalizationB, a, b, runtimeA, runtimeB, producerRelay, historyText, stableExists, masterHead, updateReviewIndex, recoveryJournal] = await Promise.all([
    jsonFile(statePath, {}),
    jsonFile(orchestratorStatePath, null),
    textFile(controlPath),
    textFile(wishlistPath),
    jsonFile(supervisorStatePath, {}),
    jsonFile(sourceReconciliationPendingPath, null),
    jsonFile(finalizationPaths.A, null),
    jsonFile(finalizationPaths.B, null),
    getWorktree("a"),
    getWorktree("b"),
    getRuntime("A"),
    getRuntime("B"),
    getProducerRelayStatus(),
    git(repoRoot, "log", "--all", "-16", "--date=iso-strict", "--format=%H%x1f%h%x1f%aI%x1f%s").catch(() => ""),
    git(repoRoot, "show-ref", "--verify", "--quiet", "refs/tandem-relay/stable").then(() => true).catch(() => false),
    git(repoRoot, "rev-parse", "master").catch(() => ""),
    getUpdateReviewIndex(),
    loadRuntimeRecoveryJournal(),
  ]);
  const state = orchestratorState ? {
    schemaVersion: "D196-orchestrator",
    turn: null,
    activeRole: null,
    nextRole: "A",
    candidateCommit: null,
    rollbackCommit: null,
    ...orchestratorState,
    stableCommit: orchestratorState.stableCommit || legacyState.stableCommit || null,
    legacyPhase: legacyState.phase || null,
    legacyStableCommit: legacyState.stableCommit || null,
  } : legacyState;
  for (const runtime of [runtimeA, runtimeB]) {
    const sourceSha = runtime.buildInfo?.sourceSha || "";
    runtime.buildShortSha = shortSha(sourceSha) || runtime.buildInfo?.sourceShortSha || "unknown";
    runtime.lagsMaster = Boolean(!sourceSha || (masterHead && sourceSha !== masterHead));
  }
  const candidateUpdate = await getCandidateUpdate(runtimeA, runtimeB, state, updateReviewIndex);
  const runtimeTopology = approvalFlowRuntimeTopology(approvalFlow || recoveryJournal) || expectedRuntimeTopology(state, recoveryJournal);
  const topologyHealth = runtimeTopologyHealth(runtimeTopology, { a: runtimeA, b: runtimeB });
  const artifactCapability = await getArtifactCapabilityStatus(runtimeA, runtimeB, producerRelay, runtimeTopology);
  artifactCapability.activationPlan = artifactCapabilityActivationPlan({ masterHead, relayState: state, candidateUpdate, runtimeA, runtimeB, capability: artifactCapability });
  if (!artifactCapability.compatible) {
    artifactCapability.message = `${artifactCapability.message} Next safe action: ${artifactCapability.activationPlan.nextSafeHumanAction} ${artifactCapability.activationPlan.warning}`;
  }
  const mainVersion = await getMainVersionStatus(masterHead, state.stableCommit, candidateUpdate, runtimeA, runtimeB);
  candidateUpdate.mainVersion = mainVersion.tag;
  candidateUpdate.candidateMainVersion = mainVersion.candidateTag;
  candidateUpdate.promoted = candidateUpdate.promoted.map((item) => ({ ...item, mainVersion: mainVersion.runtimeTags[item.role] }));
  const [modelsA, modelsB] = await Promise.all([getModelSettings("A", runtimeA), getModelSettings("B", runtimeB)]);
  const direction = parseDirection(directionText);
  const workState = parseDirection(wishlistText);
  direction.autonomyDefault = directionText.match(/^AutonomyDefault:\s*(plan-gated|autonomous)\s*$/m)?.[1] || "plan-gated";
  direction.items = await Promise.all(workState.items.map(async (item) => {
    const metadata = detailMetadata(item.detail);
    const effectiveAutonomy = metadata.autonomy === "full" || (!metadata.autonomy && direction.autonomyDefault === "autonomous") ? "full" : "plan-gated";
    if (metadata.epic !== "true" || !metadata.plan) return { ...item, effectiveAutonomy };
    const planText = await textFile(path.join(worktrees.a.path, metadata.plan));
    const planSteps = [...planText.matchAll(/^- \[([ x])\] (Step \d+:.*?)$/gm)].map((match) => ({ done: match[1] === "x", text: match[2] }));
    return { ...item, effectiveAutonomy, planSteps };
  }));
  direction.nextQueuedItem = direction.items.find((item) => item.status === "QUEUED") || null;
  const activeItem = direction.items.find((item) => item.status === "IN_PROGRESS" && /\brole=/.test(item.detail || "")) || direction.nextQueuedItem;
  const supervisorGate = classifyReciprocalGate({
    state: {
      ...state,
      humanPaused: state.pauseOrigin === "human",
    },
    item: activeItem,
    attemptCount: supervisorState?.blocker?.attemptCount || 0,
    reason: supervisorState?.blocker?.message || "",
  });
  const pendingFinalization = finalizationA || finalizationB || null;
  candidateUpdate.reviewNote = reviewNoteForRelay(state, direction, candidateUpdate, updateReviewIndex);
  const history = historyText.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, short, date, subject] = line.split("\x1f");
    return { sha, short, date, subject };
  });
  const health = [
    { label: "Stable recovery ref", ok: stableExists, detail: stableExists ? shortSha(state.stableCommit) : "Missing" },
    { label: "Orchestrator state", ok: Boolean(orchestratorState && !orchestratorState._readError), detail: orchestratorState?._readError ? `Unavailable: ${orchestratorState._readError.message}` : (state.phase || "Unavailable") },
    { label: "Supervisor", ok: supervisorGate.category !== "hard-blocked", detail: `${supervisorState?.displayState || supervisorGate.nextAction}${supervisorState?.blocker?.nextAttemptAt ? `; next ${supervisorState.blocker.nextAttemptAt}` : ""}` },
    {
      label: "Resume circuit breaker",
      ok: Number(state.resumeCount || 0) < Number(state.resumeThreshold || 3),
      detail: `${Number(state.resumeCount || 0)}/${Number(state.resumeThreshold || 3)} repeated resumes`,
    },
    { label: "Copy A worktree", ok: a.branch === worktrees.a.branch, detail: a.dirtyCount ? `${a.dirtyCount} local changes` : "Clean" },
    { label: "Copy B worktree", ok: b.branch === worktrees.b.branch, detail: b.dirtyCount ? `${b.dirtyCount} local changes` : "Clean" },
    { label: "Pinned runtimes", ok: runtimeA.exists && runtimeB.exists, detail: `${Number(runtimeA.exists) + Number(runtimeB.exists)}/2 available` },
    { label: "Runtime topology", ok: topologyHealth.ok, detail: topologyHealth.detail },
    { label: "Preview artifact protocol", ok: artifactCapability.compatible, detail: artifactCapability.compatible ? "Ready" : artifactCapability.message },
    { label: "Branches vs master", ok: a.drift.upToDate && b.drift.upToDate, detail: `A ${a.drift.behindMaster}/${a.drift.aheadOfMaster}, B ${b.drift.behindMaster}/${b.drift.aheadOfMaster}` },
    { label: "Runtime builds vs master", ok: !runtimeA.lagsMaster && !runtimeB.lagsMaster, detail: `A ${runtimeA.buildShortSha}, B ${runtimeB.buildShortSha}` },
    { label: "Candidate update", ok: !candidateUpdate.unknownProvenance, detail: candidateUpdate.reviewNote?.visible ? `${candidateUpdate.reviewNote.shortSha} awaits review` : candidateUpdate.message },
    { label: "Source reconciliation", ok: !sourceReconciliationPending, detail: sourceReconciliationPending ? `${sourceReconciliationPending.status}: ${sourceReconciliationPending.reasonCode}` : "No pending source reconciliation" },
    { label: "Candidate finalization", ok: true, detail: pendingFinalization ? `${pendingFinalization.wishlistId || "candidate"}: ${pendingFinalization.stage || "pending"}${pendingFinalization.commit ? ` ${shortSha(pendingFinalization.commit)}` : ""}` : "No pending finalization" },
  ];
  const driftWarnings = [
    a.drift.upToDate ? null : `Copy A branch is ${a.drift.behindMaster} behind / ${a.drift.aheadOfMaster} ahead master`,
    b.drift.upToDate ? null : `Copy B branch is ${b.drift.behindMaster} behind / ${b.drift.aheadOfMaster} ahead master`,
    runtimeA.lagsMaster ? `Runtime A build ${runtimeA.buildShortSha} lags master ${shortSha(masterHead)}` : null,
    runtimeB.lagsMaster ? `Runtime B build ${runtimeB.buildShortSha} lags master ${shortSha(masterHead)}` : null,
  ].filter(Boolean);
  return {
    now: new Date().toISOString(), repoRoot, relayRoot, controlPath, wishlistPath,
    master: { head: masterHead, shortHead: shortSha(masterHead) },
    drift: { warnings: driftWarnings, ok: driftWarnings.length === 0 },
    state: { ...sanitizedRelayState(state), shortStable: shortSha(state.stableCommit), shortCandidate: shortSha(state.candidateCommit), shortRollback: shortSha(state.rollbackCommit) },
    legacyRelay: { phase: legacyState.phase || null, stableCommit: legacyState.stableCommit || null, shortStable: shortSha(legacyState.stableCommit) },
    direction,
    supervisor: {
      ...supervisorState,
      gate: supervisorGate,
      displayState: pendingFinalization ? "finalizing candidate" : supervisorState?.displayState || supervisorGate.nextAction,
    },
    reciprocalCapabilities: { candidatePreviewArtifactLifecycle: artifactCapability },
    worktrees: { a, b },
    runtimes: { a: runtimeA, b: runtimeB },
    runtimeTopology: { ...runtimeTopology, health: topologyHealth },
    candidateUpdate,
    mainVersion,
    sourceReconciliationPending,
    pendingFinalization,
    models: { a: modelsA, b: modelsB },
    history,
    health,
    recovery: recoveryPlan(state, { a, b }),
  };
}

async function auditOrchestratorStatus(source = "dashboard-watchdog-status") {
  const state = await jsonFile(orchestratorStatePath, {});
  await audit("orchestrator.status", {
    source,
    ok: !state?._readError,
    phase: state?.phase || null,
    currentItem: state?.currentItem?.id || null,
    stableCommit: state?.stableCommit || null,
  });
  return state;
}

async function audit(action, detail = {}) {
  await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...detail, action })}\n`, "utf8");
}

async function recordUpdateReview(decision, comment, candidate) {
  await mkdir(path.dirname(updateReviewPath), { recursive: true });
  const safeComment = String(comment || "").trim();
  const lines = [
    `## ${new Date().toISOString()} - ${decision.toUpperCase()} ${candidate.shortSha || "unknown"}`,
    "",
    `- Candidate SHA: ${candidate.sourceSha || "unknown"}`,
    `- Built at: ${candidate.builtAt || "unknown"}`,
    `- Artifact: ${candidate.sourceDir || candidateSource}`,
    `- Preview home: ${candidate.preview?.home || candidateHome}`,
    `- Comment: ${safeComment || "(none)"}`,
    "",
  ];
  await appendFile(updateReviewPath, lines.join("\n"), "utf8");
  await persistUpdateReview(decision, safeComment, candidate);
  await audit("update.review", { decision, sourceSha: candidate.sourceSha || null, comment: safeComment || null });
}

async function ensureRejectedCandidateWishlist(candidate, comment) {
  const direction = parseDirection(await textFile(wishlistPath, ""));
  const sourceItem = reviewOriginItem(direction, candidate.sourceSha) || wishlistItemForReview(direction, candidate.sourceSha);
  const request = rejectedCandidateWishlist(candidate, sourceItem, comment);
  const existing = direction.items.find((item) => item.text.includes(request.marker));
  if (existing) return { id: existing.id, created: false, originItem: sourceItem, ...request };
  const output = await powershell(
    "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
    "-Action", "Add", "-Priority", request.priority, "-Text", request.text, "-ControlPath", controlPath,
  );
  const result = JSON.parse(output.replace(/^\uFEFF/, ""));
  return { id: result.id, created: true, originItem: sourceItem, ...request };
}

async function createArtifactWishlist(kind, text) {
  if (kind !== "candidate-preview") throw new Error(`Unsupported review artifact type: ${kind}`);
  const [runtimeA, runtimeB, producerRelay] = await Promise.all([getRuntime("A"), getRuntime("B"), getProducerRelayStatus()]);
  const capability = await getArtifactCapabilityStatus(runtimeA, runtimeB, producerRelay);
  if (!capability.compatible) {
    const error = new Error(capability.message);
    error.statusCode = 409;
    error.nonMutating = true;
    error.capability = capability;
    throw error;
  }
  const sourceSha = await git(repoRoot, "rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error("Trusted source repo did not return a full commit SHA.");
  const cleanText = String(text || `Build candidate preview for review ${shortSha(sourceSha)}`).replace(/\s+/g, " ").trim();
  if (!cleanText || cleanText.length > 1000) throw new Error("Artifact wishlist text must be between 1 and 1000 characters.");
  const output = await powershell(
    "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
    "-Action", "Add",
    "-Priority", "P0",
    "-Text", cleanText,
    "-ArtifactKind", kind,
    "-Commit", sourceSha,
    "-ControlPath", controlPath,
  );
  const result = JSON.parse(output.replace(/^\uFEFF/, ""));
  await audit("wishlist.artifactCreate", { id: result.id, kind, sourceSha, text: cleanText });
  return { id: result.id, kind, sourceSha, text: cleanText };
}

async function releaseRejectedCandidateGate(candidate, wishlist, comment) {
  const state = await jsonFile(statePath, {});
  const direction = parseDirection(await textFile(wishlistPath, ""));
  const originItem = reviewOriginItem(direction, candidate.sourceSha) || wishlist.originItem || null;
  const release = rejectedCandidateRelayAction(state, candidate.sourceSha, originItem);
  const summary = `Human rejected candidate ${candidate.shortSha || shortSha(candidate.sourceSha)}; no runtime promotion authorized. Queued ${wishlist.id}: ${String(comment).replace(/\s+/g, " ").trim()}`;
  let relay = { released: false, phase: state.phase || null, outcome: null };
  if (release) {
    const result = await relayControl(release.action, summary, {
      role: release.role,
      force: release.force,
      workspace: worktrees[release.workspace].path,
    });
    relay = { released: true, phase: result.phase || null, outcome: result.outcome || null };
  }
  const retirement = rejectedCandidateOriginRetirement(originItem, wishlist.id);
  if (retirement && originItem?.status === "IN_PROGRESS" && !relay.released) {
    throw new Error(`Rejected origin ${originItem.id} is still in progress and relay release was not safe.`);
  }
  if (retirement) {
    await powershell(
      "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
      "-Action", retirement.action,
      "-Id", retirement.id,
      "-Note", retirement.note,
      "-ControlPath", controlPath,
    );
    return { ...relay, retiredOrigin: retirement.id };
  }
  return { ...relay, retiredOrigin: null };
}

async function recordMainUpdate(comment, result) {
  await mkdir(path.dirname(mainUpdateReviewPath), { recursive: true });
  const lines = [
    `## ${result.timestamp} - ${result.tag}`,
    "",
    `- Master SHA: ${result.masterSha}`,
    `- Stable SHA integrated: ${result.stableSha}`,
    `- Relay turn: ${result.turn}`,
    `- Wishlist items: ${result.wishlistIds?.join(", ") || "none"}`,
    `- Merge mode: ${result.mergeMode}`,
    `- Remote push: ${result.pushed ? "master and tag pushed atomically" : "not pushed"}`,
    `- Branch reconciliation: ${result.branchesResynced ? "complete" : "incomplete"}`,
    `- Relay resumed: ${result.relayResumed ? "yes" : result.pausedByFlow ? "no" : "relay was already paused"}`,
    `- Comment: ${comment}`,
    "",
  ];
  await appendFile(mainUpdateReviewPath, lines.join("\n"), "utf8");
}

async function remoteMasterSha() {
  const value = await git(repoRoot, "ls-remote", "origin", "refs/heads/master").catch(() => "");
  return value.split(/\s+/)[0] || null;
}

async function backupToOrigin() {
  const attemptedRefs = [
    "refs/heads/codex/reciprocal-a:refs/heads/codex/reciprocal-a",
    "refs/heads/codex/reciprocal-b:refs/heads/codex/reciprocal-b",
    "refs/tandem-relay/stable:refs/tandem-relay/stable",
  ];
  const trackedEnv = await runResult("git", ["ls-files", "--error-unmatch", ".env"], repoRoot);
  if (trackedEnv.ok) throw new Error(".env is tracked; backup push is blocked.");
  const masterBefore = await remoteMasterSha();
  const branches = await runResult("git", ["push", "--porcelain", "origin", attemptedRefs[0], attemptedRefs[1]], repoRoot);
  let stable = { ok: false, code: null, output: "Skipped because branch backup failed." };
  if (branches.ok) {
    stable = await runResult("git", ["push", "--porcelain", "origin", attemptedRefs[2]], repoRoot);
  }
  const masterAfter = await remoteMasterSha();
  const result = {
    ok: branches.ok,
    attemptedRefs,
    branches: { ok: branches.ok, code: branches.code, output: branches.output },
    stable: { ok: stable.ok, code: stable.code, output: stable.output },
    masterBefore,
    masterAfter,
    masterUnchanged: masterBefore === masterAfter,
  };
  await audit("git.backup", result);
  if (!branches.ok) throw new Error(`Branch backup rejected without force: ${branches.output}`);
  if (!result.masterUnchanged) throw new Error("Backup safety violation: origin/master changed unexpectedly.");
  return result;
}

async function currentCandidateOrThrow(options = {}) {
  const [runtimeA, runtimeB, relayState] = await Promise.all([getRuntime("A"), getRuntime("B"), jsonFile(statePath, {})]);
  for (const runtime of [runtimeA, runtimeB]) {
    const sourceSha = runtime.buildInfo?.sourceSha || "";
    runtime.buildShortSha = shortSha(sourceSha) || runtime.buildInfo?.sourceShortSha || "unknown";
  }
  const candidate = await getCandidateUpdate(runtimeA, runtimeB, relayState, await getUpdateReviewIndex());
  if (!candidate.exists) throw new Error("No candidate build found at release/win-unpacked.");
  if (candidate.unknownProvenance) throw new Error("Candidate build has unknown provenance; rebuild with npm run dist:app first.");
  if (relayState.phase === "a-upgrade-pending" && relayState.stableCommit && candidate.sourceSha !== relayState.stableCommit) {
    throw new Error(`Candidate build ${candidate.shortSha || "unknown"} does not match accepted stable ${shortSha(relayState.stableCommit)}; rebuild the preview before launch or review.`);
  }
  if (candidate.reviewed) {
    if (options.allowReviewed) return { candidate, runtimeA, runtimeB };
    throw new Error(`Candidate ${candidate.shortSha} was already reviewed as ${candidate.reviewed.decision}.`);
  }
  if (!candidate.pending) throw new Error("No pending update to review.");
  return { candidate, runtimeA, runtimeB };
}

function approvalSnapshot() {
  if (!approvalFlow) return { active: false };
  const { cancelRequested, forceRequested, ...visible } = approvalFlow;
  return { active: ["running", "waiting"].includes(visible.status), ...visible };
}

async function relayControl(action, summary, options = {}) {
  const workspace = typeof options.workspace === "string" && worktrees[options.workspace]
    ? worktrees[options.workspace].path
    : options.workspace;
  const args = [
    "-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"),
    "-Action", action,
    "-Summary", summary,
    "-Workspace", workspace || worktrees.b.path,
  ];
  if (options.role) args.push("-Role", options.role);
  if (options.force) args.push("-Force");
  const output = await powershell(...args);
  return JSON.parse(output.replace(/^\uFEFF/, ""));
}

async function approvalStep(flow, step, detail) {
  const entry = { step, ok: true, detail, at: new Date().toISOString() };
  flow.current = step;
  flow.steps.push(entry);
  await saveRuntimeRecoveryJournal(flow, flow.durableStage, { [`step:${step}`]: entry });
  await audit("update.approvalStep", { id: flow.id, ...entry });
  if (testHarness && process.env.TANDEM_DASHBOARD_TEST_CRASH_AFTER_STEP === step) {
    serverLog("test.crashAfterStep", step);
    process.exit(87);
  }
}

async function resumeApprovalPause(flow, summary) {
  if (!flow.pausedByFlow || flow.relayResumed) return;
  const completion = approvalCompletionRelayAction(flow.interruptedPhase);
  const resumed = await relayControl(completion.action, summary, {
    role: completion.role,
    force: completion.force,
    workspace: completion.workspace,
  });
  flow.relayResumed = true;
  await approvalStep(flow, completion.step, `Relay ${resumed.outcome.toLowerCase()}; phase=${resumed.phase}.`);
}

async function waitForApprovalBoundary(flow) {
  let initial = await jsonFile(statePath, {});
  flow.interruptedRole = initial.activeRole || null;
  flow.interruptedPhase = initial.phase || null;
  const boundaryPlan = approvalBoundaryPlan(initial);
  if (boundaryPlan) {
    flow.interruptedPhase = boundaryPlan.interruptedPhase;
    flow.pausedByFlow = boundaryPlan.pausedByFlow;
    await approvalStep(flow, boundaryPlan.step, boundaryPlan.detail);
    return { forced: boundaryPlan.forced };
  }
  if (initial.phase === "paused" && !initial.activeRole) {
    await approvalStep(flow, "boundary", "Relay was already paused; this flow will leave it paused.");
    return { forced: false };
  }
  if (initial.phase === "paused" && initial.activeRole) {
    const resumed = await relayControl("Resume", `Runtime approval ${flow.id}: migrate legacy paused active turn to drain pause`);
    await approvalStep(flow, "legacy-active-resumed", `Restored ${resumed.phase} for owner ${resumed.activeRole} so the active turn can finish normally.`);
    initial = await jsonFile(statePath, {});
  }

  const pause = await relayControl("Pause", `Runtime approval ${flow.id}: hold new reciprocal turns`);
  flow.pausedByFlow = true;
  await approvalStep(flow, pause.outcome === "PAUSE_REQUESTED" ? "pause-requested" : "relay-paused",
    pause.outcome === "PAUSE_REQUESTED"
      ? `Active ${pause.phase} turn owned by ${pause.activeRole}; waiting for its safe checkpoint boundary.`
      : `Relay paused from ${pause.pausedFromPhase || "idle"}.`);

  if (pause.outcome !== "PAUSE_REQUESTED") return { forced: false };
  flow.status = "waiting";
  flow.waitingSince = new Date().toISOString();
  const deadline = Date.now() + approvalWaitTimeoutMs;
  while (Date.now() < deadline) {
    if (flow.cancelRequested) {
      await resumeApprovalPause(flow, `Cancelled runtime approval ${flow.id}; allow reciprocal work to continue`);
      const error = new Error("Approval wait cancelled by the human; no executors were stopped and no runtime was promoted.");
      error.code = "APPROVAL_CANCELLED";
      throw error;
    }
    if (flow.forceRequested) {
      await approvalStep(flow, "boundary-override", "Human explicitly chose checkpoint stop while the turn is active.");
      flow.status = "running";
      return { forced: true };
    }
    const current = await jsonFile(statePath, {});
    if (current.phase === "paused" && !current.activeRole) {
      await approvalStep(flow, "boundary", `Active turn finished; relay is paused at turn ${current.turn}.`);
      flow.status = "running";
      return { forced: false };
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the active turn after ${Math.round(approvalWaitTimeoutMs / 60000)} minutes; executors were not stopped.`);
}

function approvalRemaining(flow) {
  return approvalRemainingActions(flow);
}

async function runApprovalFlow(comment, candidate) {
  const flow = approvalFlow;
  try {
    if (!durableStageReached(flow, "package-ready")) {
      const candidateProof = await verifyCandidatePackage(candidate);
      const candidateBuild = candidateProof.buildInfo;
      flow.packageIdentity = candidateProof.packageIdentity;
      flow.immutablePackagePath = candidateProof.immutablePackagePath;
      flow.previousStableA = (await jsonFile(path.join(relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"), {}))?.sourceSha || null;
      await saveRuntimeRecoveryJournal(flow, "package-ready", { package: candidateProof, candidateBuild });
    }

    if (!durableStageReached(flow, "b-verified")) {
      await prepareRecoveryAuthority(flow, candidate);
    }

    if (!durableStageReached(flow, "approval-recorded")) {
      const reviews = await getUpdateReviewIndex();
      if (candidate.reviewed?.decision === "approve" || reviews[candidate.sourceSha]?.decision === "approve") {
        flow.durableStage = "approval-recorded";
        await approvalStep(flow, "review-recorded", `Approved candidate ${candidate.shortSha}; review was already recorded, continuing idempotent recovery.`);
      } else {
        await recordUpdateReview("approve", comment, candidate);
        flow.durableStage = "approval-recorded";
        await approvalStep(flow, "review-recorded", `Approved candidate ${candidate.shortSha}.`);
      }
    }

    if (!flow.interruptedPhase || !durableStageReached(flow, "a-stop-started")) {
      const boundary = await waitForApprovalBoundary(flow);
      flow.forcedBoundary = boundary.forced;
    }

    if (!durableStageReached(flow, "a-stopped")) {
      await saveRuntimeRecoveryJournal(flow, "a-stop-started");
      const stopOutput = await powershell("-File", path.join(here, "stop-reciprocal-tandem.ps1"), "-Role", "A", "-RelayRoot", relayRoot);
      flow.executorsStopped = true;
      flow.durableStage = "a-stopped";
      await approvalStep(flow, "executor-a-stopped", stopOutput || "Executor A stopped; verified B remains the recovery authority.");
    }

    if (!durableStageReached(flow, "a-promoted")) {
      await verifyRecoveryAuthority(candidate);
      await saveRuntimeRecoveryJournal(flow, "a-promote-started");
      const promoteOutput = await powershell("-File", path.join(repoRoot, "scripts", "promote-reciprocal-runtime.ps1"), "-RelayRoot", relayRoot, "-Source", packageSourceForFlow(flow), "-SourceSha", candidate.sourceSha, "-TargetRole", "A", "-BuildRound", "D184", "-PromotedRound", "D184");
      flow.promoted = true;
      const [buildA, buildB, listing] = await Promise.all([
        jsonFile(path.join(relayRoot, "runtimes", "executor-a", "BUILD_INFO.json"), {}),
        jsonFile(path.join(relayRoot, "runtimes", "executor-b", "BUILD_INFO.json"), {}),
        powershell("-Command", `$root='${relayRoot.replaceAll("'", "''")}'; Get-ChildItem (Join-Path $root 'runtimes\\executor-a') -Filter Tandem.exe | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json -Compress`),
      ]);
      flow.proof = { buildA, buildB, listing };
      if (buildA.sourceSha !== candidate.sourceSha) throw new Error(`Executor A runtime BUILD_INFO mismatch: A=${shortSha(buildA.sourceSha)}, candidate=${candidate.shortSha}.`);
      flow.durableStage = "a-promoted";
      await approvalStep(flow, "runtime-a-promoted", `${promoteOutput} BUILD_INFO A=${shortSha(buildA.sourceSha)}; verified B source remains ${shortSha(buildB.sourceSha)}. ${listing}`);
    }

    if (!durableStageReached(flow, "a-started")) {
      await saveRuntimeRecoveryJournal(flow, "a-start-started");
      const startOutput = await powershell("-File", path.join(repoRoot, "scripts", "start-reciprocal-tandem.ps1"), "-Role", "A", "-RelayRoot", relayRoot);
      flow.durableStage = "a-started";
      await saveRuntimeRecoveryJournal(flow, "a-started", { startAOutput: startOutput });
    }
    if (!durableStageReached(flow, "a-verified")) {
      const statusA = await waitForAutomation("A");
      await verifyRuntimeEndpoint("A", candidate);
      flow.executorsRestarted = true;
      flow.durableStage = "a-verified";
      await approvalStep(flow, "executor-a-restarted", `Hidden endpoint ready: A PID ${statusA.pid}.`);
    }

    if (flow.forcedBoundary && flow.interruptedRole) {
      const role = flow.interruptedRole;
      const resumedPrompt = await automationRequest(role, "/prompt", "POST", {
        projectDir: automation[role].projectDir,
        prompt: "Resume the interrupted reciprocal turn from its durable checkpoint. Follow TANDEM.md and the relay protocol; do not start a different turn.",
      });
      await approvalStep(flow, "checkpoint-resume-injected", `Executor ${role} accepted checkpoint resume for ${resumedPrompt.projectDir}.`);
    }

    if (!durableStageReached(flow, "relay-completed")) {
      await resumeApprovalPause(flow, `Completed runtime approval ${flow.id}; Executor A restarted from verified candidate`);
      flow.durableStage = "relay-completed";
      await saveRuntimeRecoveryJournal(flow, "relay-completed");
    }
    if (!durableStageReached(flow, "b-stopped")) {
      await saveRuntimeRecoveryJournal(flow, "b-stop-started");
      const stopBOutput = await powershell("-File", path.join(here, "stop-reciprocal-tandem.ps1"), "-Role", "B", "-RelayRoot", relayRoot);
      flow.durableStage = "b-stopped";
      await approvalStep(flow, "recovery-authority-stopped", stopBOutput || "Executor B stopped after A returned healthy.");
    }
    flow.status = "completed";
    flow.current = "complete";
    flow.completedAt = new Date().toISOString();
    flow.remaining = [];
    await saveRuntimeRecoveryJournal(flow, "b-stopped");
    await audit("update.approvePromote", { ok: true, ...approvalSnapshot(), sourceSha: candidate.sourceSha });
    return approvalSnapshot();
  } catch (error) {
    flow.status = error.code === "APPROVAL_CANCELLED" ? "cancelled" : "failed";
    flow.remaining = error.code === "APPROVAL_CANCELLED" ? [] : approvalRemaining(flow);
    flow.error = error.code === "APPROVAL_CANCELLED" ? error.message : approvalFailureDetail(flow, error.message);
    flow.completedAt = new Date().toISOString();
    await saveRuntimeRecoveryJournal(flow, flow.durableStage);
    await audit("update.approvePromote", { ok: false, ...approvalSnapshot(), sourceSha: candidate.sourceSha });
    throw error;
  }
}

async function prepareRecoveryAuthority(flow, candidate) {
  if (!durableStageReached(flow, "b-promoted")) {
    flow.recoveryStage = "b-runtime-promote";
    await saveRuntimeRecoveryJournal(flow, "b-promote-started");
    const promoteBOutput = await powershell("-File", path.join(repoRoot, "scripts", "promote-reciprocal-runtime.ps1"), "-RelayRoot", relayRoot, "-Source", packageSourceForFlow(flow), "-SourceSha", candidate.sourceSha, "-TargetRole", "B", "-BuildRound", "D184", "-PromotedRound", "D184");
    const buildB = await jsonFile(path.join(relayRoot, "runtimes", "executor-b", "BUILD_INFO.json"), {});
    if (buildB.sourceSha !== candidate.sourceSha) throw new Error(`Executor B recovery runtime BUILD_INFO mismatch: B=${shortSha(buildB.sourceSha)}, candidate=${candidate.shortSha}.`);
    if (buildB.packageIdentity !== flow.packageIdentity) throw new Error("Executor B recovery runtime package identity mismatch.");
    if (capabilityVersion(buildB, "candidatePreviewArtifactLifecycle") < requiredReciprocalCapabilities.candidatePreviewArtifactLifecycle) {
      throw new Error("Executor B recovery runtime lacks candidatePreviewArtifactLifecycle capability.");
    }
    flow.durableStage = "b-promoted";
    await approvalStep(flow, "recovery-authority-promoted", `${promoteBOutput} BUILD_INFO B=${shortSha(buildB.sourceSha)}.`);
  }

  if (!durableStageReached(flow, "b-verified")) {
    flow.recoveryStage = "b-runtime-start";
    await saveRuntimeRecoveryJournal(flow, "b-start-started");
    const startBOutput = await powershell("-File", path.join(repoRoot, "scripts", "start-reciprocal-tandem.ps1"), "-Role", "B", "-RelayRoot", relayRoot);
    flow.durableStage = "b-started";
    await saveRuntimeRecoveryJournal(flow, "b-started", { startBOutput });
    const statusB = await waitForAutomation("B");
    const proof = await verifyRuntimeEndpoint("B", candidate);
    flow.recoveryAuthorityReady = true;
    flow.recoveryStage = "b-runtime-verified";
    flow.durableStage = "b-verified";
    await approvalStep(flow, "recovery-authority-ready", `${startBOutput} B PID ${statusB.pid || proof.endpoint.pid || "ready"} targets ${proof.target}; source ${candidate.shortSha}.`);
  }
}

async function verifyRuntimeEndpoint(role, candidate) {
  const runtimeDir = path.join(relayRoot, "runtimes", `executor-${role.toLowerCase()}`);
  const integrity = await packageIntegrityPromise;
  const proof = await integrity.verifyPackage(runtimeDir, { sourceSha: candidate.sourceSha });
  const build = proof.buildInfo;
  if (build.sourceSha !== candidate.sourceSha) throw new Error(`Executor ${role} runtime BUILD_INFO mismatch: ${shortSha(build.sourceSha)} != ${candidate.shortSha}.`);
  const expectedPackage = approvalFlow?.packageIdentity || (await loadRuntimeRecoveryJournal())?.packageIdentity || build.packageIdentity;
  if (!expectedPackage) throw new Error(`Executor ${role} package identity is missing.`);
  if (proof.packageIdentity !== expectedPackage) throw new Error(`Executor ${role} runtime package identity mismatch.`);
  if (capabilityVersion(build, "candidatePreviewArtifactLifecycle") < requiredReciprocalCapabilities.candidatePreviewArtifactLifecycle) {
    throw new Error(`Executor ${role} runtime lacks candidatePreviewArtifactLifecycle capability.`);
  }
  const status = await waitForAutomation(role);
  const endpoint = await automationRequest(role, "/status");
  const credentials = await jsonFile(automation[role].tokenFile, {});
  const runtimeExe = path.join(runtimeDir, "Tandem.exe");
  if (!credentials.pid || !endpoint.pid || Number(credentials.pid) !== Number(endpoint.pid)) throw new Error(`Executor ${role} token PID and endpoint PID disagree.`);
  if (hasEndpointEcho(endpoint.tokenFile) && path.resolve(endpoint.tokenFile).toLowerCase() !== path.resolve(automation[role].tokenFile).toLowerCase()) throw new Error(`Executor ${role} endpoint token file mismatch.`);
  if (hasEndpointEcho(endpoint.port) && Number(endpoint.port) !== Number(credentials.port)) throw new Error(`Executor ${role} endpoint port mismatch.`);
  if (endpoint.instanceId !== role) throw new Error(`Executor ${role} endpoint instance mismatch: ${endpoint.instanceId || "missing"}.`);
  if (hasEndpointEcho(endpoint.sourceSha) && endpoint.sourceSha !== candidate.sourceSha) throw new Error(`Executor ${role} endpoint source mismatch: ${shortSha(endpoint.sourceSha)} != ${candidate.shortSha}.`);
  if (hasEndpointEcho(endpoint.packageIdentity) && endpoint.packageIdentity !== expectedPackage) throw new Error(`Executor ${role} endpoint package identity mismatch.`);
  if (capabilityVersion({ reciprocalCapabilities: endpoint.capabilities }, "candidatePreviewArtifactLifecycle") < requiredReciprocalCapabilities.candidatePreviewArtifactLifecycle) {
    throw new Error(`Executor ${role} endpoint capability mismatch.`);
  }
  const processInfo = testHarness ? { Id: endpoint.pid || credentials.pid, Path: runtimeExe } : await getProcessByPath(runtimeExe);
  if (!processInfo || Number(processInfo.Id) !== Number(endpoint.pid || credentials.pid)) throw new Error(`Executor ${role} process identity mismatch for ${runtimeExe}.`);
  const target = path.resolve(endpoint.allowedProjectDir || endpoint.projectDir || status.allowedProjectDir || "");
  const expectedTarget = path.resolve(automation[role].projectDir);
  if (target !== expectedTarget) throw new Error(`Executor ${role} endpoint target mismatch: ${target} != ${expectedTarget}.`);
  return { build, status, endpoint, target, process: processInfo, packageIdentity: expectedPackage, manifest: proof.manifest };
}

async function verifyRecoveryAuthority(candidate) {
  const proof = await verifyRuntimeEndpoint("B", candidate);
  if (!proof.endpoint && !proof.status) {
    throw new Error("Executor B recovery endpoint is not available.");
  }
  return proof;
}

async function reviveApprovalFlow(candidate) {
  const journal = await loadRuntimeRecoveryJournal();
  const revived = flowFromRuntimeRecoveryJournal(journal, candidate);
  if (!revived) return null;
  const reviews = await getUpdateReviewIndex();
  if (durableStageReached(revived, "approval-recorded") && reviews[candidate.sourceSha]?.decision !== "approve") {
    throw new Error(`Durable recovery journal says approval was recorded for ${candidate.shortSha}, but the review index does not contain a matching approval.`);
  }
  if (durableStageReached(revived, "b-verified")) {
    await verifyRecoveryAuthority(candidate);
  }
  if (durableStageReached(revived, "a-verified")) {
    await verifyRuntimeEndpoint("A", candidate);
  }
  return revived;
}

async function recoverAlreadyPromotedAUpgrade(comment, sourceSha) {
  if (approvalFlow && ["running", "waiting"].includes(approvalFlow.status)) throw new Error("A runtime approval is already in progress.");
  try {
    const [state, runtimeA, runtimeB, reviews] = await Promise.all([
      jsonFile(statePath, {}),
      getRuntime("A"),
      getRuntime("B"),
      getUpdateReviewIndex(),
    ]);
    const approvedSha = String(sourceSha || state.stableCommit || "").trim();
    const recovery = validateAlreadyPromotedAUpgradeRecovery({
      state,
      sourceSha: approvedSha,
      review: reviews[approvedSha],
      buildA: runtimeA.buildInfo || {},
      buildB: runtimeB.buildInfo || {},
    });
    approvalFlow = {
      id: `approval-recovery-${Date.now()}`,
      status: "running",
      current: "recovery-proof",
      sourceSha: approvedSha,
      startedAt: new Date().toISOString(),
      steps: [],
      pausedByFlow: true,
      relayResumed: false,
      executorsStopped: true,
      promoted: true,
      executorsRestarted: true,
      interruptedPhase: state.pausedFromPhase,
      interruptedRole: null,
      packageIdentity: runtimeA.buildInfo?.packageIdentity || runtimeB.buildInfo?.packageIdentity || null,
      immutablePackagePath: runtimeA.buildInfo?.immutablePackagePath || runtimeB.buildInfo?.immutablePackagePath || null,
      previousStableA: runtimeA.buildInfo?.sourceSha || null,
      durableStage: "a-verified",
      cancelRequested: false,
      forceRequested: false,
      recoveryOnly: true,
    };
    const detail = [
      `Already promoted; relay gate recovery only for ${shortSha(approvedSha)}.`,
      `Runtime proof A=${shortSha(runtimeA.buildInfo?.sourceSha)}, B=${shortSha(runtimeB.buildInfo?.sourceSha)}.`,
      String(comment || "").replace(/\s+/g, " ").trim(),
    ].filter(Boolean).join(" ");
    await approvalStep(approvalFlow, "recovery-proof", detail);
    const result = await relayControl(recovery.action, `Recovered already-promoted A-upgrade gate ${shortSha(approvedSha)}; no runtime copy performed`, {
      role: recovery.role,
      force: recovery.force,
      workspace: recovery.workspace,
    });
    approvalFlow.relayResumed = true;
    await approvalStep(approvalFlow, recovery.step, `Relay ${result.outcome.toLowerCase()}; phase=${result.phase}.`);
    approvalFlow.status = "completed";
    approvalFlow.current = "complete";
    approvalFlow.completedAt = new Date().toISOString();
    approvalFlow.remaining = [];
    await audit("update.approvePromoteRecovery", {
      ok: true,
      sourceSha: approvedSha,
      mode: "already-promoted-relay-gate-recovered",
      relayPhase: result.phase || null,
      outcome: result.outcome || null,
    });
    return approvalSnapshot();
  } catch (error) {
    if (approvalFlow) {
      approvalFlow.status = "failed";
      approvalFlow.error = approvalFailureDetail(approvalFlow, error.message);
      approvalFlow.remaining = approvalRemaining(approvalFlow);
      approvalFlow.completedAt = new Date().toISOString();
      await audit("update.approvePromoteRecovery", { ok: false, ...approvalSnapshot() });
    }
    throw error;
  }
}

async function auditLog() {
  const raw = await textFile(auditPath);
  return raw.split(/\r?\n/).filter(Boolean).slice(-100).reverse().flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(response, status, payload, type = "application/json; charset=utf-8") {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    response.end(type.startsWith("application/json") ? JSON.stringify(payload) : payload);
    return true;
  } catch (error) {
    serverLog("response.write.error", errorText(error));
    response.destroy();
    return false;
  }
}

function sanitizedRelayState(state) {
  const authorityRequest = state?.authorityRequest
    ? Object.fromEntries(Object.entries(state.authorityRequest).filter(([key]) => !["decisionProof", "decisionSecret", "signature"].includes(key)))
    : null;
  return { ...state, authorityRequest };
}

async function serveFile(response, name, type) {
  const value = await readFile(path.join(here, "public", name), "utf8");
  send(response, 200, name === "index.html" ? value.replace("__CONTROL_TOKEN__", token) : value, type);
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (request.method === "GET" && url.pathname === "/") return serveFile(response, "index.html", "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/styles.css") return serveFile(response, "styles.css", "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/update-gate.css") return serveFile(response, "update-gate.css", "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/mobile.css") return serveFile(response, "mobile.css", "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/app.js") return serveFile(response, "app.js", "text/javascript; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/revision") return send(response, 200, await currentRevision());
    if (request.method === "GET" && url.pathname === "/api/status") return send(response, 200, await getStatus());
    if (request.method === "GET" && url.pathname === "/api/audit") return send(response, 200, await auditLog());
    if (request.method === "GET" && url.pathname === "/api/update/approve/status") return send(response, 200, { ok: true, flow: approvalSnapshot() });

    if (request.method !== "POST") return send(response, 404, { error: "Not found" });
    if (request.headers["x-control-token"] !== token) return send(response, 403, { error: "Invalid control token" });
    const input = await body(request);
    const d196AllowedMutations = new Set([
      "/api/wishlist/requeue",
      "/api/update/reject",
      "/api/relay/pause",
      "/api/quit",
    ]);
    if (!d196AllowedMutations.has(url.pathname)) {
      return send(response, 410, {
        ok: false,
        error: "D196 replaced dashboard mutation paths with the single reciprocal orchestrator.",
        orchestrator: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-orchestrator.ps1",
        allowedMutations: Array.from(d196AllowedMutations).sort(),
      });
    }

    if (url.pathname === "/api/wishlist") {
      const text = String(input.text || "").replace(/\s+/g, " ").trim();
      const priority = ["P0", "P1", "P2", "P3"].includes(input.priority) ? input.priority : "P1";
      const epic = input.epic === true;
      const autonomy = epic && input.autonomy === "full" ? "full" : "inherit";
      if (input.artifactKind || input.sourceSha || input.reciprocalArtifact) throw new Error("Use /api/wishlist/artifact for review artifact work.");
      if (!text || text.length > 1000) throw new Error("Wishlist text must be between 1 and 1000 characters");
      const output = await powershell("-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"), "-Action", "Add", "-Priority", priority, "-Text", text, ...(epic ? ["-Epic", "-Autonomy", autonomy] : []), "-ControlPath", controlPath);
      await audit("wishlist.add", { priority, text, epic, autonomy });
      return send(response, 201, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/wishlist/artifact") {
      const kind = String(input.kind || "candidate-preview").trim();
      const text = String(input.text || "").replace(/\s+/g, " ").trim();
      const result = await createArtifactWishlist(kind, text);
      return send(response, 201, { ok: true, result });
    }

    if (url.pathname === "/api/authority/declare") {
      const id = String(input.id || "").trim().toUpperCase();
      const role = String(input.role || "").trim().toUpperCase();
      const kind = String(input.kind || "").trim();
      const action = String(input.action || "").trim();
      const checkpoint = String(input.checkpoint || "").trim();
      const resume = String(input.resume || "").trim();
      if (!/^W\d{4}$/.test(id)) throw new Error("Authority declaration requires a valid wishlist item ID");
      if (!["A", "B"].includes(role)) throw new Error("Authority declaration requires owner role A or B");
      if (!["credentials", "authentication", "pairing", "permission", "sandbox", "destructive", "payment", "publication", "runtime"].includes(kind)) throw new Error("Unsupported authority kind");
      for (const [label, value] of Object.entries({ action, checkpoint, resume })) {
        if (!/^[A-Za-z0-9._:-]{2,128}$/.test(value)) throw new Error(`Authority ${label} must be exact machine-readable metadata`);
      }
      const output = await powershell(
        "-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"),
        "-Action", "DeclareAuthority", "-Role", role, "-Id", id, "-AuthKind", kind, "-AuthVerb", action, "-Checkpoint", checkpoint, "-ResumeToken", resume, "-Workspace", worktrees.b.path,
      );
      await audit("authority.declare", { id, role, kind, action, checkpoint, resume });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/authority/approve" || url.pathname === "/api/authority/deny") {
      const decision = url.pathname.endsWith("/approve") ? "approve" : "deny";
      const currentState = await jsonFile(statePath, {});
      const request = currentState.authorityRequest;
      if (!request) throw new Error("No relay authority request is pending");
      if (decision === "approve" && (request.status === "consumed" || request.status === "approved")) {
        return send(response, 200, { ok: true, decision, noop: true, request: sanitizedRelayState(currentState).authorityRequest });
      }
      if (decision === "deny" && request.status === "denied") {
        return send(response, 200, { ok: true, decision, noop: true, request: sanitizedRelayState(currentState).authorityRequest });
      }
      if (request.status !== "pending") throw new Error(`Authority request is not pending; status=${request.status}`);
      const note = String(input.note || "").replace(/\s+/g, " ").trim();
      if (decision === "deny" && (!note || note.length > 500)) throw new Error("Authority denial requires a note between 1 and 500 characters");
      const packet = signedAuthorityDecisionPacket(request, decision);
      const output = await powershellWithEnv(
        { ...process.env, TANDEM_AUTHORITY_DECISION_SECRET: authorityDecisionSecret, TANDEM_AUTHORITY_DECISION_PACKET: JSON.stringify(packet) },
        "-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"),
        "-Action", decision === "approve" ? "ApproveAuthority" : "DenyAuthority",
        ...(decision === "deny" ? ["-Summary", note] : []),
        "-Workspace", worktrees.b.path,
      );
      await audit(`authority.${decision}`, { id: request.id, role: request.owner, kind: request.authority, action: request.action, checkpoint: request.checkpoint, resume: request.resume, note: note || null });
      return send(response, 200, { ok: true, decision, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/wishlist/requeue") {
      const id = String(input.id || "").trim().toUpperCase();
      const note = String(input.note || "").replace(/\s+/g, " ").trim();
      if (!/^W\d{4}$/.test(id)) throw new Error("Requeue requires a valid wishlist item ID");
      if (!note || note.length > 500) throw new Error("Requeue reason must be between 1 and 500 characters");
      const output = await powershell(
        "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
        "-Action", "Requeue", "-Id", id, "-Note", note, "-ControlPath", controlPath,
      );
      await audit("wishlist.requeue", { id, note, retroactivePlanRejection: true });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/wishlist/remove") {
      const id = String(input.id || "").trim().toUpperCase();
      const note = String(input.note || "").replace(/\s+/g, " ").trim();
      if (!/^W\d{4}$/.test(id)) throw new Error("Remove requires a valid wishlist item ID");
      if (!note || note.length > 500) throw new Error("Removal reason must be between 1 and 500 characters");
      const output = await powershell(
        "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
        "-Action", "Remove", "-Id", id, "-Note", note, "-ControlPath", controlPath,
      );
      await audit("wishlist.remove", { id, note });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/wishlist/approve-plan") {
      const id = String(input.id || "").trim().toUpperCase();
      const note = String(input.note || "").replace(/\s+/g, " ").trim();
      if (!/^W\d{4}$/.test(id)) throw new Error("Plan approval requires a valid wishlist item ID");
      if (note.length > 500) throw new Error("Plan approval comment cannot exceed 500 characters");
      const [direction, relayState] = await Promise.all([textFile(wishlistPath), jsonFile(statePath, {})]);
      const item = parseDirection(direction).items.find((entry) => entry.id === id);
      const metadata = detailMetadata(item?.detail);
      if (!item || item.status !== "CANDIDATE" || metadata.epic !== "true" || metadata.candidate !== "PLAN") {
        throw new Error(`${id} is not an epic plan candidate`);
      }
      if (!metadata.commit || metadata.commit !== relayState.stableCommit) {
        throw new Error(`${id} plan candidate must be independently validated at relay stable before approval`);
      }
      const planExists = await runResult("git", ["cat-file", "-e", `${metadata.commit}:${metadata.plan}`], repoRoot);
      if (!planExists.ok) throw new Error(`${id} validated commit does not contain ${metadata.plan}`);
      const output = await powershell(
        "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
        "-Action", "ApprovePlan", "-Id", id, ...(note ? ["-Note", note] : []), "-ControlPath", controlPath,
      );
      await audit("wishlist.planApprove", { id, note: note || null, commit: metadata.commit, plan: metadata.plan });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/wishlist/reject-plan") {
      const id = String(input.id || "").trim().toUpperCase();
      const note = String(input.note || "").replace(/\s+/g, " ").trim();
      if (!/^W\d{4}$/.test(id)) throw new Error("Plan rejection requires a valid wishlist item ID");
      if (!note || note.length > 500) throw new Error("Plan rejection reason must be between 1 and 500 characters");
      const output = await powershell(
        "-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"),
        "-Action", "RejectPlan", "-Id", id, "-Note", note, "-ControlPath", controlPath,
      );
      await audit("wishlist.planReject", { id, note });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/direction") {
      const text = String(input.text || "").trim();
      if (!text || text.length > 4000) throw new Error("General Direction must be between 1 and 4000 characters");
      if (/^##\s/m.test(text)) throw new Error("General Direction cannot contain level-two Markdown headings");
      const output = await powershell("-File", path.join(repoRoot, "scripts", "reciprocal-direction.ps1"), "-Action", "UpdateDirection", "-Text", text, "-ControlPath", controlPath);
      await audit("direction.update", { text });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/models") {
      const role = ["A", "B"].includes(input.role) ? input.role : null;
      if (!role) throw new Error("Invalid executor role");
      const runtime = await getRuntime(role);
      if (runtime.running) throw new Error(`Stop Executor ${role} before changing its models`);
      const current = await getModelSettings(role, runtime);
      const ids = new Set(current.models.map((model) => model.id));
      const leaderSelection = parseModelSelection(String(input.leader || "").trim());
      const workerSelection = parseModelSelection(String(input.worker || "").trim());
      const leader = leaderSelection.id;
      const worker = workerSelection.id;
      if (!ids.has(leader) || !ids.has(worker)) throw new Error("Leader and worker must use registered model IDs");
      const selected = current.models.filter((model) => model.id === leader || model.id === worker);
      const unavailable = selected.filter((model) => !model.available);
      if (unavailable.length) throw new Error(`Model requirements are not available: ${unavailable.map((model) => model.id).join(", ")}`);
      const claudeVariants = [leaderSelection.claudeCliModel, workerSelection.claudeCliModel].filter((value) => value !== undefined);
      const codexEfforts = [leaderSelection.codexCliReasoningEffort, workerSelection.codexCliReasoningEffort].filter((value) => value !== undefined);
      if (new Set(claudeVariants).size > 1) throw new Error("Leader and worker share one Claude CLI model override within a copy");
      if (new Set(codexEfforts).size > 1) throw new Error("Leader and worker share one Codex reasoning effort within a copy");
      const codexCliModel = current.codexCliModel;
      const claudeCliModel = claudeVariants.length ? claudeVariants[0] : current.claudeCliModel;
      const codexEffort = codexEfforts.length ? codexEfforts[0] : current.codexCliReasoningEffort;
      const requiredCustom = current.defaultCustomModels.filter((model) => model.id === leader || model.id === worker);
      const output = await powershell(
        "-File", path.join(here, "update-model-config.ps1"),
        "-ConfigPath", current.configPath,
        "-Leader", leader,
        "-Worker", worker,
        "-CodexCliModel", codexCliModel,
        "-ClaudeCliModel", claudeCliModel,
        "-CodexEffort", codexEffort,
        "-EnsureCustomModelsJson", JSON.stringify(requiredCustom),
      );
      await audit("models.update", { role, leader, worker, codexCliModel: codexCliModel || null, claudeCliModel: claudeCliModel || null, codexCliReasoningEffort: codexEffort || null });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/executor/start") {
      const role = ["A", "B", "Both"].includes(input.role) ? input.role : null;
      if (!role) throw new Error("Invalid executor role");
      const output = await powershell("-File", path.join(repoRoot, "scripts", "start-reciprocal-tandem.ps1"), "-Role", role, "-RelayRoot", relayRoot);
      await audit("executor.start", { role });
      return send(response, 200, { ok: true, output });
    }

    if (url.pathname === "/api/update/launch-candidate") {
      if (!existsSync(candidateExe)) throw new Error("No candidate Tandem.exe found at release/win-unpacked.");
      await currentCandidateOrThrow();
      const existingProcesses = await getProcessesByPath(candidateExe);
      if (existingProcesses.length) throw new Error(`Candidate preview is already running as PID ${existingProcesses.map((item) => item.Id).join(", ")}.`);
      await Promise.all([mkdir(candidateHome, { recursive: true }), mkdir(candidateUserData, { recursive: true }), mkdir(candidateProject, { recursive: true })]);
      const child = spawn(candidateExe, [`--user-data-dir=${candidateUserData}`], {
        cwd: candidateProject,
        detached: true,
        windowsHide: false,
        env: {
          ...process.env,
          TANDEM_HOME: candidateHome,
          TANDEM_DESKTOP_LAST_PROJECT: candidateProject,
        },
      });
      child.unref();
      await audit("update.launchCandidate", { pid: child.pid, exe: candidateExe, home: candidateHome, userData: candidateUserData, project: candidateProject });
      return send(response, 200, { ok: true, pid: child.pid, exe: candidateExe, home: candidateHome, userData: candidateUserData, project: candidateProject });
    }

    if (url.pathname === "/api/update/stop-candidate") {
      const runningProcesses = await getProcessesByPath(candidateExe);
      if (!runningProcesses.length) throw new Error("Candidate preview is not running.");
      const pids = runningProcesses.map((item) => Number(item.Id)).filter(Number.isFinite);
      await powershell("-Command", `Stop-Process -Id ${pids.join(",")} -Force`);
      await audit("update.stopCandidate", { pids, exe: candidateExe });
      return send(response, 200, { ok: true, pids });
    }

    if (url.pathname === "/api/update/dismiss-review") {
      const comment = String(input.comment || "").replace(/\r\n/g, "\n").trim();
      const relayState = await jsonFile(statePath, {});
      if (relayState.phase !== "a-upgrade-pending" || !relayState.stableCommit) {
        throw new Error("No human-gated accepted stable SHA is waiting for review.");
      }
      const reviews = await getUpdateReviewIndex();
      if (reviews[relayState.stableCommit]) {
        return send(response, 200, { ok: true, decision: reviews[relayState.stableCommit].decision, sourceSha: relayState.stableCommit, alreadyReviewed: true });
      }
      const candidate = {
        sourceSha: relayState.stableCommit,
        shortSha: shortSha(relayState.stableCommit),
        builtAt: null,
        sourceDir: candidateSource,
        preview: { home: candidateHome },
      };
      await recordUpdateReview("dismiss", comment || "Reviewed from dashboard; no runtime promotion requested.", candidate);
      return send(response, 200, { ok: true, decision: "dismiss", sourceSha: relayState.stableCommit });
    }

    if (url.pathname === "/api/update/reject") {
      const comment = String(input.comment || "").replace(/\r\n/g, "\n").trim();
      if (!comment) throw new Error("Reject requires a comment so the next round knows what to fix.");
      const { candidate } = await currentCandidateOrThrow({ allowReviewed: true });
      if (candidate.reviewed) {
        if (candidate.reviewed.decision !== "reject") throw new Error(`Candidate ${candidate.shortSha} was already reviewed as ${candidate.reviewed.decision}.`);
        const direction = parseDirection(await textFile(wishlistPath, ""));
        const marker = `[review-rejection:${candidate.sourceSha}]`;
        const existing = direction.items.find((item) => item.text.includes(marker));
        if (!existing) throw new Error(`Candidate ${candidate.shortSha} was already rejected but its follow-up wishlist item is missing.`);
        await audit("update.rejectQueued", {
          sourceSha: candidate.sourceSha,
          wishlistId: existing.id,
          wishlistCreated: false,
          relayReleased: false,
          relayPhase: (await jsonFile(statePath, {})).phase || null,
          idempotent: true,
        });
        return send(response, 200, {
          ok: true,
          decision: "reject",
          sourceSha: candidate.sourceSha,
          wishlistId: existing.id,
          wishlistCreated: false,
          relayReleased: false,
          relayPhase: (await jsonFile(statePath, {})).phase || null,
          alreadyReviewed: true,
        });
      }
      const wishlist = await ensureRejectedCandidateWishlist(candidate, comment);
      const relay = await releaseRejectedCandidateGate(candidate, wishlist, comment);
      await recordUpdateReview("reject", comment, candidate);
      await audit("update.rejectQueued", {
        sourceSha: candidate.sourceSha,
        wishlistId: wishlist.id,
        wishlistCreated: wishlist.created,
        relayReleased: relay.released,
        relayPhase: relay.phase,
      });
      return send(response, 200, {
        ok: true,
        decision: "reject",
        sourceSha: candidate.sourceSha,
        wishlistId: wishlist.id,
        wishlistCreated: wishlist.created,
        relayReleased: relay.released,
        relayPhase: relay.phase,
      });
    }

    if (url.pathname === "/api/update/approve") {
      const comment = String(input.comment || "").replace(/\r\n/g, "\n").trim();
      if (approvalFlow && ["running", "waiting"].includes(approvalFlow.status)) throw new Error("A runtime approval is already in progress.");
      const { candidate } = await currentCandidateOrThrow({ allowReviewed: true });
      if (candidate.reviewed && candidate.reviewed.decision !== "approve") throw new Error(`Candidate ${candidate.shortSha} was already reviewed as ${candidate.reviewed.decision}.`);
      approvalFlow = await reviveApprovalFlow(candidate) || {
        id: `approval-${Date.now()}`,
        status: "running",
        current: "boundary-check",
        sourceSha: candidate.sourceSha,
        startedAt: new Date().toISOString(),
        steps: [],
        pausedByFlow: false,
        relayResumed: false,
        executorsStopped: false,
        promoted: false,
        executorsRestarted: false,
        cancelRequested: false,
        forceRequested: false,
      };
      const result = await runApprovalFlow(comment, candidate);
      return send(response, 200, { ok: true, decision: "approve", sourceSha: candidate.sourceSha, result, offerBackup: true });
    }

    if (url.pathname === "/api/update/approve/recover-a-upgrade") {
      const comment = String(input.comment || "Already promoted; recover relay gate only.").replace(/\r\n/g, "\n").trim();
      const sourceSha = String(input.sourceSha || "").trim();
      const result = await recoverAlreadyPromotedAUpgrade(comment, sourceSha);
      return send(response, 200, { ok: true, decision: "approve-recovery", sourceSha: result.sourceSha, result, offerBackup: true });
    }

    if (url.pathname === "/api/update/approve/cancel") {
      if (!approvalFlow || !["running", "waiting"].includes(approvalFlow.status)) throw new Error("No approval wait is active.");
      approvalFlow.cancelRequested = true;
      await audit("update.approvalCancelRequested", { id: approvalFlow.id });
      return send(response, 202, { ok: true, flow: approvalSnapshot() });
    }

    if (url.pathname === "/api/update/approve/override") {
      if (!approvalFlow || approvalFlow.status !== "waiting") throw new Error("No active-turn approval wait is available to override.");
      approvalFlow.forceRequested = true;
      await audit("update.approvalOverrideRequested", { id: approvalFlow.id, warning: "checkpoint stop explicitly authorized" });
      return send(response, 202, { ok: true, flow: approvalSnapshot() });
    }

    if (url.pathname === "/api/git/backup") {
      const result = await backupToOrigin();
      return send(response, 200, { ok: true, result });
    }

    if (url.pathname === "/api/main/update") {
      const comment = String(input.comment || "").replace(/\r\n/g, "\n").trim();
      if (!comment) throw new Error("Update main requires a human review comment.");
      if (input.confirmed !== true) throw new Error("Update main requires explicit confirmation.");
      const invocation = await runResult("node", [
        path.join(repoRoot, "scripts", "reciprocal-main-update.mjs"),
        "--repo", repoRoot,
        "--relay-root", relayRoot,
        "--comment", comment,
      ], repoRoot);
      let result;
      try {
        result = JSON.parse(invocation.ok ? invocation.stdout : invocation.stderr || invocation.stdout);
      } catch {
        result = { ok: false, stage: "unknown", error: invocation.output, remaining: [] };
      }
      if (!invocation.ok || !result.ok) {
        await audit("main.update", { ok: false, comment, ...result });
        const remaining = result.remaining?.length ? ` Remaining: ${result.remaining.join("; ")}.` : "";
        throw new Error(`Main update stopped during ${result.stage}: ${result.error || invocation.output}.${remaining}`);
      }
      await recordMainUpdate(comment, result);
      await audit("main.update", { ok: true, comment, ...result });
      return send(response, 200, { ok: true, result });
    }

    if (url.pathname === "/api/relay/pause") {
      const reason = String(input.reason || "").replace(/\s+/g, " ").trim();
      if (!reason) throw new Error("Pause requires a reason");
      const output = await powershell("-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"), "-Action", "Pause", "-Summary", reason, "-Workspace", worktrees.b.path);
      await audit("relay.pause", { reason });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/relay/resume") {
      const reason = String(input.reason || "").replace(/\s+/g, " ").trim();
      if (!reason) throw new Error("Resume requires a reason");
      const output = await powershell("-File", path.join(repoRoot, "scripts", "reciprocal-relay.ps1"), "-Action", "Resume", "-Summary", reason, "-Workspace", worktrees.b.path);
      await audit("relay.resume", { reason });
      return send(response, 200, { ok: true, result: JSON.parse(output) });
    }

    if (url.pathname === "/api/quit") {
      await audit("dashboard.quit", { reason: String(input.reason || "Human control panel action").slice(0, 300) });
      writeFileSync(stopSignalPath, `${new Date().toISOString()} human quit\n`, "utf8");
      serverLog("server.stop.requested", "human dashboard quit");
      send(response, 200, { ok: true, message: "Dashboard backend is shutting down." });
      setTimeout(() => server.close(() => process.exit(0)), 80);
      setTimeout(() => process.exit(0), 1500).unref();
      return;
    }

    if (url.pathname === "/api/executor/stop") {
      const role = ["A", "B", "Both"].includes(input.role) ? input.role : null;
      if (!role) throw new Error("Invalid executor role");
      const relayState = await jsonFile(statePath, {});
      const stopsActiveOwner = relayState.activeRole && (role === "Both" || role === relayState.activeRole) && activeRelayPhases.has(relayState.phase);
      if (stopsActiveOwner && input.confirmedActiveTurn !== true) {
        throw new Error(`Executor ${relayState.activeRole} owns an active ${relayState.phase} turn. Confirm checkpoint stop explicitly; it can resume after restart.`);
      }
      const output = await powershell("-File", path.join(here, "stop-reciprocal-tandem.ps1"), "-Role", role, "-RelayRoot", relayRoot);
      await audit("executor.stop", { role, activeTurnOverride: Boolean(stopsActiveOwner), reason: String(input.reason || "Human control panel action").slice(0, 300) });
      return send(response, 200, { ok: true, output });
    }

    return send(response, 404, { error: "Not found" });
  } catch (error) {
    if (!error.nonMutating) await audit("request.error", { path: url.pathname, message: error.message }).catch(() => {});
    return send(response, Number(error.statusCode) || 400, { error: error.message || "Request failed" });
  }
}

const server = createServer((request, response) => {
  Promise.resolve(handle(request, response)).catch(async (error) => {
    serverLog("request.unhandled", `${request.method || "UNKNOWN"} ${request.url || "/"} ${errorText(error)}`);
    await audit("request.unhandled", { path: request.url || "/", message: error?.message || String(error) }).catch(() => {});
    send(response, 500, { error: "Dashboard request failed unexpectedly; details were logged." });
  });
});
server.on("clientError", (error, socket) => {
  serverLog("client.error", errorText(error));
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", (error) => {
  serverLog("server.error", errorText(error));
  if (!server.listening && ["EADDRINUSE", "EACCES"].includes(error?.code)) {
    serverLog("server.fatal", `startup cannot continue code=${error.code}`);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }
});
server.on("close", () => {
  serverLog("server.stop", "http server closed");
});
process.on("exit", (code) => {
  serverLog("process.exit", `code=${code}`);
});
server.listen(port, "127.0.0.1", () => {
  serverLog("server.start", `url=http://127.0.0.1:${port}`);
  console.log(`Tandem Reciprocal Control Panel: http://127.0.0.1:${port}`);
  console.log(`Control root: ${relayRoot}`);
  if (!testHarness || process.env.TANDEM_DASHBOARD_ENABLE_TEST_ORCHESTRATOR_STATUS === "1") {
    const tickMs = Number(process.env.TANDEM_ORCHESTRATOR_STATUS_TICK_MS || process.env.TANDEM_SUPERVISOR_TICK_MS || 60_000);
    setTimeout(() => auditOrchestratorStatus("dashboard-startup").catch((error) => serverLog("orchestrator.status.startup.error", errorText(error))), 1_500).unref();
    setInterval(() => auditOrchestratorStatus("dashboard-watchdog-status").catch((error) => serverLog("orchestrator.status.tick.error", errorText(error))), Math.max(10_000, tickMs)).unref();
  }
  const fault = process.env.TANDEM_DASHBOARD_TEST_FAULT;
  if (fault === "unhandled-rejection") {
    setTimeout(() => Promise.reject(new Error("D128 injected unhandled rejection")), 40);
  } else if (fault === "uncaught-exception") {
    setTimeout(() => { throw new Error("D128 injected uncaught exception"); }, 40);
  }
});
