#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const utf8 = "utf8";
const maxStateBytes = 5 * 1024 * 1024;

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
  mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  const size = statSync(file).size;
  if (size > maxStateBytes) throw new Error(`Refusing to read oversized JSON file ${file} (${size} bytes).`);
  return JSON.parse(readFileSync(file, utf8));
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, utf8);
  if (bytes > maxStateBytes) throw new Error(`Refusing to write oversized JSON file ${file} (${bytes} bytes).`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, body, utf8);
  renameSync(temp, file);
}

function appendLog(file, entry) {
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify({ at: now(), ...entry })}\n`, utf8);
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

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function loadCommands(repo, relayRoot) {
  if (process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON) {
    return JSON.parse(process.env.TANDEM_ORCHESTRATOR_COMMANDS_JSON);
  }
  const q = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const sourceSha = process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA || runCommand("git rev-parse HEAD", repo).stdout.trim();
  return {
    implement: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "reciprocal-direction.ps1"))} -Action Show -ControlPath ${q(path.join(relayRoot, "control", "WISHLIST.md"))}`,
    test: "npm run typecheck && npm test && git diff --check",
    packageB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "dashboard-source", "reciprocal-control-panel", "stop-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)} && powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "package-passive-runtime.ps1"))} -Workspace ${q(repo)} -AdminRepo ${q(repo)} -SourceSha ${sourceSha} && powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "promote-reciprocal-runtime.ps1"))} -TargetRole B -SourceSha ${sourceSha} -RelayRoot ${q(relayRoot)}`,
    startB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "start-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)}`,
    verifyRuntime: `node ${q(path.join(repo, "scripts", "runtime-package-integrity.mjs"))} verify ${q(path.join(relayRoot, "runtimes", "executor-b"))}`,
    rebuildA: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "scripts", "reciprocal-rebuild-a.ps1"))} -SourceSha ${sourceSha} -RelayRoot ${q(relayRoot)}`,
    verifyA: `node ${q(path.join(repo, "scripts", "runtime-package-integrity.mjs"))} verify ${q(path.join(relayRoot, "runtimes", "executor-a"))}`,
    stopB: `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(repo, "dashboard-source", "reciprocal-control-panel", "stop-reciprocal-tandem.ps1"))} -Role B -RelayRoot ${q(relayRoot)}`,
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
  for (const [name, command] of swapSteps) {
    const result = runStep({ name, command, cwd: repo, state, statePath, logPath });
    if (!result.ok) {
      state.phase = "failed-paused";
      state.lastSummary = `${name} failed; at least the previously known-good executor must remain alive.`;
      state.failures = [...(state.failures || []), { command, exitCode: result.exitCode, output: result.output.slice(0, 12000), at: now() }];
      const report = failReport(relayRoot, state.currentItem || { id: "cutover", text: "explicit cutover" }, state.failures);
      state.failureReport = report;
      save(statePath, logPath, state, `${reason}.swap.failed-paused`, { failedStep: name, report });
      console.log(JSON.stringify({ ok: false, failedPaused: true, report, state }, null, 2));
      process.exitCode = 3;
      return false;
    }
  }
  return true;
}

function parseWishlist(file) {
  if (!existsSync(file)) return [];
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return readFileSync(file, utf8).split(/\r?\n/).flatMap((line, index) => {
    const match = /^- \[ \] (W\d+) \| (P[0-3]) \| (.*?) \| QUEUED(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    return [{ id: match[1], priority: match[2], text: match[3], detail: match[4] || "", line: index, rank: rank[match[2]] ?? 9 }];
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

function markWishlist(file, item, status, note = "") {
  const lines = existsSync(file) ? readFileSync(file, utf8).split(/\r?\n/) : [];
  if (lines[item.line]) {
    lines[item.line] = `- [${status === "DONE" ? "x" : " "}] ${item.id} | ${item.priority} | ${item.text} | ${status}${note ? ` note=${note.replace(/\s+/g, " ").replaceAll("|", "/")}` : ""} updated=${now()}`;
    writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, utf8);
  }
}

function initialState() {
  return {
    phase: "idle",
    currentItem: null,
    consecutiveFailures: 0,
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

function failReport(relayRoot, item, failures) {
  const dir = path.join(relayRoot, "control", "failure-reports");
  ensureDir(dir);
  const file = path.join(dir, `${item.id}-${now().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, [
    `# Reciprocal Failure Report ${item.id}`,
    "",
    `Item: ${item.text}`,
    `Created: ${now()}`,
    "",
    "The single orchestrator paused after two consecutive failed A rounds.",
    "",
    ...failures.map((failure, index) => [
      `## Failure ${index + 1}`,
      "",
      `Command: ${failure.command}`,
      `Exit: ${failure.exitCode}`,
      "",
      "```text",
      (failure.output || "").slice(0, 8000),
      "```",
      "",
    ].join("\n")),
  ].join("\n"), utf8);
  return file;
}

