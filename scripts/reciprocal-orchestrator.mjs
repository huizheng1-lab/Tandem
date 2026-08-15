#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const utf8 = "utf8";
const maxStateBytes = 5 * 1024 * 1024;
const failureOutputBudget = 12000;

function boundedFailureOutput(text, budget = failureOutputBudget) {
  const value = String(text || "");
  if (Buffer.byteLength(value, utf8) <= budget) return value;
  const marker = `\n\n... output truncated; preserving head and tail within ${budget} bytes ...\n\n`;
  const markerBytes = Buffer.byteLength(marker, utf8);
  const headBudget = Math.min(2000, Math.floor((budget - markerBytes) / 3));
  const tailBudget = Math.max(0, budget - markerBytes - headBudget);
  let head = value.slice(0, headBudget);
  while (Buffer.byteLength(head, utf8) > headBudget && head.length > 0) head = head.slice(0, -1);
  let start = Math.max(0, value.length - tailBudget);
  let tail = value.slice(start);
  while (Buffer.byteLength(tail, utf8) > tailBudget && start < value.length) {
    start += 1;
    tail = value.slice(start);
  }
  return `${head}${marker}${tail}`;
}

function arg(name, fallback = "") {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${flag}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name) {
  return process.argv.includes(`--${name}`);
}

function now() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  retryFsSync(`mkdir:${dir}`, () => mkdirSync(dir, { recursive: true }));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function transientFsFailures() {
  if (!process.env.TANDEM_ORCHESTRATOR_TEST_TRANSIENT_FS_FAILURES) return null;
  try {
    return JSON.parse(process.env.TANDEM_ORCHESTRATOR_TEST_TRANSIENT_FS_FAILURES);
  } catch {
    return null;
  }
}

const injectedTransientFsFailures = transientFsFailures();

function maybeInjectTransientFsFailure(label) {
  if (!injectedTransientFsFailures || typeof injectedTransientFsFailures !== "object") return;
  const remaining = Number(injectedTransientFsFailures[label] || 0);
  if (remaining <= 0) return;
  injectedTransientFsFailures[label] = remaining - 1;
  const error = new Error(`Injected transient filesystem failure for ${label}`);
  error.code = process.env.TANDEM_ORCHESTRATOR_TEST_TRANSIENT_FS_CODE || "EBUSY";
  throw error;
}

function isTransientFsError(error) {
  return ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(error?.code || "").toUpperCase());
}

function retryFsSync(label, operation, attempts = 6) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      maybeInjectTransientFsFailure(label);
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === attempts) throw error;
      sleep(attempt * 50);
    }
  }
  throw lastError;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInvocationLock(relayRoot, logPath, state) {
  const lockDir = path.join(relayRoot, "state", "orchestrator.lock");
  ensureDir(path.dirname(lockDir));
  for (;;) {
    try {
      retryFsSync(`lock.mkdir:${lockDir}`, () => mkdirSync(lockDir));
      writeJsonAtomic(path.join(lockDir, "owner.json"), { pid: process.pid, startedAt: now(), argv: process.argv.slice(2) });
      return () => retryFsSync(`lock.release:${lockDir}`, () => rmSync(lockDir, { recursive: true, force: true }));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readJson(path.join(lockDir, "owner.json"), {});
      if (processAlive(owner?.pid)) {
        appendLog(logPath, { action: "invocation.locked", phase: state.phase, item: state.currentItem?.id || null, step: state.step || null, ownerPid: owner.pid });
        return null;
      }
      retryFsSync(`lock.remove-stale:${lockDir}`, () => rmSync(lockDir, { recursive: true, force: true }));
    }
  }
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return retryFsSync(`json.read:${file}`, () => {
    const size = statSync(file).size;
    if (size > maxStateBytes) throw new Error(`Refusing to read oversized JSON file ${file} (${size} bytes).`);
    return JSON.parse(readFileSync(file, utf8));
  });
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, utf8);
  if (bytes > maxStateBytes) throw new Error(`Refusing to write oversized JSON file ${file} (${bytes} bytes).`);
  const temp = `${file}.${process.pid}.tmp`;
  retryFsSync(`json.write:${file}`, () => writeFileSync(temp, body, utf8));
  retryFsSync(`json.rename:${file}`, () => renameSync(temp, file));
}

