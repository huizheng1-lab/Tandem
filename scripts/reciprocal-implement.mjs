#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
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
const explicitAgentBin = arg("agent-bin", process.env.TANDEM_RECIPROCAL_IMPLEMENT_BIN || "");
const explicitProvider = arg("agent-provider", process.env.TANDEM_RECIPROCAL_IMPLEMENT_PROVIDER || "");
const dryRun = boolArg("dry-run") || process.env.TANDEM_RECIPROCAL_DRY_RUN === "1";
const FAILURE_OUTPUT_TAIL_LIMIT = 6000;

function die(code, payload) {
  process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
  process.exit(code);
}

function readState() {
  if (!statePath || !existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function readClaimedItem(state = readState()) {
  if (!claimedItemId) throw new Error("claimed-item-id is required");
  const id = claimedItemId;
  let line = "";
  let text = "";
  if (state?.currentItem && state.currentItem.id === id) {
    line = `${id} | ${state.currentItem.priority || "P?"} | ${state.currentItem.text || ""}`;
    text = state.currentItem.text || "";
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

function tailBounded(text, limit = FAILURE_OUTPUT_TAIL_LIMIT) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  let start = Math.max(0, value.length - limit);
  let tail = value.slice(start);
  while (Buffer.byteLength(tail, "utf8") > limit && start < value.length) {
    start += 1;
    tail = value.slice(start);
  }
  return { text: tail, truncated: true };
}

function retryFailureFeedbackSection(state, itemId, tailLimit = FAILURE_OUTPUT_TAIL_LIMIT) {
  const failures = Array.isArray(state?.failures) ? state.failures : [];
  if (!failures.length) return "";
  const failure = failures[failures.length - 1] || {};
  const round = failures.length + 1;
  const previousAttemptCommit = failure.attemptCommit || state?.lastImplementCommit || state?.acceptedSourceSha || "unknown";
  const output = tailBounded(failure.output || "", tailLimit);
  const truncation = output.truncated
    ? `Output shown below is the tail, truncated to ${tailLimit} bytes so the item text remains visible.`
    : "Output shown below is the complete captured output.";
  return [
    "=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===",
    `Wishlist item: ${itemId}`,
    `Retry round: ${round}`,
    `Previous attempt commit: ${previousAttemptCommit}`,
    `Failed command: ${failure.command || "unknown"}`,
    `Exit code: ${Number.isInteger(failure.exitCode) ? failure.exitCode : "unknown"}`,
    truncation,
    "",
    "The previous attempt failed verification. Your first priority is to fix the reported failure below.",
    "Do not restart the item from scratch unless the failure proves the previous approach is unusable.",
    "",
    "Captured failure output:",
    "```text",
    output.text,
    "```",
    "=== END RETRY FAILURE FEEDBACK ===",
  ].join("\n");
}

function buildImplementationPrompt({ item, worktree, state, dependencyProvisioning }) {
  const retrySection = retryFailureFeedbackSection(state, item.id);
  const dependencyLine = dependencyProvisioning?.status === "linked"
    ? `Dependency self-check support: node_modules is available in this isolated worktree via ${dependencyProvisioning.strategy}.`
    : `Dependency self-check support: node_modules could not be provisioned (${dependencyProvisioning?.reason || "unknown"}), so type self-checks may be unavailable. Continue with implementation; the orchestrator remains authoritative.`;
  return [
    `You are implementing wishlist item ${item.id} in an isolated repository worktree (cwd: ${worktree}).`,
    "",
    dependencyLine,
    "Do not run npm install, npm ci, pnpm install, yarn install, or any package-manager command that mutates dependencies.",
    "",
    ...(retrySection ? [retrySection, ""] : []),
    `The item text is:`,
    item.text,
    "",
    "Inspect the repository (use file reads and directory listing) to find the existing code this item",
    "relates to. If no existing code applies, propose a minimal, isolated change in a new file that",
    "addresses the item without touching unrelated areas.",
    "",
    "Make a real code change that addresses the item. Do NOT run git yourself - a wrapper script commits",
    "your file changes after you finish. You may run only a non-authoritative syntax/type self-check such",
    "as `npm run typecheck` or `tsc --noEmit` to catch your own mistakes before finishing.",
    "",
    "Do NOT modify the wishlist file, the orchestrator state file, the relay state, or any swap/promotion",
    "machinery; the orchestrator owns those. Do NOT mark the item DONE. Do NOT run the test suite; the",
    "orchestrator runs `npm run typecheck && npm test && git diff --check` itself as the only authoritative",
    "verification after your change is committed. A self-check pass is not round success.",
    "",
    "This is a fully unattended, non-interactive run: there is no human available to answer questions.",
    "Never ask for confirmation, never present options for a human to choose between, and never pause",
    "waiting on input. Decide autonomously and proceed. If you are genuinely blocked, print `ABORT <short",
    "reason>` and exit non-zero instead of asking anything.",
    "",
    "When you finish, print exactly one line on the last stdout line: `SUMMARY: <short one-line summary of",
    "the change>`. If you cannot make a real change, print `ABORT <short reason>` and exit non-zero.",
  ].join("\n");
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
    const match = /^(?:[ MADRCU?!]{1,2})\s+(.+)$/.exec(line);
    const raw = match ? match[1] : line.slice(3);
    return raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
  }).filter(Boolean);
}

function readJson(pathname) {
  if (!pathname || !existsSync(pathname)) return null;
  return JSON.parse(readFileSync(pathname, "utf8").replace(/^\uFEFF/, ""));
}

function executorAConfig() {
  const explicitPath = arg("config-path", process.env.TANDEM_RECIPROCAL_IMPLEMENT_CONFIG || "");
  const configPath = explicitPath || (statePath ? path.join(path.dirname(statePath), "executor-a", "config.json") : "");
  return { configPath, config: readJson(configPath) };
}

function implementationConfig() {
  const explicitPath = arg("implementation-config-path", process.env.TANDEM_RECIPROCAL_IMPLEMENT_MODEL_CONFIG || "");
  const configPath = explicitPath || (statePath ? path.join(path.dirname(statePath), "reciprocal-implement-config.json") : "");
  return { configPath, config: readJson(configPath) };
}

function newestCodexFallback() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return "";
  const root = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .map((entry) => path.join(root, entry, "codex.exe"))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ candidate, mtimeMs: statSync(candidate).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.candidate || "";
}

