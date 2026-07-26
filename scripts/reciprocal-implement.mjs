#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function workingTreeStatus(cwd) {
  const r = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!r.ok) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout;
}

function trackedWorktreeStatus(cwd) {
  return workingTreeStatus(cwd).split(/\r?\n/).filter((line) => line && !line.startsWith("?? ")).join("\n");
}

function untrackedPaths(cwd) {
  return workingTreeStatus(cwd).split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
}

function changedPaths(cwd) {
  const status = workingTreeStatus(cwd);
  return status.split(/\r?\n/).filter(Boolean).map((line) => {
    const raw = line.slice(3);
    return raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
  }).filter(Boolean);
}

function runAgent(cwd, command, args, timeout, input) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout, shell: true, input });
}

function makeIsolatedWorktree(baseSha) {
  const parent = mkdtempSync(path.join(tmpdir(), "tandem-reciprocal-implement-"));
  const worktree = path.join(parent, "worktree");
  const add = git(repo, ["worktree", "add", "--detach", worktree, baseSha]);
  if (!add.ok) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }
  return { parent, worktree };
}

function cleanupIsolatedWorktree(parent, worktree) {
  if (worktree) git(repo, ["worktree", "remove", "--force", worktree]);
  if (parent) rmSync(parent, { recursive: true, force: true });
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
  let sharedStatus;
  try {
    sharedStatus = trackedWorktreeStatus(repo);
  } catch (error) {
    die(2, { step: "shared-worktree-status", message: error.message, item: claimed.id, headBefore });
  }
  if (sharedStatus) {
    die(2, {
      step: "shared-worktree-dirty",
      message: "shared worktree has pre-existing tracked or staged changes; refusing to run an unattended implementation where ownership would be ambiguous",
      item: claimed.id,
      headBefore,
      status: sharedStatus,
    });
  }
  let isolated;
  try {
    isolated = makeIsolatedWorktree(headBefore);
  } catch (error) {
    die(2, { step: "isolate-worktree", message: error.message, item: claimed.id, headBefore });
  }
  const prompt = [
    `You are implementing wishlist item ${claimed.id} in an isolated repository worktree (cwd: ${isolated.worktree}).`,
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
  const result = runAgent(isolated.worktree, agentBin, args, maxDurationMs, prompt);
  if (result.error) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(1, { step: "agent-spawn", message: result.error.message, agent: agentBin });
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(1, {
      step: "agent-exit",
      message: `agent exited ${exitCode}`,
      agent: agentBin,
      headBefore,
      stdoutTail: String(result.stdout || "").slice(-2000),
      stderrTail: String(result.stderr || "").slice(-2000),
    });
  }
  if (workingTreeClean(isolated.worktree)) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
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
  const paths = changedPaths(isolated.worktree);
  const addResult = git(isolated.worktree, ["add", "--", ...paths]);
  if (!addResult.ok) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, { step: "git-add", message: `git add failed in isolated worktree: ${addResult.stderr}`, item: claimed.id, headBefore, paths });
  }
  const commitResult = git(isolated.worktree, ["commit", "-m", `Wishlist ${claimed.id}: ${summary}`]);
  if (!commitResult.ok) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, { step: "git-commit", message: `git commit failed in isolated worktree: ${commitResult.stderr}`, item: claimed.id, headBefore });
  }
  const isolatedHead = headSha(isolated.worktree);
  if (isolatedHead === headBefore) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, {
      step: "verify-no-commit",
      message: "git commit reported success but HEAD did not advance",
      item: claimed.id,
      headBefore,
      headAfter: isolatedHead,
    });
  }
  if (!isAncestor(isolated.worktree, headBefore, isolatedHead)) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, {
      step: "verify-descendant",
      message: "HEAD changed but the new commit is not a descendant of the pre-implementation HEAD (amend, rebase, or external HEAD move detected)",
      item: claimed.id,
      headBefore,
      headAfter: isolatedHead,
    });
  }
  if (!workingTreeClean(isolated.worktree)) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, {
      step: "verify-clean",
      message: "implementing commit was produced but the isolated working tree is still dirty",
      item: claimed.id,
      newSha: isolatedHead,
    });
  }
  const sharedHeadNow = headSha(repo);
  const sharedStatusBeforeIntegrate = trackedWorktreeStatus(repo);
  if (sharedHeadNow !== headBefore || sharedStatusBeforeIntegrate) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, {
      step: "shared-worktree-changed",
      message: "shared worktree changed while the isolated agent was running; refusing to integrate automatically",
      item: claimed.id,
      headBefore,
      sharedHeadNow,
      status: sharedStatusBeforeIntegrate,
      isolatedHead,
    });
  }
  const untrackedCollisions = paths.filter((candidate) => untrackedPaths(repo).includes(candidate));
  if (untrackedCollisions.length) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, {
      step: "shared-untracked-collision",
      message: "isolated implementation touches path(s) that already exist as untracked files in the shared worktree; refusing to overwrite ambiguous local content",
      item: claimed.id,
      headBefore,
      isolatedHead,
      paths: untrackedCollisions,
    });
  }
  const mergeResult = git(repo, ["merge", "--ff-only", isolatedHead]);
  if (!mergeResult.ok) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, { step: "integrate-commit", message: `git merge --ff-only failed: ${mergeResult.stderr}`, item: claimed.id, headBefore, isolatedHead });
  }
  cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
  const headAfter = headSha(repo);
  const newSha = headAfter;
  if (headAfter !== isolatedHead) {
    die(2, { step: "verify-integrated", message: "shared HEAD did not advance to the isolated implementation commit", item: claimed.id, headBefore, headAfter, isolatedHead });
  }
  const trackedStatusAfterIntegrate = trackedWorktreeStatus(repo);
  if (trackedStatusAfterIntegrate) {
    die(2, { step: "verify-clean", message: "shared worktree has tracked or staged changes after integrating the isolated implementation commit", item: claimed.id, newSha, status: trackedStatusAfterIntegrate });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    item: claimed.id,
    headBefore,
    headAfter,
    newSha,
    isolated: true,
    paths,
    agent: agentBin,
    exitCode,
  })}\n`);
}

main();
