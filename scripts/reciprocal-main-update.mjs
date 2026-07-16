import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    values[key.slice(2)] = argv[index + 1] || "";
    index += 1;
  }
  return values;
}

const options = argumentsFrom(process.argv.slice(2));
const repoRoot = path.resolve(options.repo || process.cwd());
const relayRoot = path.resolve(options["relay-root"] || path.join(repoRoot, "..", "Tandem Reciprocal"));
const comment = String(options.comment || "").trim();
const statePath = path.join(repoRoot, ".git", "tandem-relay", "state.json");
const directionPath = path.join(relayRoot, "control", "SHARED_DIRECTION.md");
const relayScript = path.join(repoRoot, "scripts", "reciprocal-relay.ps1");
const worktreeA = path.join(relayRoot, "worktrees", "copy-a");
const worktreeB = path.join(relayRoot, "worktrees", "copy-b");
const branchA = "codex/reciprocal-a";
const branchB = "codex/reciprocal-b";
const stableRef = "refs/tandem-relay/stable";

if (!comment) throw new Error("A human comment is required for a main update.");

async function command(file, args, cwd = repoRoot, reject = true) {
  const result = await execa(file, args, { cwd, reject, all: true });
  return { ok: result.exitCode === 0, exitCode: result.exitCode, output: String(result.all || "").trim() };
}

async function git(args, cwd = repoRoot, reject = true) {
  return command("git", args, cwd, reject);
}

async function gitText(args, cwd = repoRoot) {
  return (await git(args, cwd)).output.trim();
}

async function relay(action, extra = []) {
  const result = await command("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", relayScript,
    "-Action", action, "-Workspace", worktreeB, ...extra,
  ]);
  return JSON.parse(result.output.replace(/^\uFEFF/, ""));
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function statusPath(line) {
  const value = line.slice(3).trim();
  const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
  return renamed.replace(/^"|"$/g, "");
}

function isKnownNonFeaturePath(file) {
  const normalized = file.replaceAll("\\", "/");
  return normalized === "scripts/reciprocal-direction.ps1"
    || normalized === "IMPROVEMENT_SUGGESTIONS.md"
    || normalized === "process/LEADER_WORKER_WORKFLOW.md"
    || /^\.reviewer-.*\.mjs$/.test(normalized)
    || /^handoffs\/HANDOFF_D\d+\.md$/.test(normalized)
    || /^handoffs\/D\d+_done\.txt$/.test(normalized)
    || /^release-d98(?:-|\/|$)/.test(normalized)
    || /^scripts\/d\d+-(?:evidence|smoke)\.mjs$/.test(normalized)
    || /^scripts\/live-.*\.(?:ts|mjs)$/.test(normalized)
    || normalized === "scripts/handoff-trigger-watch.ps1"
    || normalized === "scripts/register-handoff-trigger-watch.ps1";
}

async function assertPreconditions() {
  const state = await readJson(statePath);
  if (state.activeRole || ["working", "validating", "rollback-verification"].includes(state.phase)) {
    throw new Error(`Relay turn ${state.turn} is active (${state.phase}, owner ${state.activeRole || "unknown"}). Wait for it to finish before updating master.`);
  }
  if (!["idle", "paused"].includes(state.phase)) {
    throw new Error(`Relay phase must be idle or paused; current phase is ${state.phase || "unknown"}.`);
  }
  if (state.candidateCommit || state.rollbackCommit) {
    throw new Error("A candidate or rollback is still pending; validate it before updating master.");
  }
  const currentBranch = await gitText(["branch", "--show-current"]);
  if (currentBranch !== "master") throw new Error(`Admin repository must be on master; current branch is ${currentBranch || "detached"}.`);
  const stableSha = await gitText(["rev-parse", `${stableRef}^{commit}`]);
  const [headA, headB] = await Promise.all([
    gitText(["rev-parse", branchA]),
    gitText(["rev-parse", branchB]),
  ]);
  if (headA !== stableSha || headB !== stableSha) {
    throw new Error(`Reciprocal branches must both equal stable ${stableSha.slice(0, 7)}; A=${headA.slice(0, 7)}, B=${headB.slice(0, 7)}.`);
  }
  const dirty = (await gitText(["status", "--porcelain=v1", "--untracked-files=all"]))
    .split(/\r?\n/).filter(Boolean)
    .map(statusPath).filter((file) => !isKnownNonFeaturePath(file));
  if (dirty.length) throw new Error(`Admin repository has feature-file modifications: ${dirty.join(", ")}`);
  const trackedEnv = await git(["ls-files", "--error-unmatch", ".env"], repoRoot, false);
  if (trackedEnv.ok) throw new Error(".env is tracked; remove it from git before any remote push.");
  return { state, stableSha, wasPaused: state.phase === "paused" };
}

function tail(value, count = 18) {
  return String(value || "").split(/\r?\n/).slice(-count).join("\n");
}