function configuredAgent() {
  const executor = executorAConfig();
  const implementation = implementationConfig();
  const hasImplementationConfig = Boolean(implementation.config);
  const config = hasImplementationConfig ? { ...(executor.config || {}), ...implementation.config } : executor.config;
  const configPath = hasImplementationConfig ? implementation.configPath : executor.configPath;
  const configuredLeader = config?.leader || "";
  const provider = explicitProvider || (explicitAgentBin ? "custom" : configuredLeader === "codex/cli" ? "codex" : configuredLeader === "claude-code/cli" ? "claude" : "");
  if (!provider) {
    throw new Error(`Executor A leader is not a supported CLI implementation provider (leader=${configuredLeader || "missing"}, config=${configPath || "missing"}). Configure codex/cli or claude-code/cli explicitly.`);
  }
  if (!["custom", "codex", "claude"].includes(provider)) {
    throw new Error(`Unsupported reciprocal implementation provider: ${provider}`);
  }
  const bin = explicitAgentBin || (provider === "codex"
    ? config?.codexCliPath || process.env.CODEX_CLI_PATH || newestCodexFallback() || "codex"
    : config?.claudeCliPath || process.env.TANDEM_CLAUDE_BIN || "claude");
  return {
    provider,
    bin,
    config: config || {},
    configPath,
    configSource: hasImplementationConfig ? "implementation-helper" : "executor-a-fallback",
  };
}

function agentArgs(agent, cwd) {
  if (agent.provider === "codex") {
    const args = [
      "exec",
      "-C", cwd,
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
    ];
    if (agent.config.codexCliModel) args.push("-m", agent.config.codexCliModel);
    if (agent.config.codexCliReasoningEffort) args.push("-c", `model_reasoning_effort=${agent.config.codexCliReasoningEffort}`);
    args.push("-");
    return args;
  }
  return [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash",
    "--system-prompt", "Implement the wishlist item by editing files. Be terse. This is a headless, unattended run: never ask questions or wait for confirmation; decide autonomously. Do not use git. Bash is allowed only for non-authoritative syntax/type self-checks such as npm run typecheck or tsc --noEmit; do not run package-manager install commands or the full test suite. A wrapper commits your changes afterward.",
  ];
}

function runAgent(cwd, agent, args, timeout, input) {
  const shell = agent.provider === "custom" || (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(agent.bin));
  return spawnSync(agent.bin, args, { cwd, encoding: "utf8", windowsHide: true, timeout, shell, input, maxBuffer: 64 * 1024 * 1024 });
}