function runStep({ name, command, cwd, state, statePath, logPath }) {
  state.step = name;
  save(statePath, logPath, state, `${name}.started`, { command });
  const result = runCommand(command, cwd);
  save(statePath, logPath, state, result.ok ? `${name}.passed` : `${name}.failed`, { command, exitCode: result.exitCode, outputHash: sha(result.output).slice(0, 16) });
  return result;
}

function main() {
  const repo = path.resolve(arg("repo", process.cwd()));
  const relayRoot = path.resolve(arg("relay-root", process.env.TANDEM_RECIPROCAL_ROOT || path.join(path.dirname(repo), "Tandem Reciprocal")));
  const statePath = path.join(relayRoot, "state", "orchestrator-state.json");
  const logPath = path.join(relayRoot, "control", "orchestrator-operations.ndjson");
  const wishlistPath = path.join(relayRoot, "control", "WISHLIST.md");
  const pausePath = path.join(relayRoot, "control", "PAUSE");
  const commands = loadCommands(repo, relayRoot);
  let state = readJson(statePath, initialState());

  if (boolArg("status")) {
    console.log(JSON.stringify({ ok: true, state, statePath, logPath }, null, 2));
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
    state.stableCommit = process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA || runCommand("git rev-parse HEAD", repo).stdout.trim();
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
    const implementation = runStep({ name: "a-implements", command: commands.implement, cwd: repo, state, statePath, logPath });
    const test = implementation.ok ? runStep({ name: "a-tests", command: commands.test, cwd: repo, state, statePath, logPath }) : implementation;
    if (test.ok) break;
    state.consecutiveFailures += 1;
    state.failures = [...(state.failures || []), { command: test.command, exitCode: test.exitCode, output: test.output.slice(0, 12000), at: now() }];
    save(statePath, logPath, state, "cycle.retry-feedback", { consecutiveFailures: state.consecutiveFailures, feedbackBytes: Buffer.byteLength(test.output || "", utf8) });
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

  if (!runSwap({ repo, relayRoot, commands, state, statePath, logPath })) return;

  const lines = existsSync(wishlistPath) ? readFileSync(wishlistPath, utf8).split(/\r?\n/) : [];
  const currentLine = lines[state.currentItem.line] || "";
  if (currentLine.includes(` ${state.currentItem.id} |`)) {
    markWishlist(wishlistPath, { ...state.currentItem, line: state.currentItem.line }, "DONE", "orchestrator-cycle-complete");
  }
  state.phase = "idle";
  state.step = null;
  state.stableCommit = process.env.TANDEM_ORCHESTRATOR_SOURCE_SHA || state.stableCommit || "accepted-version";
  state.lastSummary = `Completed ${state.currentItem.id} through the single orchestrator.`;
  const completedItem = state.currentItem;
  state.currentItem = null;
  state.consecutiveFailures = 0;
  state.failures = [];
  save(statePath, logPath, state, "cycle.completed", { completedItem: completedItem.id });
  console.log(JSON.stringify({ ok: true, completed: completedItem.id, state }, null, 2));
}

main();