function appendLog(file, entry) {
  ensureDir(path.dirname(file));
  retryFsSync(`log.append:${file}`, () => appendFileSync(file, `${JSON.stringify({ at: now(), ...entry })}\n`, utf8));
}

function runCommand(command, cwd) {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", windowsHide: true });
  return {
    command,
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
    ok: (result.status ?? 1) === 0,
  };
}

function isCommitAncestor(repo, maybeSha) {
  if (!/^[0-9a-f]{40}$/i.test(String(maybeSha || ""))) return true;
  return runCommand(`git merge-base --is-ancestor ${maybeSha} HEAD`, repo).ok;
}

function resumeFailureHistoryDecision(repo, state, discardFailures) {
  const failures = Array.isArray(state.failures) ? state.failures : [];
  if (failures.length === 0) return { preserve: true, failures, count: 0, reason: "empty-history" };
  if (discardFailures) return { preserve: false, failures: [], count: failures.length, reason: "discard-failures-requested" };
  const currentItemId = state.currentItem?.id || null;
  if (!currentItemId) return { preserve: false, failures: [], count: failures.length, reason: "no-current-item" };
  const mismatchedFailure = failures.find((failure) => failure?.item && failure.item !== currentItemId);
  if (mismatchedFailure) return { preserve: false, failures: [], count: failures.length, reason: `failure-item-mismatch:${mismatchedFailure.item}` };
  const staleFailure = failures.find((failure) => failure?.attemptCommit && !isCommitAncestor(repo, failure.attemptCommit));
  if (staleFailure) return { preserve: false, failures: [], count: failures.length, reason: `stale-attempt-commit:${staleFailure.attemptCommit}` };
  return { preserve: true, failures, count: failures.length, reason: "same-item-history" };
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function implementCommand(repo, relayRoot, claimedItemId) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return `node ${quote(path.join(repo, "scripts", "reciprocal-implement.mjs"))} --repo ${quote(repo)} --control-path ${quote(path.join(relayRoot, "control", "WISHLIST.md"))} --state-path ${quote(path.join(relayRoot, "state", "orchestrator-state.json"))} --claimed-item-id ${quote(claimedItemId)}`;
}

function loadSwapCommands(repo, relayRoot, sourceSha) {
  const q = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return {
    packageB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "dashboard-source", "reciprocal-control-panel", "stop-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)} && powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "package-passive-runtime.ps1"))} -Workspace ${q(repo)} -AdminRepo ${q(repo)} -SourceSha ${sourceSha} && powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "promote-reciprocal-runtime.ps1"))} -TargetRole B -SourceSha ${sourceSha} -RelayRoot ${q(relayRoot)}`,
    startB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "start-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)}`,
    verifyRuntime: `node ${q(path.join(repo, "scripts", "runtime-package-integrity.mjs"))} verify ${q(path.join(relayRoot, "runtimes", "executor-b"))}`,
    rebuildA: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "reciprocal-rebuild-a.ps1"))} -SourceSha ${sourceSha} -RelayRoot ${q(relayRoot)}`,
    verifyA: `node ${q(path.join(repo, "scripts", "runtime-package-integrity.mjs"))} verify ${q(path.join(relayRoot, "runtimes", "executor-a"))}`,
    stopB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "dashboard-source", "reciprocal-control-panel", "stop-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)}`,
  };
}

function loadCommands(repo, relayRoot, state) {
  if (process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON) {
    return JSON.parse(process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON);
  }
  const claimedItemId = state?.currentItem?.id || "";
  const sourceSha = process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA
    || state?.lastImplementCommit
    || runCommand("git rev-parse HEAD", repo).stdout.trim();
  return {
    implement: implementCommand(repo, relayRoot, claimedItemId),
    test: "npm run typecheck && npm test && git diff --check",
    ...loadSwapCommands(repo, relayRoot, sourceSha),
  };
}

