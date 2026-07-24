import { mkdir, mkdtemp, readFile, rm, stat, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
const directionPath = path.join(relayRoot, "control", "WISHLIST.md");
const worktreeA = path.join(relayRoot, "worktrees", "copy-a");
const worktreeB = path.join(relayRoot, "worktrees", "copy-b");
const branchA = "codex/reciprocal-a";
const branchB = "codex/reciprocal-b";
const stableRef = "refs/tandem-relay/stable";
const transactionPath = path.join(repoRoot, ".git", "tandem-relay", "main-update-transaction.json");

if (!comment) throw new Error("A human comment is required for a main update.");

async function command(file, args, cwd = repoRoot, reject = true) {
  const result = await execa(file, args, { cwd, reject, all: true });
  return { ok: result.exitCode === 0, exitCode: result.exitCode, output: String(result.all || "").trimEnd() };
}

async function git(args, cwd = repoRoot, reject = true) {
  return command("git", args, cwd, reject);
}

async function gitText(args, cwd = repoRoot) {
  return (await git(args, cwd)).output.trim();
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readRelayState() {
  return readJson(statePath);
}

async function writeRelayState(state, summary) {
  await writeJson(statePath, {
    ...state,
    lastSummary: summary || state.lastSummary || null,
    updatedAt: new Date().toISOString(),
  });
}

async function pauseRelayState(summary) {
  const state = await readRelayState();
  if (state.activeRole || state.candidateCommit || state.rollbackCommit) {
    throw new Error("Cannot pause main update gate while a reciprocal turn has active work.");
  }
  await writeRelayState({
    ...state,
    phase: "paused",
    pausedFromPhase: state.phase || "idle",
    pauseOrigin: "human",
    pauseReasonCode: "explicit-human-pause",
  }, summary);
}

async function reconcileMainState(newStableCommit, summary) {
  await git(["update-ref", stableRef, newStableCommit]);
  const state = await readRelayState();
  if (state.activeRole || state.candidateCommit || state.rollbackCommit) {
    throw new Error("Cannot reconcile main while reciprocal state has active work.");
  }
  await writeRelayState({
    ...state,
    stableCommit: newStableCommit,
    lastCompletedCommit: newStableCommit,
    baseCommit: null,
    rollbackCommit: null,
    candidateCommit: null,
    candidateKind: null,
  }, summary);
}

async function resumeRelayState(summary) {
  const state = await readRelayState();
  if (state.activeRole || state.candidateCommit || state.rollbackCommit) {
    throw new Error("Cannot resume main update gate while a reciprocal turn has active work.");
  }
  if (state.phase !== "paused") return state;
  const nextTurn = Number.isFinite(Number(state.turn)) ? Number(state.turn) + 1 : state.turn;
  const resumeCount = Number.isFinite(Number(state.resumeCount)) ? Number(state.resumeCount) + 1 : 1;
  await writeRelayState({
    ...state,
    phase: state.pausedFromPhase || "idle",
    pausedFromPhase: null,
    pauseOrigin: null,
    pauseReasonCode: null,
    pauseAfterTurn: false,
    resumeCount,
    resumeTurn: nextTurn,
    turn: nextTurn,
  }, summary);
  return readRelayState();
}

async function readTransaction() {
  try {
    const parsed = JSON.parse((await readFile(transactionPath, "utf8")).replace(/^\uFEFF/, ""));
    validateTransaction(parsed);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Invalid main-update transaction state at ${transactionPath}: ${error.message}`);
  }
}

function validateTransaction(value) {
  const allowed = new Set(["merged-not-pushed", "tagged-not-pushed", "pushed-not-synced"]);
  if (!value || value.schemaVersion !== 1) throw new Error("missing schemaVersion=1");
  if (!allowed.has(value.stage)) throw new Error(`unsupported stage ${value.stage || "missing"}`);
  for (const key of ["beforeMaster", "masterSha", "stableSha"]) {
    if (!/^[0-9a-f]{40,64}$/i.test(String(value[key] || ""))) throw new Error(`missing or invalid ${key}`);
  }
  if (value.stage !== "merged-not-pushed" && !/^main-update-\d{3,}$/.test(String(value.tag || ""))) {
    throw new Error("missing or invalid tag");
  }
}

async function resumePushedSync(transaction, adminDirtyBefore) {
  result.stage = "branch-sync";
  await git(["merge", "--ff-only", transaction.masterSha], worktreeA);
  maybeFault("after-copy-a");
  await git(["merge", "--ff-only", transaction.masterSha], worktreeB);
  maybeFault("after-copy-b");
  await reconcileMainState(transaction.masterSha, `Resumed ${transaction.tag}: ${comment}`);
  maybeFault("after-relay");
  result.branchesResynced = true;
  if (transaction.resumeRequired) {
    const relayState = await readRelayState();
    if (relayState.phase === "paused" && relayState.pausedFromPhase === "idle" && relayState.pauseOrigin === "human" && relayState.pauseReasonCode === "explicit-human-pause" && !relayState.activeRole && !relayState.candidateCommit && relayState.stableCommit === transaction.masterSha) {
      await resumeRelayState(`Completed ${transaction.tag}; reciprocal branches synchronized with master.`);
      result.relayResumed = true;
    } else if (relayState.phase === "idle" && !relayState.activeRole && !relayState.candidateCommit && relayState.stableCommit === transaction.masterSha) {
      result.relayResumed = true;
    } else {
      throw new Error(`Cannot resume ${transaction.tag}: relay no longer matches its durable main-update pause.`);
    }
  }
  result.adminDirtyAfter = await dirtyAdminSnapshot();
  assertSnapshotsEqual(adminDirtyBefore, result.adminDirtyAfter);
  await updateLocalMasterIfClean(transaction.beforeMaster, transaction.masterSha, adminDirtyBefore);
  result.stage = "complete";
  result.ok = true;
  maybeFault("before-cleanup");
  await clearTransaction();
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

async function ensureTransactionTag(transaction) {
  if (transaction.stage !== "merged-not-pushed") return transaction;
  result.stage = "tag";
  const previousTag = (await gitText(["tag", "--merged", transaction.beforeMaster, "--list", "main-update-*", "--sort=-version:refname"]))
    .split(/\r?\n/).filter(Boolean)[0] || "";
  const tag = await nextTag();
  const wishlist = await wishlistIds(previousTag, transaction.masterSha);
  result.tag = tag;
  result.wishlistIds = wishlist;
  result.timestamp = new Date().toISOString();
  const message = [
    `Tandem reciprocal main update ${tag}`,
    "",
    `Stable SHA: ${transaction.stableSha}`,
    "Relay turn: resumed",
    `Wishlist items: ${wishlist.join(", ") || "none"}`,
    `Timestamp: ${result.timestamp}`,
    `Human comment: ${comment}`,
  ].join("\n");
  await git(["tag", "-a", tag, "-m", message, transaction.masterSha]);
  const next = { ...transaction, stage: "tagged-not-pushed", tag, createdAt: transaction.createdAt || new Date().toISOString() };
  await writeTransaction(next);
  return next;
}

async function pushTaggedTransaction(transaction, adminDirtyBefore) {
  result.stage = "push";
  result.tag = transaction.tag;
  const localTag = await gitText(["rev-parse", `${transaction.tag}^{}`]);
  if (localTag !== transaction.masterSha) throw new Error(`Transaction tag ${transaction.tag} points at ${localTag}, expected ${transaction.masterSha}.`);
  const push = await git(["push", "--atomic", "origin", `${transaction.masterSha}:refs/heads/master`, `refs/tags/${transaction.tag}:refs/tags/${transaction.tag}`], repoRoot, false);
  result.pushOutput = push.output;
  if (!push.ok) throw new Error(`Master/tag push failed without force: ${push.output}`);
  result.pushed = true;
  if (adminDirtyBefore) {
    result.adminDirtyAfterPush = await dirtyAdminSnapshot();
    assertSnapshotsEqual(adminDirtyBefore, result.adminDirtyAfterPush);
  }
  const next = { ...transaction, stage: "pushed-not-synced" };
  await writeTransaction(next);
  return next;
}

async function verifyPushedTransaction(transaction) {
  const [remoteMaster, tagSha] = await Promise.all([
    gitText(["ls-remote", "origin", "refs/heads/master"]).then((text) => text.split(/\s+/)[0] || ""),
    gitText(["rev-parse", `${transaction.tag}^{}`]),
  ]);
  if (remoteMaster !== transaction.masterSha) {
    throw new Error(`Cannot resume pushed-not-synced transaction: origin/master is ${remoteMaster || "missing"}, expected ${transaction.masterSha}.`);
  }
  if (tagSha !== transaction.masterSha) {
    throw new Error(`Cannot resume pushed-not-synced transaction: tag ${transaction.tag} points at ${tagSha}, expected ${transaction.masterSha}.`);
  }
}

function maybeFault(stage) {
  if (process.env.TANDEM_MAIN_UPDATE_FAULT_STAGE === stage) {
    throw new Error(`Injected main-update fault at ${stage}`);
  }
}

function statusPath(line) {
  const value = line.slice(3).trim();
  const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
  return renamed.replace(/^"|"$/g, "");
}

async function dirtyAdminSnapshot() {
  const status = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).output
    .split(/\r?\n/)
    .filter(Boolean);
  const staged = (await git(["diff", "--cached", "--name-status"], repoRoot, false)).output
    .split(/\r?\n/)
    .filter(Boolean);
  const indexEntries = (await git(["ls-files", "--stage", "-z"], repoRoot, false)).output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([0-9a-f]{40,64})\s+(\d)\t(.+)$/);
      return match ? { mode: match[1], object: match[2], stage: match[3], path: match[4] } : { raw: line };
    });
  const entries = [];
  for (const line of status) {
    const file = statusPath(line);
    const fullPath = path.join(repoRoot, file);
    let exists = false;
    let bytes = null;
    let sha256 = null;
    let kind = "missing";
    try {
      const info = await stat(fullPath);
      exists = true;
      kind = info.isDirectory() ? "directory" : "file";
      if (info.isFile()) {
        const content = await readFile(fullPath);
        bytes = content.byteLength;
        sha256 = createHash("sha256").update(content).digest("hex").toUpperCase();
      }
    } catch {
      exists = false;
    }
    entries.push({ status: line.slice(0, 2), path: file, exists, kind, bytes, sha256 });
  }
  return { porcelain: status, staged, indexEntries, entries };
}

function assertSnapshotsEqual(before, after) {
  const beforeText = JSON.stringify(before);
  const afterText = JSON.stringify(after);
  if (beforeText !== afterText) {
    throw new Error("Dirty admin preservation check failed: before/after status or byte hashes changed.");
  }
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
  const [dirtyA, dirtyB] = await Promise.all([
    gitText(["status", "--porcelain=v1", "--untracked-files=all"], worktreeA),
    gitText(["status", "--porcelain=v1", "--untracked-files=all"], worktreeB),
  ]);
  if (dirtyA || dirtyB) {
    throw new Error(`Reciprocal worktrees must be clean before main update; A=${dirtyA || "clean"}, B=${dirtyB || "clean"}.`);
  }
  const trackedEnv = await git(["ls-files", "--error-unmatch", ".env"], repoRoot, false);
  if (trackedEnv.ok) throw new Error(".env is tracked; remove it from git before any remote push.");
  return { state, stableSha, wasPaused: state.phase === "paused", adminDirtyBefore: await dirtyAdminSnapshot() };
}

function tail(value, count = 18) {
  return String(value || "").split(/\r?\n/).slice(-count).join("\n");
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function writeTransaction(value) {
  await writeFile(transactionPath, JSON.stringify(value, null, 2), "utf8");
}

async function clearTransaction() {
  await unlink(transactionPath).catch(() => {});
}

async function updateLocalMasterIfClean(beforeMaster, masterSha, adminDirtyBefore) {
  if (adminDirtyBefore.porcelain.length) {
    result.localMasterDeferred = true;
    return;
  }
  await git(["update-ref", "refs/heads/master", masterSha, beforeMaster]);
  result.localMasterUpdated = true;
}

async function validateStable(stableSha) {
  const validationHead = await gitText(["rev-parse", "HEAD"], worktreeA);
  if (validationHead !== stableSha) throw new Error(`Validation worktree moved from stable: ${validationHead}.`);
  const typecheck = await command("npm.cmd", ["run", "typecheck"], worktreeA);
  const tests = await command("npm.cmd", ["test"], worktreeA);
  return { workspace: worktreeA, typecheck: tail(typecheck.output), tests: tail(tests.output) };
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
  const existingTransaction = await readTransaction();
  if (existingTransaction) {
    result.stage = `resume-${existingTransaction.stage}`;
    Object.assign(result, {
      resumedTransaction: true,
      beforeMaster: existingTransaction.beforeMaster,
      masterSha: existingTransaction.masterSha,
      stableSha: existingTransaction.stableSha,
      tag: existingTransaction.tag,
    });
    const adminDirtyBefore = await dirtyAdminSnapshot();
    result.adminDirtyBefore = adminDirtyBefore;
    let transaction = existingTransaction;
    transaction = await ensureTransactionTag(transaction);
    if (transaction.stage === "tagged-not-pushed") transaction = await pushTaggedTransaction(transaction, adminDirtyBefore);
    await verifyPushedTransaction(transaction);
    maybeFault("after-push");
    await resumePushedSync(transaction, adminDirtyBefore);
  }
  const { state, stableSha, wasPaused, adminDirtyBefore } = await assertPreconditions();
  result.stableSha = stableSha;
  result.adminDirtyBefore = adminDirtyBefore;
  result.turn = state.turn;
  if (!wasPaused) {
    await pauseRelayState(`Human main update gate for stable ${stableSha.slice(0, 7)}`);
    result.pausedByFlow = true;
  }

  result.stage = "validation";
  maybeFault("before-push");
  result.checks = await validateStable(stableSha);

  result.stage = "isolated-merge";
  const beforeMaster = await gitText(["rev-parse", "master"]);
  result.beforeMaster = beforeMaster;
  let tempWorktree = "";
  let tempBranch = "";
  try {
    tempWorktree = await mkdtemp(path.join(tmpdir(), "reciprocal-main-update-"));
    tempBranch = `reciprocal-main-update-${Date.now()}-${process.pid}`;
    await git(["worktree", "add", "--detach", tempWorktree, beforeMaster]);
    result.integrationWorktree = tempWorktree;
    result.integrationBase = beforeMaster;
  if (await isAncestor(beforeMaster, stableSha)) {
    await git(["merge", "--ff-only", stableSha], tempWorktree);
    result.mergeMode = "fast-forward";
  } else if (await isAncestor(stableSha, beforeMaster)) {
    result.mergeMode = "master-already-contained-stable";
  } else {
    const merge = await git(["merge", "--no-edit", stableSha], tempWorktree, false);
    if (!merge.ok) {
      await git(["merge", "--abort"], tempWorktree, false);
      throw new Error(`Isolated stable merge conflict: ${merge.output}`);
    }
    result.mergeMode = "merge-commit";
  }
  result.masterSha = await gitText(["rev-parse", "HEAD"], tempWorktree);
  await writeTransaction({
    schemaVersion: 1,
    stage: "merged-not-pushed",
    beforeMaster,
    masterSha: result.masterSha,
    stableSha,
    resumeRequired: result.pausedByFlow,
    createdAt: new Date().toISOString(),
  });
  } finally {
    if (tempWorktree) {
      const resolved = path.resolve(tempWorktree);
      if (!isInside(tmpdir(), resolved)) throw new Error(`Refusing to remove unexpected integration worktree path: ${resolved}`);
      await git(["worktree", "remove", "--force", tempWorktree], repoRoot, false);
      await rm(tempWorktree, { recursive: true, force: true }).catch(() => {});
    }
  }
  result.masterUpdated = result.masterSha !== beforeMaster || result.mergeMode === "master-already-contained-stable";

  result.stage = "tag";
  const previousTag = (await gitText(["tag", "--merged", beforeMaster, "--list", "main-update-*", "--sort=-version:refname"]))
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
  await writeTransaction({
    schemaVersion: 1,
    stage: "tagged-not-pushed",
    beforeMaster,
    masterSha: result.masterSha,
    stableSha,
    tag: result.tag,
    resumeRequired: result.pausedByFlow,
    createdAt: new Date().toISOString(),
  });

  result.stage = "push";
  const push = await git(["push", "--atomic", "origin", `${result.masterSha}:refs/heads/master`, `refs/tags/${result.tag}:refs/tags/${result.tag}`], repoRoot, false);
  result.pushOutput = push.output;
  if (!push.ok) throw new Error(`Master/tag push failed without force: ${push.output}`);
  result.pushed = true;
  result.adminDirtyAfterPush = await dirtyAdminSnapshot();
  assertSnapshotsEqual(adminDirtyBefore, result.adminDirtyAfterPush);
  await writeTransaction({
    schemaVersion: 1,
    stage: "pushed-not-synced",
    beforeMaster,
    masterSha: result.masterSha,
    stableSha,
    tag: result.tag,
    resumeRequired: result.pausedByFlow,
    createdAt: new Date().toISOString(),
  });
  maybeFault("after-push");
  await updateLocalMasterIfClean(beforeMaster, result.masterSha, adminDirtyBefore);

  result.stage = "branch-sync";
  await git(["merge", "--ff-only", result.masterSha], worktreeA);
  maybeFault("after-copy-a");
  await git(["merge", "--ff-only", result.masterSha], worktreeB);
  maybeFault("after-copy-b");
  await reconcileMainState(result.masterSha, `Reconciled at ${result.tag}: ${comment}`);
  maybeFault("after-relay");
  result.branchesResynced = true;
  result.adminDirtyAfter = await dirtyAdminSnapshot();
  assertSnapshotsEqual(adminDirtyBefore, result.adminDirtyAfter);

  result.stage = "resume";
  if (result.pausedByFlow) {
    await resumeRelayState(`Completed ${result.tag}; reciprocal branches synchronized with master.`);
    result.relayResumed = true;
  }
  result.stage = "complete";
  result.ok = true;
  maybeFault("before-cleanup");
  await clearTransaction();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  result.error = error.message;
  if (!result.pushed && result.tag) {
    await git(["tag", "-d", result.tag], repoRoot, false).catch(() => {});
  }
  if (result.localMasterUpdated && result.beforeMaster) {
    await git(["update-ref", "refs/heads/master", result.beforeMaster, result.masterSha], repoRoot, false).catch(() => {});
    result.localMasterRolledBack = true;
  }
  if (!result.pushed) {
    await clearTransaction();
  }
  if (result.pausedByFlow && !result.masterUpdated) {
    try {
      await resumeRelayState(`Main update stopped safely during ${result.stage}: ${error.message}`);
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
