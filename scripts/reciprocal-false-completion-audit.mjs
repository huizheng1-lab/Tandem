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
  return readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function findCycleWindow(log) {
  return log;
}

function isReadOnlyImplementPlaceholder(command) {
  if (!command) return false;
  return /reciprocal-direction\.ps1[\s\S]*?-Action\s+Show\b/.test(command)
    || /-Action\s+Show[\s\S]*?-ControlPath\b/.test(command);
}

function detectFalseCompletion(entry, window, entryIndex) {
  const slice = window.slice(Math.max(0, entryIndex - 20), entryIndex + 1);
  const started = [...slice].reverse().find((e) => e.action === "a-implements.started" && (e.item === entry.completedItem || e.item === entry.item));
  if (!started) return null;
  if (!isReadOnlyImplementPlaceholder(started.command || "")) return null;
  const passed = slice.find((e) => e.action === "a-implements.passed" && (e.item === entry.completedItem || e.item === entry.item));
  if (!passed) return null;
  const stableEntry = [...slice].reverse().find((e) => e.action === "stable-ref.updated");
  return {
    item: entry.completedItem || entry.item,
    completedAt: entry.at,
    stableSha: stableEntry?.sourceSha || null,
    reason: "a-implements was the read-only reciprocal-direction.ps1 Show placeholder; the cycle completed without producing any descendant commit on HEAD.",
  };
}

function verifyImplementingCommit(repo, item, sinceMs) {
  const sinceIso = new Date(sinceMs).toISOString();
  const result = spawnSync("git", ["log", "--since", sinceIso, "--pretty=format:%H %s", "refs/tandem-relay/stable"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) return { implemented: false, error: result.stderr };
  const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  return {
    implemented: lines.length > 0,
    implementingCommits: lines,
  };
}

function run() {
  const log = readOpsLog();
  const window = findCycleWindow(log);
  const cycles = window.filter((entry) => entry.action === "cycle.completed");
  const findings = [];
  for (const [index, entry] of window.entries()) {
    if (entry.action !== "cycle.completed") continue;
    const falseCompletion = detectFalseCompletion(entry, window, index);
    if (!falseCompletion) continue;
    const verify = verifyImplementingCommit(repo, falseCompletion.item, Date.parse(falseCompletion.completedAt) - 60_000);
    findings.push({
      item: falseCompletion.item,
      completedAt: falseCompletion.completedAt,
      stableSha: falseCompletion.stableSha,
      reason: falseCompletion.reason,
      verifiedImplementingCommit: verify,
    });
  }
  const result = {
    generatedAt: new Date().toISOString(),
    repo,
    logPath,
    sinceTag,
    totalCycleCompletions: cycles.length,
    falseCompletionsSuspected: findings.length,
    findings,
    note: "Read-only audit; no live state modified. Items listed here completed via the read-only a-implements placeholder and lack a verified implementing commit on refs/tandem-relay/stable.",
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(output);
  if (writeArtifact) {
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, output, "utf8");
  }
}

run();
