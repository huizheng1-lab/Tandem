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

function runAgent(cwd, command, args, timeout, input) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout, shell: true, input });
}

function main() {
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
    "Inspect the repository (use file reads and directory listing) to find the existing code this item",
    "relates to. If no existing code applies, propose a minimal, isolated change in a new file that",
    "addresses the item without touching unrelated areas.",
    "",
    "Make a real code change that addresses the item, using the Edit/Write tools. Do NOT run git yourself",
    "(you have no Bash tool) - a wrapper script commits your file changes for you after you finish.",
    "",
    "Do NOT modify the wishlist file, the orchestrator state file, the relay state, or any swap/promotion",
    "machinery; the orchestrator owns those. Do NOT mark the item DONE. Do NOT run the test suite; the",
    "orchestrator runs the full test suite itself as a separate step after your change is committed.",
    "",
    "This is a fully unattended, non-interactive run: there is no human available to answer questions.",
    "Never ask for confirmation, never present options for a human to choose between, and never pause",
    "waiting on input. Decide autonomously and proceed. If you are genuinely blocked, print `ABORT <short",
    "reason>` and exit non-zero instead of asking anything.",
    "",
    "When you finish, print exactly one line on the last stdout line: `SUMMARY: <short one-line summary of",
    "the change>`. If you cannot make a real change, print `ABORT <short reason>` and exit non-zero.",
  ].join("\n");
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Edit,Write,Glob,Grep",
    "--system-prompt", "Implement the wishlist item by editing files. Be terse. This is a headless, unattended run: never ask questions or wait for confirmation; decide autonomously. You have no Bash/git access - a wrapper commits your changes afterward.",
  ];
  const result = runAgent(repo, agentBin, args, maxDurationMs, prompt);
  if (result.error) {
    die(1, { step: "agent-spawn", message: result.error.message, agent: agentBin });
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    die(1, {
      step: "agent-exit",
      message: `agent exited ${exitCode}`,
      agent: agentBin,
      headBefore,
      stdoutTail: String(result.stdout || "").slice(-2000),
      stderrTail: String(result.stderr || "").slice(-2000),
    });
  }
  if (workingTreeClean(repo)) {
    die(2, {
      step: "verify-no-commit",
      message: "agent exited 0 but made no file changes; no implementing commit was produced",
      item: claimed.id,
      headBefore,
      stdoutTail: String(result.stdout || "").slice(-2000),
    });
  }
  const out = String(result.stdout || "");
  const summaryMatch = out.match(/SUMMARY:\s*(.+)/);
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 200) : `${claimed.id}: ${claimed.text}`.slice(0, 200);
  const addResult = git(repo, ["add", "-A"]);
  if (!addResult.ok) {
    die(2, { step: "git-add", message: `git add -A failed: ${addResult.stderr}`, item: claimed.id, headBefore });
  }
  const commitResult = git(repo, ["commit", "-m", `Wishlist ${claimed.id}: ${summary}`]);
  if (!commitResult.ok) {
    die(2, { step: "git-commit", message: `git commit failed: ${commitResult.stderr}`, item: claimed.id, headBefore });
  }
  const headAfter = headSha(repo);
  if (headAfter === headBefore) {
    die(2, {
      step: "verify-no-commit",
      message: "git commit reported success but HEAD did not advance",
      item: claimed.id,
      headBefore,
      headAfter,
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
  const newSha = headAfter;
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

main();