function runSwap({ repo, relayRoot, commands, state, statePath, logPath, reason = "cycle" }) {
  state.phase = "swapping";
  save(statePath, logPath, state, `${reason}.swap.started`);
  const swapSteps = [
    ["package-b", commands.packageB],
    ["start-b", commands.startB],
    ["verify-runtime", commands.verifyRuntime],
    ["rebuild-a", commands.rebuildA],
    ["verify-a", commands.verifyA],
    ["stop-b", commands.stopB],
  ];
  const infrastructureAllowance = 8;
  const consecutiveCycleAllowance = 2;
  state.infrastructureFailures = state.infrastructureFailures || {};
  for (const [name, command] of swapSteps) {
    let passed = false;
    let result = null;
    for (let cycle = 1; cycle <= consecutiveCycleAllowance && !passed; cycle += 1) {
      for (let attempt = 1; attempt <= infrastructureAllowance; attempt += 1) {
        result = runInfrastructureAttempt({ name, command, cwd: repo, state, statePath, logPath, attempt, allowance: infrastructureAllowance, cycle });
        if (result.ok) {
          passed = true;
          break;
        }
        appendLog(logPath, { action: `${name}.infrastructure-retry`, phase: state.phase, item: state.currentItem?.id || null, step: state.step || null, attempt, allowance: infrastructureAllowance, cycle });
      }
      if (!passed) {
        const previous = state.infrastructureFailures[name] || { consecutiveCycles: 0 };
        const consecutiveCycles = previous.consecutiveCycles + 1;
        state.infrastructureFailures[name] = { consecutiveCycles, lastFailedAt: now(), allowance: infrastructureAllowance };
        if (cycle < consecutiveCycleAllowance) {
          save(statePath, logPath, state, `${reason}.swap.infrastructure-cycle-retry`, { failedStep: name, cycle, allowance: consecutiveCycleAllowance });
        }
      }
    }
    if (!passed) {
      const consecutiveCycles = state.infrastructureFailures[name]?.consecutiveCycles || consecutiveCycleAllowance;
      state.phase = "failed-paused";
      state.lastSummary = `${name} infrastructure failure exhausted ${infrastructureAllowance} attempts on ${consecutiveCycles} consecutive cycles; implementation passed at ${state.lastImplementCommit || state.acceptedSourceSha || "unknown commit"}.`;
      const failure = { kind: "infrastructure", step: name, command, exitCode: result.exitCode, output: boundedFailureOutput(result.output), implementationPassed: true, implementationCommit: state.lastImplementCommit || state.acceptedSourceSha || null, at: now() };
      state.failures = [...(state.failures || []), failure];
      const report = failReport(relayRoot, state.currentItem || { id: "cutover", text: "explicit cutover" }, state.failures, { infrastructure: true, implementationCommit: failure.implementationCommit, sameStepConsecutiveCycles: consecutiveCycles });
      state.failureReport = report;
      save(statePath, logPath, state, `${reason}.swap.failed-paused`, { failedStep: name, report, infrastructure: true, implementationCommit: failure.implementationCommit });
      console.log(JSON.stringify({ ok: false, failedPaused: true, infrastructureFailure: true, report, state }, null, 2));
      process.exitCode = 3;
      return false;
    }
  }
  return true;
}

