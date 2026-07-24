#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const controlPath = arg("control-path", process.env.TANDEM_RECIPROCAL_CONTROL || "");
const statePath = arg("state-path", process.env.TANDEM_RECIPROCAL_STATE || "");
const claimedItemId = arg("claimed-item-id", process.env.TANDEM_RECIPROCAL_CLAIMED_ITEM || "");
const maxDurationMs = Number(arg("max-duration-ms", process.env.TANDEM_RECIPROCAL_MAX_DURATION_MS || 50 * 60 * 1000));
const agentBin = arg("agent-bin", process.env.TANDEM_RECIPROCAL_IMPLEMENT_BIN || process.env.TANDEM_CLAUDE_BIN || "claude");
const dryRun = boolArg("dry-run") || process.env.TANDEM_RECIPROCAL_DRY_RUN === "1";

function die(code, payload) {
  process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
  process.exit(code);
}

function readClaimedItem() {
  if (!claimedItemId) throw new Error("claimed-item-id is required");
  const id = claimedItemId;
  let line = "";
  let text = "";
  if (statePath && existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.currentItem && state.currentItem.id === id) {
        line = `${id} | ${state.currentItem.priority || "P?"} | ${state.currentItem.text || ""}`;
        text = state.currentItem.text || "";
      }
    } catch {}
  }
  if (!text && controlPath && existsSync(controlPath)) {
    const lines = readFileSync(controlPath, "utf8").split(/\r?\n/);
    for (const candidate of lines) {
      const m = candidate.match(new RegExp(`^- \\[ \\] (${id}) \\| (P[0-3]) \\| (.*?) \\| (?:QUEUED|IN_PROGRESS)(?:\\s|$)`));
      if (m) {
        line = candidate;
        text = m[3];
        break;
      }
    }
  }
  if (!text) throw new Error(`Claimed wishlist item ${id} not found in state or control file.`);
  return { id, text, line };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8", windowsHide: true });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    ok: (result.status ?? 1) === 0,
  };
}

function headSha(cwd) {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  if (!r.ok) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
  return r.stdout;
}

function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function workingTreeClean(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok) return false;
  return r.stdout.length === 0;
}

function item() {
  let claimed;
  try {
    claimed = readClaimedItem();
  } catch (error) {
    die(2, { step: "read-claimed-item", message: error.message });
  }
  const headBefore = headSha(repo);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, item: claimed.id, headBefore, agent: agentBin })}\n`);
    return;
  }
  const prompt = [
    `You are implementing wishlist item ${claimed.id} in the current repository (cwd: ${repo}).`,
    "",
    `The item text is:`,
    claimed.text,
    "",
    "Inspect the repository (use git status, git ls-files, and file reads) to find the existing code",
    "this item relates to. If no existing code applies, propose a minimal, isolated change in a new file",
    "that addresses the item without touching unrelated areas.",
    "",
    "Make a real code change that addresses the item. Then run `git add` and `git commit` so the change",
    "becomes a NEW commit on top of HEAD (do NOT amend an existing commit, do NOT rebase, do NOT push).",
    "",
    "Do NOT modify the wishlist file, the orchestrator state file, the relay state, or any swap/promotion",
    "machinery; the orchestrator owns those. Do NOT mark the item DONE.",
    "",
    "Commit message format: `D200-N: <short summary>` where N is the next available D200-N number for",
    "this batch (check `git log --oneline -20` to pick the next unused number).",
    "",
    "When you finish, print exactly one line on the last stdout line: `DONE <new-commit-sha>` with the",
    "full 40-char SHA of the new commit. If you cannot make a real change, print `ABORT <short reason>`",
    "and exit with a non-zero status.",
  ].join("\n");
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--no-session-persistence",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Bash(git add *),Bash(git commit *),Bash(git status),Bash(git log *),Bash(git rev-parse *),Read,Edit,Write,Glob,Grep",
    "--system-prompt", "Implement the wishlist item. Use git for version control. Be terse.",
  ];
  const result = spawnSync(agentBin, args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout: maxDurationMs });
  if (result.error) {
    die(1, { step: "agent-spawn", message: result.error.message, agent: agentBin });
  }
  const exitCode = result.status ?? 1;
  const headAfter = headSha(repo);
  if (exitCode !== 0) {
    die(1, {
      step: "agent-exit",
      message: `agent exited ${exitCode}`,
      agent: agentBin,
      headBefore,
      headAfter,
      stdoutTail: String(result.stdout || "").slice(-2000),
      stderrTail: String(result.stderr || "").slice(-2000),
    });
  }
  if (headAfter === headBefore) {
    die(2, {
      step: "verify-no-commit",
      message: "agent exited 0 but HEAD did not advance; no implementing commit was produced",
      item: claimed.id,
      headBefore,
      headAfter,
      stdoutTail: String(result.stdout || "").slice(-2000),
    });
  }
  if (!isAncestor(repo, headBefore, headAfter)) {
    die(2, {
      step: "verify-descendant",
      message: "HEAD changed but the new commit is not a descendant of the pre-implementation HEAD (amend, rebase, or external HEAD move detected)",
      item: claimed.id,
      headBefore,
      headAfter,
    });
  }
  const out = String(result.stdout || "");
  const shaMatch = out.match(/DONE ([0-9a-f]{40})/);
  const newSha = shaMatch ? shaMatch[1] : headAfter;
  if (!workingTreeClean(repo)) {
    die(2, {
      step: "verify-clean",
      message: "implementing commit was produced but the working tree is still dirty",
      item: claimed.id,
      newSha,
    });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    item: claimed.id,
    headBefore,
    headAfter,
    newSha,
    agent: agentBin,
    exitCode,
  })}\n`);
}

item();