async function validateStable(stableSha) {
  const validationRoot = path.resolve(relayRoot, "state", `main-update-validation-${process.pid}`);
  const stateRoot = path.resolve(relayRoot, "state");
  if (!validationRoot.startsWith(`${stateRoot}${path.sep}`)) throw new Error("Validation path escaped reciprocal state root.");
  await git(["worktree", "add", "--detach", validationRoot, stableSha]);
  try {
    await symlink(path.join(repoRoot, "node_modules"), path.join(validationRoot, "node_modules"), "junction");
    const typecheck = await command("npm.cmd", ["run", "typecheck"], validationRoot);
    const tests = await command("npm.cmd", ["test"], validationRoot);
    return { typecheck: tail(typecheck.output), tests: tail(tests.output) };
  } finally {
    await git(["worktree", "remove", "--force", validationRoot], repoRoot, false);
    await rm(validationRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function isAncestor(ancestor, descendant) {
  return (await git(["merge-base", "--is-ancestor", ancestor, descendant], repoRoot, false)).ok;
}

async function nextTag() {
  const tags = (await gitText(["tag", "--list", "main-update-*"]))
    .split(/\r?\n/).filter(Boolean);
  const highest = tags.reduce((value, tag) => {
    const match = tag.match(/^main-update-(\d+)$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `main-update-${String(highest + 1).padStart(3, "0")}`;
}

async function wishlistIds(previousTag, targetSha) {
  const direction = await readFile(directionPath, "utf8").catch(() => "");
  const items = [...direction.matchAll(/^- \[x\] (W\d+) \|.*?\| DONE stable=([0-9a-f]{7,40})/gm)];
  const included = [];
  for (const [, id, itemSha] of items) {
    const valid = await git(["cat-file", "-e", `${itemSha}^{commit}`], repoRoot, false);
    if (!valid.ok || !(await isAncestor(itemSha, targetSha))) continue;
    if (previousTag && await isAncestor(itemSha, previousTag)) continue;
    included.push(id);
  }
  return included;
}

const result = {
  ok: false,
  stage: "preconditions",
  pausedByFlow: false,
  masterUpdated: false,
  pushed: false,
  branchesResynced: false,
  relayResumed: false,
};

try {
  const { state, stableSha, wasPaused } = await assertPreconditions();
  result.stableSha = stableSha;
  result.turn = state.turn;
  if (!wasPaused) {
    await relay("Pause", ["-Summary", `Human main update gate for stable ${stableSha.slice(0, 7)}`]);
    result.pausedByFlow = true;
  }

  result.stage = "validation";
  result.checks = await validateStable(stableSha);

  result.stage = "merge";
  const beforeMaster = await gitText(["rev-parse", "master"]);
  if (await isAncestor(beforeMaster, stableSha)) {
    await git(["merge", "--ff-only", stableSha]);
    result.mergeMode = "fast-forward";
  } else if (await isAncestor(stableSha, beforeMaster)) {
    result.mergeMode = "master-already-contained-stable";
  } else {
    const merge = await git(["merge", "--no-edit", stableSha], repoRoot, false);
    if (!merge.ok) {
      await git(["merge", "--abort"], repoRoot, false);
      throw new Error(`Stable merge failed: ${merge.output}`);
    }
    result.mergeMode = "merge-commit";
  }
  result.masterSha = await gitText(["rev-parse", "master"]);
  result.masterUpdated = result.masterSha !== beforeMaster || result.mergeMode === "master-already-contained-stable";

  result.stage = "tag";
  const previousTag = (await gitText(["tag", "--merged", "master", "--list", "main-update-*", "--sort=-version:refname"]))
    .split(/\r?\n/).filter(Boolean)[0] || "";
  result.tag = await nextTag();
  result.wishlistIds = await wishlistIds(previousTag, result.masterSha);
  result.timestamp = new Date().toISOString();
  const message = [
    `Tandem reciprocal main update ${result.tag}`,
    "",
    `Stable SHA: ${stableSha}`,
    `Relay turn: ${state.turn}`,
    `Wishlist items: ${result.wishlistIds.join(", ") || "none"}`,
    `Timestamp: ${result.timestamp}`,
    `Human comment: ${comment}`,
  ].join("\n");
  await git(["tag", "-a", result.tag, "-m", message, result.masterSha]);

  result.stage = "push";
  const push = await git(["push", "--atomic", "origin", "master:refs/heads/master", `refs/tags/${result.tag}:refs/tags/${result.tag}`], repoRoot, false);
  result.pushOutput = push.output;
  if (!push.ok) throw new Error(`Master/tag push failed without force: ${push.output}`);
  result.pushed = true;

  result.stage = "branch-sync";
  await git(["merge", "--ff-only", result.masterSha], worktreeA);
  await git(["merge", "--ff-only", result.masterSha], worktreeB);
  await relay("ReconcileMain", ["-NewStableCommit", result.masterSha, "-Summary", `Reconciled at ${result.tag}: ${comment}`]);
  result.branchesResynced = true;

  result.stage = "resume";
  if (result.pausedByFlow) {
    await relay("Resume", ["-Summary", `Completed ${result.tag}; reciprocal branches synchronized with master.`]);
    result.relayResumed = true;
  }
  result.stage = "complete";
  result.ok = true;
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  result.error = error.message;
  if (result.pausedByFlow && !result.masterUpdated) {
    try {
      await relay("Resume", ["-Summary", `Main update stopped safely during ${result.stage}: ${error.message}`]);
      result.relayResumed = true;
    } catch (resumeError) {
      result.resumeError = resumeError.message;
    }
  }
  const remaining = [];
  if (result.masterUpdated && !result.pushed) remaining.push("verify and push master plus the annotated tag");
  if (result.pushed && !result.branchesResynced) remaining.push("fast-forward both reciprocal branches and update the stable ref/state");
  if (result.pausedByFlow && !result.relayResumed) remaining.push("resume the relay after reconciliation is coherent");
  result.remaining = remaining;
  process.stderr.write(JSON.stringify(result));
  process.exitCode = 1;
}