function summaryFromOutput(provider, output, fallback) {
  if (provider === "codex") {
    const messages = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) messages.push(event.item.text);
      } catch {}
    }
    const summary = messages.reverse().map((message) => message.match(/SUMMARY:\s*(.+)/)?.[1]?.trim()).find(Boolean);
    return (summary || fallback).slice(0, 200);
  }
  const summaryMatch = output.match(/SUMMARY:\s*(.+)/);
  return (summaryMatch ? summaryMatch[1].trim() : fallback).slice(0, 200);
}

function makeIsolatedWorktree(baseSha) {
  const parent = mkdtempSync(path.join(tmpdir(), "tandem-reciprocal-implement-"));
  const worktree = path.join(parent, "worktree");
  const add = git(repo, ["worktree", "add", "--detach", worktree, baseSha]);
  if (!add.ok) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }
  const dependencyProvisioning = provisionIsolatedDependencies(worktree);
  return { parent, worktree, dependencyProvisioning };
}

function provisionIsolatedDependencies(worktree) {
  const source = path.join(repo, "node_modules");
  const target = path.join(worktree, "node_modules");
  if (!existsSync(source)) {
    return { status: "missing", strategy: "none", source, target, reason: "source node_modules not found" };
  }
  if (existsSync(target)) {
    return { status: "present", strategy: "existing", source, target };
  }
  const strategy = process.platform === "win32" ? "junction" : "symlink";
  try {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return { status: "linked", strategy, source, target };
  } catch (error) {
    return { status: "degraded", strategy, source, target, reason: error.message };
  }
}

function removeIsolatedDependencyLink(worktree) {
  if (!worktree) return;
  const target = path.join(worktree, "node_modules");
  if (!existsSync(target)) return;
  const unlinkDependency = () => {
    try {
      unlinkSync(target);
      return;
    } catch (error) {
      try {
        rmSync(target, { force: true });
        return;
      } catch {
        throw new Error(`refusing to delete isolated worktree parent because dependency junction could not be unlinked first: ${error.message}`);
      }
    }
  };
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      unlinkDependency();
      return;
    }
  } catch {}
  try {
    const source = path.join(repo, "node_modules");
    if (existsSync(source) && realpathSync(target) === realpathSync(source)) unlinkDependency();
  } catch {}
}

function cleanupIsolatedWorktree(parent, worktree) {
  removeIsolatedDependencyLink(worktree);
  if (worktree) git(repo, ["worktree", "remove", "--force", worktree]);
  if (parent) rmSync(parent, { recursive: true, force: true });
}

function main() {
  const state = readState();
  let claimed;
  try {
    claimed = readClaimedItem(state);
  } catch (error) {
    die(2, { step: "read-claimed-item", message: error.message });
  }
  const headBefore = headSha(repo);
  if (dryRun) {
    let agent;
    try {
      agent = configuredAgent();
    } catch (error) {
      die(2, { step: "resolve-agent", message: error.message, item: claimed.id, headBefore });
    }
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, item: claimed.id, headBefore, agent: agent.bin, provider: agent.provider, configPath: agent.configPath || null, configSource: agent.configSource })}\n`);
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
  let agent;
  try {
    agent = configuredAgent();
  } catch (error) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(2, { step: "resolve-agent", message: error.message, item: claimed.id, headBefore });
  }
  const prompt = buildImplementationPrompt({ item: claimed, worktree: isolated.worktree, state, dependencyProvisioning: isolated.dependencyProvisioning });
  const args = agentArgs(agent, isolated.worktree);
  const result = runAgent(isolated.worktree, agent, args, maxDurationMs, prompt);
  if (result.error) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(1, { step: "agent-spawn", message: result.error.message, agent: agent.bin, provider: agent.provider });
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    cleanupIsolatedWorktree(isolated.parent, isolated.worktree);
    die(1, {
      step: "agent-exit",
      message: `agent exited ${exitCode}`,
      agent: agent.bin,
      provider: agent.provider,
      configSource: agent.configSource,
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
  const summary = summaryFromOutput(agent.provider, out, `${claimed.id}: ${claimed.text}`);
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
    dependencyProvisioning: isolated.dependencyProvisioning,
    agent: agent.bin,
    provider: agent.provider,
    configSource: agent.configSource,
    exitCode,
  })}\n`);
}

main();