function parseWishlist(file) {
  if (!existsSync(file)) return [];
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return retryFsSync(`wishlist.read:${file}`, () => readFileSync(file, utf8)).split(/\r?\n/).flatMap((line, index) => {
    const match = /^- \[ \] (W\d+) \| (P[0-3]) \| (.*?) \| QUEUED(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    return [{ id: match[1], priority: match[2], text: match[3], detail: match[4] || "", line: index, rank: rank[match[2]] ?? 9 }];
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

function markWishlist(file, item, status, note = "") {
  const lines = existsSync(file) ? retryFsSync(`wishlist.read:${file}`, () => readFileSync(file, utf8)).split(/\r?\n/) : [];
  let line = Number.isInteger(item.line) ? item.line : -1;
  if (!lines[line]?.includes(` ${item.id} |`)) {
    line = lines.findIndex((candidate) => new RegExp(`^- \\[[ x]\\] ${item.id} \\|`).test(candidate));
  }
  if (line >= 0 && lines[line]) {
    lines[line] = `- [${status === "DONE" ? "x" : " "}] ${item.id} | ${item.priority} | ${item.text} | ${status}${note ? ` note=${note.replace(/\s+/g, " ").replaceAll("|", "/")}` : ""} updated=${now()}`;
    retryFsSync(`wishlist.write:${file}`, () => writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, utf8));
  }
}

function initialState() {
  return {
    phase: "idle",
    currentItem: null,
    consecutiveFailures: 0,
    infrastructureFailures: {},
    step: null,
    stableCommit: null,
    startedAt: null,
    updatedAt: now(),
    lastSummary: "single orchestrator initialized",
  };
}

function save(statePath, logPath, state, action, detail = {}) {
  state.updatedAt = now();
  writeJsonAtomic(statePath, state);
  appendLog(logPath, { action, phase: state.phase, item: state.currentItem?.id || null, step: state.step || null, ...detail });
}

function failReport(relayRoot, item, failures, context = {}) {
  const dir = path.join(relayRoot, "control", "failure-reports");
  ensureDir(dir);
  const file = path.join(dir, `${item.id}-${now().replace(/[:.]/g, "-")}.md`);
  retryFsSync(`failure-report.write:${file}`, () => writeFileSync(file, [
    `# Reciprocal Failure Report ${item.id}`,
    "",
    `Item: ${item.text}`,
    `Created: ${now()}`,
    "",
    context.infrastructure
      ? `Infrastructure failure paused the orchestrator after its bounded retry allowance${context.sameStepConsecutiveCycles >= 2 ? " (the same step failed on two consecutive cycles)" : ""}. The implementation itself passed; successful implementation commit: ${context.implementationCommit || "unknown"}.`
      : "The single orchestrator paused after two consecutive failed A rounds.",
    "",
    ...failures.map((failure, index) => [
      `## Failure ${index + 1}`,
      "",
      `Command: ${failure.command}`,
      `Cause: ${failure.kind || "item implementation/test"}`,
      failure.implementationCommit ? `Implementation commit: ${failure.implementationCommit}` : "",
      `Exit: ${failure.exitCode}`,
      "",
      "```text",
      failure.output || "",
      "```",
      "",
    ].join("\n")),
  ].join("\n"), utf8));
  return file;
}

function runStep({ name, command, cwd, state, statePath, logPath }) {
  state.step = name;
  save(statePath, logPath, state, `${name}.started`, { command });
  const result = runCommand(command, cwd);
  save(statePath, logPath, state, result.ok ? `${name}.passed` : `${name}.failed`, { command, exitCode: result.exitCode, outputHash: sha(result.output).slice(0, 16) });
  return result;
}

function runInfrastructureAttempt({ name, command, cwd, state, statePath, logPath, attempt, allowance, cycle }) {
  state.step = name;
  save(statePath, logPath, state, `${name}.started`, { command, attempt, allowance, cycle, infrastructure: true });
  const result = runCommand(command, cwd);
  if (result.ok) {
    state.infrastructureFailures = state.infrastructureFailures || {};
    state.infrastructureFailures[name] = { consecutiveCycles: 0, lastPassedAt: now(), allowance };
  }
  save(statePath, logPath, state, result.ok ? `${name}.passed` : `${name}.failed`, {
    command,
    exitCode: result.exitCode,
    outputHash: sha(result.output).slice(0, 16),
    attempt,
    allowance,
    cycle,
    infrastructure: true,
    consecutiveCycles: state.infrastructureFailures?.[name]?.consecutiveCycles || 0,
  });
  return result;
}

function acceptedSourceSha(repo, state) {
  if (state?.lastImplementCommit && /^[0-9a-f]{40}$/i.test(state.lastImplementCommit)) return state.lastImplementCommit;
  if (process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA) return process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA;
  return runCommand("git rev-parse HEAD", repo).stdout.trim();
}

function updateStableRef(repo, sourceSha, logPath) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) return;
  const result = runCommand(`git update-ref refs/tandem-relay/stable ${sourceSha}`, repo);
  appendLog(logPath, { action: result.ok ? "stable-ref.updated" : "stable-ref.failed", sourceSha, exitCode: result.exitCode, outputHash: sha(result.output).slice(0, 16) });
  if (!result.ok) throw new Error(`Failed to update stable ref to ${sourceSha}: ${result.output}`);
}

function requeueCurrentItem(wishlistPath, item, note) {
  if (!item || !existsSync(wishlistPath)) return;
  const lines = retryFsSync(`wishlist.read:${wishlistPath}`, () => readFileSync(wishlistPath, utf8)).split(/\r?\n/);
  const targetRe = new RegExp(`^- \\[[ x]\\] ${item.id} \\|`);
  const cleanNote = (note || "").replace(/\s+/g, " ").replaceAll("|", "/").trim();
  for (let i = 0; i < lines.length; i += 1) {
    if (!targetRe.test(lines[i])) continue;
    const parts = lines[i].split(" | ");
    if (parts.length < 4) return;
    const head = `${parts[0]} | ${parts[1]} | ${parts[2]} | QUEUED`;
    const existingNoteMatch = lines[i].match(/\bnote=([^ ]+)/);
    const notes = [existingNoteMatch?.[1], cleanNote].filter(Boolean);
    const noteSuffix = notes.length ? ` note=${notes.join(" / ")}` : "";
    lines[i] = `${head}${noteSuffix} updated=${now()}`;
    break;
  }
  retryFsSync(`wishlist.write:${wishlistPath}`, () => writeFileSync(wishlistPath, `${lines.join("\n").replace(/\n*$/, "")}\n`, utf8));
}

function main() {
  const repo = path.resolve(arg("repo", process.cwd()));
  const relayRoot = path.resolve(arg("relay-root", process.env.TANDEM_RECIPROCAL_ROOT || path.join(path.dirname(repo), "Tandem Reciprocal")));
  const statePath = path.join(relayRoot, "state", "orchestrator-state.json");
  const logPath = path.join(relayRoot, "control", "orchestrator-operations.ndjson");
  const wishlistPath = path.join(relayRoot, "control", "WISHLIST.md");
  const pausePath = path.join(relayRoot, "control", "PAUSE");
  let state = readJson(statePath, initialState());
  const commands = loadCommands(repo, relayRoot, state);

  if (boolArg("status")) {
    console.log(JSON.stringify({ ok: true, state, statePath, logPath }, null, 2));
    return;
  }

  const releaseLock = acquireInvocationLock(relayRoot, logPath, state);
  if (!releaseLock) {
    console.log(JSON.stringify({ ok: true, locked: true, state }, null, 2));
    return;
  }
  try {
  if (boolArg("resume")) {
    const reason = arg("reason", "human reviewed failure report; retry authorized");
    const previousPhase = state.phase;
    const resumedItem = state.currentItem?.id || null;
    if (boolArg("finalize-accepted")) {
      const sourceSha = state.acceptedSourceSha || state.lastImplementCommit || "";
      if (!/^[0-9a-f]{40}$/i.test(sourceSha) || !state.currentItem) {
        console.log(JSON.stringify({ ok: false, finalized: false, reason: "no accepted source SHA or current item to finalize", state }, null, 2));
        process.exitCode = 2;
        return;
      }
      markWishlist(wishlistPath, state.currentItem, "DONE", `orchestrator-cycle-complete stable=${sourceSha}`);
      updateStableRef(repo, sourceSha, logPath);
      state.phase = "idle";
      state.step = null;
      state.stableCommit = sourceSha;
      state.consecutiveFailures = 0;
      state.failures = [];
      state.failureReport = undefined;
      state.lastSummary = `Finalized accepted ${resumedItem} from ${previousPhase}: ${reason}`;
      state.currentItem = null;
      save(statePath, logPath, state, "failed-paused.accepted-finalized", { reason, previousPhase, resumedItem, sourceSha });
      console.log(JSON.stringify({ ok: true, finalized: true, reason, previousPhase, sourceSha, state }, null, 2));
      return;
    }
    const failureHistory = resumeFailureHistoryDecision(repo, state, boolArg("discard-failures"));
    state.phase = "idle";
    state.step = null;
    state.consecutiveFailures = 0;
    state.failures = failureHistory.failures;
    state.failureReport = undefined;
    state.lastSummary = `Resumed from ${previousPhase}: ${reason} (${failureHistory.preserve ? "preserved" : "discarded"} ${failureHistory.count} failure record(s): ${failureHistory.reason})`;
    save(statePath, logPath, state, "failed-paused.resumed", { reason, previousPhase, resumedItem, failureHistory });
    console.log(JSON.stringify({ ok: true, resumed: true, reason, previousPhase, state }, null, 2));
    return;
  }
  if (boolArg("cutover")) {
    if (state.phase === "failed-paused") {
      console.log(JSON.stringify({ ok: true, paused: true, state }, null, 2));
      return;
    }
    state.currentItem = {
      id: "cutover",
      priority: "P0",
      text: "Replace parked legacy A-upgrade gate with single-orchestrator runtime swap",
      line: null,
    };
    state.consecutiveFailures = 0;
    state.failures = [];
    state.startedAt = now();
    state.lastSummary = "Starting explicit D196 cutover.";
    save(statePath, logPath, state, "cutover.started");
    const swapped = runSwap({ repo, relayRoot, commands, state, statePath, logPath, reason: "cutover" });
    if (!swapped) return;
    state.phase = "idle";
    state.step = null;
    state.stableCommit = acceptedSourceSha(repo, state);
    updateStableRef(repo, state.stableCommit, logPath);
    state.lastSummary = "Explicit D196 cutover completed; A is running accepted runtime and B is stopped.";
    state.currentItem = null;
    state.consecutiveFailures = 0;
    state.failures = [];
    save(statePath, logPath, state, "cutover.completed");
    console.log(JSON.stringify({ ok: true, cutover: true, state }, null, 2));
    return;
  }
  if (existsSync(pausePath) && state.phase !== "failed-paused") {
    state.phase = "failed-paused";
    state.lastSummary = `Paused by ${pausePath}`;
    save(statePath, logPath, state, "pause-control");
    console.log(JSON.stringify({ ok: true, paused: true, state }, null, 2));
    return;
  }
  if (state.phase === "failed-paused") {
    appendLog(logPath, { action: "failed-paused.noop", item: state.currentItem?.id || null });
    console.log(JSON.stringify({ ok: true, paused: true, state }, null, 2));
    return;
  }
  if (!state.currentItem) {
    const item = parseWishlist(wishlistPath)[0] || null;
    if (!item) {
      state.phase = "idle";
      state.lastSummary = "No queued wishlist item.";
      save(statePath, logPath, state, "idle.no-work");
      console.log(JSON.stringify({ ok: true, idle: true, state }, null, 2));
      return;
    }
    state.currentItem = { id: item.id, priority: item.priority, text: item.text, detail: item.detail, line: item.line };
    state.consecutiveFailures = 0;
    state.failures = [];
    state.startedAt = now();
    markWishlist(wishlistPath, item, "IN_PROGRESS", "orchestrator");
  }

  state.phase = "improving";
  save(statePath, logPath, state, "cycle.claimed");
  for (;;) {
    const headBefore = runCommand("git rev-parse HEAD", repo).stdout.trim();
    const implementation = runStep({ name: "a-implements", command: process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON ? commands.implement : implementCommand(repo, relayRoot, state.currentItem.id), cwd: repo, state, statePath, logPath });
    if (implementation.ok) {
      const headAfter = runCommand("git rev-parse HEAD", repo).stdout.trim();
      const descendantCheck = runCommand(`git merge-base --is-ancestor ${headBefore} ${headAfter}`, repo);
      if (headAfter === headBefore || !descendantCheck.ok) {
        const noCommitError = {
          step: "a-implements",
          exitCode: implementation.exitCode,
          headBefore,
          headAfter,
          descendant: descendantCheck.ok,
          message: "a-implements reported success but produced no new descendant commit on top of HEAD. The cycle cannot false-complete; the wishlist item will be requeued for a real attempt.",
        };
        requeueCurrentItem(wishlistPath, state.currentItem, `D200 no-commit abort: ${headBefore}->${headAfter}; a-implements reported success but did not produce a descendant commit`);
        save(statePath, logPath, state, "cycle.aborted.no-commit", noCommitError);
        console.log(JSON.stringify({ ok: false, aborted: "no-commit", state, ...noCommitError }, null, 2));
        process.exit(3);
      }
      state.lastImplementCommit = headAfter;
      state.acceptedSourceSha = headAfter;
      save(statePath, logPath, state, "implement-commit.accepted", { lastImplementCommit: headAfter });
    }
    const test = implementation.ok ? runStep({ name: "a-tests", command: commands.test, cwd: repo, state, statePath, logPath }) : implementation;
    if (test.ok) break;
    state.consecutiveFailures += 1;
    const failure = {
      item: state.currentItem?.id || null,
      command: test.command,
      exitCode: test.exitCode,
      output: boundedFailureOutput(test.output),
      attemptCommit: implementation.ok ? state.lastImplementCommit : null,
      at: now(),
    };
    state.failures = [...(state.failures || []), failure];
    save(statePath, logPath, state, "cycle.retry-feedback", {
      consecutiveFailures: state.consecutiveFailures,
      feedbackBytes: Buffer.byteLength(failure.output || "", "utf8"),
      feedbackDeliveredVia: "state.failures",
      attemptCommit: failure.attemptCommit,
    });
    if (state.consecutiveFailures >= 2) {
      state.phase = "failed-paused";
      state.step = "failed-paused";
      const report = failReport(relayRoot, state.currentItem, state.failures);
      state.failureReport = report;
      state.lastSummary = `Paused after two failed rounds; report written to ${report}`;
      save(statePath, logPath, state, "cycle.failed-paused", { report });
      console.log(JSON.stringify({ ok: false, failedPaused: true, report, state }, null, 2));
      process.exitCode = 2;
      return;
    }
  }

  const acceptedCommit = acceptedSourceSha(repo, state);
  const swapCommands = process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON
    ? commands
    : loadSwapCommands(repo, relayRoot, acceptedCommit);
  if (!runSwap({ repo, relayRoot, commands: swapCommands, state, statePath, logPath })) return;

  markWishlist(wishlistPath, state.currentItem, "DONE", "orchestrator-cycle-complete");
  state.phase = "idle";
  state.step = null;
  state.stableCommit = acceptedSourceSha(repo, state) || state.stableCommit || "accepted-version";
  updateStableRef(repo, state.stableCommit, logPath);
  state.lastSummary = `Completed ${state.currentItem.id} through the single orchestrator.`;
  const completedItem = state.currentItem;
  state.currentItem = null;
  state.consecutiveFailures = 0;
  state.failures = [];
  save(statePath, logPath, state, "cycle.completed", { completedItem: completedItem.id });
  console.log(JSON.stringify({ ok: true, completed: completedItem.id, state }, null, 2));
  } finally {
    releaseLock();
  }
}

main();
