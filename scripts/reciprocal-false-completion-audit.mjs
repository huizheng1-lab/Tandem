#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function arg(name, fallback = "") {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prefix = `${flag}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name) {
  return process.argv.includes(`--${name}`);
}

const repo = path.resolve(arg("repo", process.env.TANDEM_RECIPROCAL_REPO || process.cwd()));
const logPath = arg("log-path", process.env.TANDEM_ORCHESTRATOR_LOG || path.join(repo, "..", "Tandem Reciprocal", "control", "orchestrator-operations.ndjson"));
const sinceTag = arg("since", "D196-1");
const writeArtifact = boolArg("write-artifact");
const artifactPath = arg("artifact-path", path.join(repo, "control", "d200-false-completion-audit.json"));

function readOpsLog() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return { ...JSON.parse(line), __index: index }; } catch { return null; }
  }).filter(Boolean);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  return {
    ok: (result.status ?? 1) === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function sinceTagTimestamp() {
  if (!sinceTag) return null;
  const result = git(["log", "-1", "--format=%cI", sinceTag]);
  const fallback = result.ok && result.stdout
    ? result
    : git(["log", "-1", "--format=%cI", `--grep=^${sinceTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "--all"]);
  if (!fallback.ok || !fallback.stdout) return null;
  const ms = Date.parse(fallback.stdout);
  return Number.isFinite(ms) ? ms : null;
}

function findCycleWindow(log) {
  const sinceMs = sinceTagTimestamp();
  if (!sinceMs) return { entries: log, sinceAt: null };
  return {
    entries: log.filter((entry) => {
      const ms = Date.parse(entry.at || "");
      return Number.isFinite(ms) && ms >= sinceMs;
    }),
    sinceAt: new Date(sinceMs).toISOString(),
  };
}

function isReadOnlyImplementPlaceholder(command) {
  if (!command) return false;
  return /reciprocal-direction\.ps1[\s\S]*?-Action\s+Show\b/.test(command)
    || /-Action\s+Show[\s\S]*?-ControlPath\b/.test(command);
}

function itemForCompletion(entry) {
  return entry.completedItem || entry.item || null;
}

function cycleForCompletion(window, entryIndex) {
  const completion = window[entryIndex];
  const item = itemForCompletion(completion);
  if (!item) return null;
  for (let i = entryIndex - 1; i >= 0; i -= 1) {
    const candidate = window[i];
    if (candidate.action === "cycle.completed" && itemForCompletion(candidate) === item) break;
    if (candidate.action === "cycle.claimed" && candidate.item === item) {
      return { item, claimed: candidate, completed: completion, startIndex: i, endIndex: entryIndex, entries: window.slice(i, entryIndex + 1) };
    }
  }
  return null;
}

function detectFalseCompletion(cycle) {
  const slice = cycle.entries;
  const started = slice.find((e) => e.action === "a-implements.started" && e.item === cycle.item);
  if (!started) return null;
  if (!isReadOnlyImplementPlaceholder(started.command || "")) return null;
  const passed = slice.find((e) => e.action === "a-implements.passed" && e.item === cycle.item);
  if (!passed) return null;
  const accepted = slice.find((e) => e.action === "implement-commit.accepted" && e.item === cycle.item && /^[0-9a-f]{40}$/i.test(e.lastImplementCommit || ""));
  if (accepted) return null;
  const stableEntry = [...slice].reverse().find((e) => e.action === "stable-ref.updated");
  return {
    item: cycle.item,
    claimedAt: cycle.claimed.at,
    completedAt: cycle.completed.at,
    claimedLogIndex: cycle.claimed.__index,
    completedLogIndex: cycle.completed.__index,
    stableSha: stableEntry?.sourceSha || null,
    reason: "cycle-local a-implements was the read-only reciprocal-direction.ps1 Show placeholder and the claim/completion window contains no implement-commit.accepted SHA.",
  };
}

function verifyCycleLocalImplementation(cycle) {
  const accepted = [...cycle.entries].reverse().find((e) => e.action === "implement-commit.accepted" && e.item === cycle.item && /^[0-9a-f]{40}$/i.test(e.lastImplementCommit || ""));
  if (!accepted) {
    return { implemented: false, reason: "no cycle-local implement-commit.accepted entry" };
  }
  const stable = cycle.entries.find((e) => e.action === "stable-ref.updated" && e.sourceSha === accepted.lastImplementCommit);
  if (!stable) {
    return { implemented: false, reason: "cycle-local implementation was not promoted to stable", acceptedSha: accepted.lastImplementCommit };
  }
  return {
    implemented: true,
    acceptedSha: accepted.lastImplementCommit,
    stableSha: stable.sourceSha,
    acceptedAt: accepted.at,
    stableAt: stable.at,
  };
}

function run() {
  const log = readOpsLog();
  const { entries: window, sinceAt } = findCycleWindow(log);
  const cycles = window.filter((entry) => entry.action === "cycle.completed");
  const findings = [];
  for (const [index, entry] of window.entries()) {
    if (entry.action !== "cycle.completed") continue;
    const cycle = cycleForCompletion(window, index);
    if (!cycle) continue;
    const falseCompletion = detectFalseCompletion(cycle);
    if (!falseCompletion) continue;
    findings.push({
      item: falseCompletion.item,
      claimedAt: falseCompletion.claimedAt,
      completedAt: falseCompletion.completedAt,
      claimedLogIndex: falseCompletion.claimedLogIndex,
      completedLogIndex: falseCompletion.completedLogIndex,
      stableSha: falseCompletion.stableSha,
      reason: falseCompletion.reason,
      verifiedImplementingCommit: verifyCycleLocalImplementation(cycle),
    });
  }
  const result = {
    generatedAt: new Date().toISOString(),
    repo,
    logPath,
    sinceTag,
    sinceAt,
    totalCycleCompletions: cycles.length,
    falseCompletionsSuspected: findings.length,
    findings,
    note: "Read-only audit; no live state modified. Items listed here completed via the read-only a-implements placeholder and lack a cycle-local implement-commit.accepted SHA promoted to stable.",
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(output);
  if (writeArtifact) {
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, output, "utf8");
  }
}

run();
