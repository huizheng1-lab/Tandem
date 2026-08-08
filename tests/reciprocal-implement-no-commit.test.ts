import { mkdir, mkdtemp, readFile, readdir, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;
const script = path.resolve("scripts/reciprocal-orchestrator.mjs");
const implementScript = path.resolve("scripts/reciprocal-implement.mjs");
const auditScript = path.resolve("scripts/reciprocal-false-completion-audit.mjs");
const PROCESS_SPAWNING_TEST_TIMEOUT_MS = 60_000;

vi.setConfig({ testTimeout: PROCESS_SPAWNING_TEST_TIMEOUT_MS });

async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `tandem-d200-${name}-`));
  const relayRoot = path.join(root, "relay");
  await mkdir(path.join(relayRoot, "control"), { recursive: true });
  await mkdir(path.join(relayRoot, "state"), { recursive: true });
  await writeFile(
    path.join(relayRoot, "control", "WISHLIST.md"),
    [
      "# Wishlist",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W9001 | P0 | Concrete acceptance: implement and verify file evidence/D200-acceptance.txt exists | QUEUED added=now acceptance=evidence/D200-acceptance.txt",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(relayRoot, "state", "orchestrator-state.json"),
    JSON.stringify({
      phase: "idle",
      currentItem: null,
      consecutiveFailures: 0,
      step: null,
      stableCommit: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      lastSummary: "fixture",
      failures: [],
    }, null, 2),
    "utf8",
  );
  await execa("git", ["init", "--initial-branch=master", root]);
  await execa("git", ["-C", root, "config", "user.email", "test@tandem"]);
  await execa("git", ["-C", root, "config", "user.name", "test"]);
  await execa("git", ["-C", root, "commit", "--allow-empty", "-m", "fixture base"]);
  return { root, relayRoot };
}

function commandsLogPath(root: string) {
  return path.join(root, "commands.ndjson");
}

function readOnlyImplementStub(root: string) {
  const stub = path.join(root, "stub-readonly.cjs");
  const log = commandsLogPath(root);
  const lines = [
    "const fs = require('fs');",
    "const log = process.argv[2];",
    "fs.appendFileSync(log, JSON.stringify({label:'implement'}) + '\\n');",
    "process.exit(0);",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}" "${log}"`;
}

function descendantBreakingImplementStub(root: string) {
  const stub = path.join(root, "stub-detach.cjs");
  const log = commandsLogPath(root);
  const lines = [
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const root = ${JSON.stringify(root)};`,
    `const log = ${JSON.stringify(log)};`,
    "fs.appendFileSync(log, JSON.stringify({label:'implement'}) + '\\n');",
    "cp.execFileSync('git', ['-C', root, 'checkout', '--orphan', 'detached-' + Date.now()], {stdio:'ignore'});",
    "cp.execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'detached stub'], {stdio:'ignore'});",
    "process.exit(0);",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

function implementingStub(root: string, label: string, acceptancePath: string) {
  const stub = path.join(root, `${label}.cjs`);
  const log = commandsLogPath(root);
  const lines = [
    "const fs = require('fs');",
    "const cp = require('child_process');",
    "const path = require('path');",
    `const root = ${JSON.stringify(root)};`,
    `const log = ${JSON.stringify(log)};`,
    `const acceptance = ${JSON.stringify(path.join(root, acceptancePath))};`,
    "fs.appendFileSync(log, JSON.stringify({label:'implement'}) + '\\n');",
    "fs.mkdirSync(path.dirname(acceptance), { recursive: true });",
    "fs.writeFileSync(acceptance, 'D200 acceptance satisfied: ' + new Date().toISOString() + '\\n');",
    "cp.execFileSync('git', ['-C', root, 'add', '-A'], {stdio:'ignore'});",
    `cp.execFileSync('git', ['-C', root, 'commit', '-m', 'D200-N: implements acceptance', '--allow-empty'], {stdio:'ignore'});`,
    "process.exit(0);",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

function isolatedAgentStub(root: string, label: string, relativePath = "evidence/D202-isolated.txt") {
  const stub = path.join(root, `${label}.agent.cjs`);
  const lines = [
    "const fs = require('fs');",
    "const path = require('path');",
    `const target = path.join(process.cwd(), ${JSON.stringify(relativePath)});`,
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "fs.writeFileSync(target, 'isolated implementation\\n');",
    "process.stdout.write('SUMMARY: isolated implementation\\n');",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

function deletingAgentStub(root: string, label: string, relativePath: string) {
  const stub = path.join(root, `${label}.agent.cjs`);
  const lines = [
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.unlinkSync(path.join(process.cwd(), ${JSON.stringify(relativePath)}));`,
    "process.stdout.write('SUMMARY: isolated deletion\\n');",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

async function promptCapturingAgentStub(root: string, label: string, promptLog: string, relativePath = "evidence/D215-prompt.txt") {
  const stub = path.join(root, `${label}.agent.cjs`);
  const lines = [
    "const fs = require('fs');",
    "const path = require('path');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(promptLog)}, input);`,
    `  const target = path.join(process.cwd(), ${JSON.stringify(relativePath)});`,
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, 'prompt captured\\n');",
    "  process.stdout.write('SUMMARY: prompt captured\\n');",
    "});",
  ];
  await writeFile(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

async function failingSelfCheckAgentStub(root: string, label: string, promptLog: string) {
  const stub = path.join(root, `${label}.agent.cjs`);
  const lines = [
    "const fs = require('fs');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(promptLog)}, input);`,
    "  process.stderr.write('npm run typecheck failed in self-check\\n');",
    "  process.exit(17);",
    "});",
  ];
  await writeFile(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

async function typecheckAgentStub(root: string, label: string, checkLog: string) {
  const stub = path.join(root, `${label}.agent.cjs`);
  const lines = [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const command = process.execPath;",
    "const args = [path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'];",
    "const check = cp.spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });",
    `fs.writeFileSync(${JSON.stringify(checkLog)}, JSON.stringify({ command, args, exitCode: check.status ?? 1, stdout: check.stdout || '', stderr: check.stderr || '' }, null, 2));`,
    "if ((check.status ?? 1) !== 0) process.exit(check.status ?? 1);",
    "const target = path.join(process.cwd(), 'evidence', 'D218-typecheck.txt');",
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "fs.writeFileSync(target, 'typecheck ran in isolated worktree\\n');",
    "process.stdout.write('SUMMARY: isolated typecheck ran\\n');",
  ];
  await writeFile(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

async function codexAgentStub(root: string, label: string, relativePath = "evidence/D204-codex.txt") {
  const stub = path.join(root, `${label}.codex.cjs`);
  const launcher = path.join(root, `${label}.codex.cmd`);
  const log = path.join(root, `${label}.codex.json`);
  const lines = [
    "const fs = require('fs');",
    "const path = require('path');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => input += chunk);",
    "process.stdin.on('end', () => {",
    `  const target = path.join(process.cwd(), ${JSON.stringify(relativePath)});`,
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, 'codex implementation\\n');",
    `  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }, null, 2));`,
    "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SUMMARY: codex implementation' } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');",
    "});",
  ];
  await writeFile(stub, lines.join("\n"), "utf8");
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`, "utf8");
  return { launcher, log };
}

async function claudeAgentStub(root: string, label: string, promptLog: string) {
  const stub = path.join(root, `${label}.claude.cjs`);
  const launcher = path.join(root, `${label}.claude.cmd`);
  const log = path.join(root, `${label}.claude.json`);
  const lines = [
    "const fs = require('fs');",
    "const path = require('path');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => input += chunk);",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(promptLog)}, input);`,
    `  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }, null, 2));`,
    "  const target = path.join(process.cwd(), 'evidence', 'D219-claude.txt');",
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, 'claude implementation\\n');",
    "  process.stdout.write('SUMMARY: claude implementation\\n');",
    "});",
  ];
  await writeFile(stub, lines.join("\n"), "utf8");
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`, "utf8");
  return { launcher, log };
}

async function claimedImplementFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `tandem-d202-${name}-`));
  const helperRoot = await mkdtemp(path.join(tmpdir(), `tandem-d202-helper-${name}-`));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "orchestrator-state.json"), JSON.stringify({
    phase: "improving",
    currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence" },
    consecutiveFailures: 0,
  }), "utf8");
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
  await execa("git", ["init", "--initial-branch=master", root]);
  await execa("git", ["-C", root, "config", "user.email", "test@tandem"]);
  await execa("git", ["-C", root, "config", "user.name", "test"]);
  await execa("git", ["-C", root, "add", ".gitignore", "state/orchestrator-state.json"]);
  await execa("git", ["-C", root, "commit", "-m", "fixture base"]);
  return { root, helperRoot, statePath: path.join(stateDir, "orchestrator-state.json") };
}

function expectImplementationPromptProhibitions(prompt: string) {
  expect(prompt).toContain("Do NOT run git yourself");
  expect(prompt).toContain("Do not run npm install, npm ci, pnpm install, yarn install");
  expect(prompt).toContain("Do NOT modify the wishlist file, the orchestrator state file, the relay state");
  expect(prompt).toContain("Do NOT mark the item DONE");
  expect(prompt).toContain("Do NOT run the test suite");
  expect(prompt).toContain("orchestrator runs `npm run typecheck && npm test && git diff --check` itself as the only authoritative");
  expect(prompt).toContain("A self-check pass is not round success.");
}

function expectClaudeSystemPromptProhibitions(systemPrompt: string) {
  expect(systemPrompt).toContain("Do not use git.");
  expect(systemPrompt).toContain("do not run package-manager install commands");
  expect(systemPrompt).toContain("or the full test suite");
  expect(systemPrompt).toContain("A wrapper commits your changes afterward.");
}

async function linkRealNodeModules(root: string) {
  const realNodeModules = path.resolve("node_modules");
  const fixtureNodeModules = path.join(root, "node_modules");
  await symlink(realNodeModules, fixtureNodeModules, process.platform === "win32" ? "junction" : "dir");
  return async () => {
    await unlink(fixtureNodeModules).catch(async () => {
      await rm(fixtureNodeModules, { force: true }).catch(() => {});
    });
  };
}

function swapStubs(root: string) {
  const log = commandsLogPath(root);
  const stubFor = (label: string) => {
    const stub = path.join(root, `${label}.stub.cjs`);
    const code = [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:${JSON.stringify(label)}}) + "\\n");`,
      "process.exit(0);",
    ].join("\n");
    writeFileSync(stub, code, "utf8");
    return `node "${stub}"`;
  };
  return {
    test: stubFor("test"),
    packageB: stubFor("packageB"),
    startB: stubFor("startB"),
    verifyRuntime: stubFor("verifyRuntime"),
    rebuildA: stubFor("rebuildA"),
    verifyA: stubFor("verifyA"),
    stopB: stubFor("stopB"),
  };
}

async function runOrchestrator(root: string, relayRoot: string, commands: Record<string, string>) {
  return execa("node", [script, "--repo", root, "--relay-root", relayRoot], {
    cwd: root,
    env: { ...process.env, TANDEM_ORCHESTRATOR_COMMANDS_JSON: JSON.stringify(commands) },
    reject: false,
  });
}

describe("D200 reciprocal orchestrator no-commit abort", () => {
  windowsIt("aborts with cycle.aborted.no-commit when a-implements succeeds but produces no new descendant commit", async () => {
    const f = await fixture("no-commit-abort");
    try {
      const cmds = { implement: readOnlyImplementStub(f.root), ...swapStubs(f.root) };
      const result = await runOrchestrator(f.root, f.relayRoot, cmds);
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: false, aborted: "no-commit" });
      expect(parsed.headBefore).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.headAfter).toBe(parsed.headBefore);
      expect(parsed.message).toMatch(/no new descendant commit/);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cycle\.aborted\.no-commit/);
      expect(log).toMatch(/cycle\.claimed/);
      expect(log).not.toMatch(/cycle\.completed/);
      const wishlist = await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8");
      expect(wishlist).toMatch(/- \[ \] W9001 \| P0 \| Concrete acceptance/);
      expect(wishlist).toMatch(/QUEUED/);
      expect(wishlist).toMatch(/D200 no-commit abort/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state.phase).toBe("improving");
      expect(state.currentItem?.id).toBe("W9001");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("aborts with cycle.aborted.no-commit when HEAD moves but the new commit is not a descendant of headBefore", async () => {
    const f = await fixture("not-descendant");
    try {
      const cmds = { implement: descendantBreakingImplementStub(f.root), ...swapStubs(f.root) };
      const result = await runOrchestrator(f.root, f.relayRoot, cmds);
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: false, aborted: "no-commit" });
      expect(parsed.descendant).toBe(false);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cycle\.aborted\.no-commit/);
      expect(log).not.toMatch(/cycle\.completed/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("proceeds only when a real implementing commit lands and satisfies the acceptance file", async () => {
    const f = await fixture("real-commit-success");
    try {
      const cmds = {
        implement: implementingStub(f.root, "implement", "evidence/D200-acceptance.txt"),
        ...swapStubs(f.root),
      };
      const result = await runOrchestrator(f.root, f.relayRoot, cmds);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: true, completed: "W9001" });
      expect(parsed.state.lastImplementCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.state.stableCommit).toBe(parsed.state.lastImplementCommit);
      const acceptance = await readFile(path.join(f.root, "evidence", "D200-acceptance.txt"), "utf8");
      expect(acceptance).toMatch(/D200 acceptance satisfied/);
      const wishlist = await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8");
      expect(wishlist).toMatch(/- \[x\] W9001 .* DONE/);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cycle\.completed/);
      expect(log).toMatch(/implement-commit\.accepted/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("D200 reciprocal implement script", () => {
  windowsIt("refuses to run without a claimed item id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tandem-d200-impl-noargs-"));
    try {
      await execa("git", ["init", "--initial-branch=master", root]);
      await execa("git", ["-C", root, "config", "user.email", "t@t"]);
      await execa("git", ["-C", root, "config", "user.name", "t"]);
      await execa("git", ["-C", root, "commit", "--allow-empty", "-m", "base"]);
      const result = spawnSync("node", [implementScript, "--repo", root, "--control-path", path.join(root, "wishlist.md")], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out.ok).toBe(false);
      expect(out.step).toBe("read-claimed-item");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt("dry-run prints the claim plan without invoking the agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tandem-d200-impl-dry-"));
    const stateDir = path.join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(stateDir, "executor-a"), { recursive: true });
    await writeFile(path.join(stateDir, "executor-a", "config.json"), JSON.stringify({
      leader: "codex/cli",
      worker: "minimax/minimax-m3",
      codexCliReasoningEffort: "medium",
    }), "utf8");
    await writeFile(path.join(stateDir, "orchestrator-state.json"), JSON.stringify({
      phase: "improving",
      currentItem: { id: "W9002", priority: "P0", text: "Dry run item" },
      consecutiveFailures: 0,
    }), "utf8");
    await execa("git", ["init", "--initial-branch=master", root]);
    await execa("git", ["-C", root, "config", "user.email", "t@t"]);
    await execa("git", ["-C", root, "config", "user.name", "t"]);
    await execa("git", ["-C", root, "commit", "--allow-empty", "-m", "base"]);
    try {
      const result = spawnSync("node", [implementScript, "--repo", root, "--state-path", path.join(stateDir, "orchestrator-state.json"), "--claimed-item-id", "W9002", "--dry-run"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, dryRun: true, item: "W9002", provider: "codex" });
      expect(out.headBefore).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt("allows unrelated untracked files in the shared worktree and preserves them", async () => {
    const f = await claimedImplementFixture("untracked-allowed");
    try {
      const preexisting = path.join(f.root, "preexisting-user-file.txt");
      await writeFile(preexisting, "user-owned bytes\n", "utf8");
      const agent = isolatedAgentStub(f.helperRoot, "untracked-agent");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, item: "W9202", isolated: true });
      expect(await readFile(preexisting, "utf8")).toBe("user-owned bytes\n");
      const status = (await execa("git", ["-C", f.root, "status", "--porcelain=v1", "--untracked-files=all"])).stdout.split(/\r?\n/).filter(Boolean);
      expect(status).toEqual(["?? preexisting-user-file.txt"]);
      const changed = (await execa("git", ["-C", f.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).stdout.split(/\r?\n/).filter(Boolean);
      expect(changed).toEqual(["evidence/D202-isolated.txt"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("still aborts before invoking the agent when tracked files are dirty", async () => {
    const f = await claimedImplementFixture("tracked-dirty-abort");
    try {
      await writeFile(path.join(f.root, "state", "orchestrator-state.json"), JSON.stringify({
        phase: "improving",
        currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence after tracked dirt" },
        consecutiveFailures: 0,
      }, null, 2), "utf8");
      const agent = isolatedAgentStub(f.helperRoot, "tracked-dirty-agent");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: false, step: "shared-worktree-dirty", item: "W9202" });
      expect(out.message).toMatch(/tracked or staged/);
      const log = (await execa("git", ["-C", f.root, "log", "--oneline", "--max-count=1"])).stdout;
      expect(log).toContain("fixture base");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("aborts narrowly when the isolated commit would overwrite an untracked shared-worktree path", async () => {
    const f = await claimedImplementFixture("untracked-collision");
    try {
      await mkdir(path.join(f.root, "evidence"), { recursive: true });
      await writeFile(path.join(f.root, "evidence", "D202-isolated.txt"), "user-owned collision\n", "utf8");
      const agent = isolatedAgentStub(f.helperRoot, "collision-agent");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: false, step: "shared-untracked-collision", item: "W9202" });
      expect(out.paths).toEqual(["evidence/D202-isolated.txt"]);
      expect(await readFile(path.join(f.root, "evidence", "D202-isolated.txt"), "utf8")).toBe("user-owned collision\n");
      const log = (await execa("git", ["-C", f.root, "log", "--oneline", "--max-count=1"])).stdout;
      expect(log).toContain("fixture base");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("integrates a single isolated implementation commit with only agent-owned paths", async () => {
    const f = await claimedImplementFixture("isolated-success");
    try {
      const agent = isolatedAgentStub(f.helperRoot, "success-agent");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, item: "W9202", isolated: true });
      expect(out.headAfter).toBe(out.newSha);
      expect(out.paths).toEqual(["evidence/D202-isolated.txt"]);
      const status = (await execa("git", ["-C", f.root, "status", "--porcelain=v1", "--untracked-files=all"])).stdout;
      expect(status).toBe("");
      const changed = (await execa("git", ["-C", f.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).stdout.split(/\r?\n/).filter(Boolean);
      expect(changed).toEqual(["evidence/D202-isolated.txt"]);
      expect((await readFile(path.join(f.root, "evidence", "D202-isolated.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("isolated implementation\n");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("provisions node_modules into the isolated worktree so the TypeScript self-check really runs", async () => {
    const f = await claimedImplementFixture("d218-typecheck");
    let unlinkFixtureNodeModules: (() => Promise<void>) | null = null;
    try {
      await writeFile(path.join(f.root, "package.json"), JSON.stringify({
        name: "d218-typecheck-fixture",
        type: "module",
        scripts: { typecheck: "tsc --noEmit" },
        devDependencies: { typescript: "*" },
      }, null, 2), "utf8");
      await writeFile(path.join(f.root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*.ts"],
      }, null, 2), "utf8");
      await mkdir(path.join(f.root, "src"), { recursive: true });
      await writeFile(path.join(f.root, "src", "index.ts"), "export const value: string = 'ok';\n", "utf8");
      await execa("git", ["-C", f.root, "add", "package.json", "tsconfig.json", "src/index.ts"]);
      await execa("git", ["-C", f.root, "commit", "-m", "add typecheck fixture"]);
      unlinkFixtureNodeModules = await linkRealNodeModules(f.root);
      const realNodeModulesEntriesBefore = await readdir(path.resolve("node_modules"));
      const checkLog = path.join(f.helperRoot, "typecheck.json");
      const agent = await typecheckAgentStub(f.helperRoot, "typecheck-agent", checkLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, item: "W9202", isolated: true, dependencyProvisioning: { status: "linked" } });
      const check = JSON.parse(await readFile(checkLog, "utf8"));
      expect(check.args).toEqual(expect.arrayContaining(["--noEmit"]));
      expect(check.args.join(" ")).toContain(path.join("node_modules", "typescript", "bin", "tsc"));
      expect(check.exitCode).toBe(0);
      expect(check.stderr).toBe("");
      expect(await readFile(path.join(f.root, "evidence", "D218-typecheck.txt"), "utf8")).toContain("typecheck ran in isolated worktree");
      expect(existsSync(path.resolve("node_modules"))).toBe(true);
      expect((await readdir(path.resolve("node_modules"))).length).toBeGreaterThan(0);
      expect((await readdir(path.resolve("node_modules"))).length).toBe(realNodeModulesEntriesBefore.length);
    } finally {
      if (unlinkFixtureNodeModules) await unlinkFixtureNodeModules();
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  }, 30000);

  windowsIt("cleans up the isolated node_modules junction without deleting the real dependencies", async () => {
    const f = await claimedImplementFixture("d218-cleanup");
    let unlinkFixtureNodeModules: (() => Promise<void>) | null = null;
    try {
      unlinkFixtureNodeModules = await linkRealNodeModules(f.root);
      const realNodeModules = path.resolve("node_modules");
      const before = await readdir(realNodeModules);
      const agent = isolatedAgentStub(f.helperRoot, "cleanup-agent", "evidence/D218-cleanup.txt");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out.dependencyProvisioning).toMatchObject({ status: "linked" });
      expect(existsSync(realNodeModules)).toBe(true);
      const after = await readdir(realNodeModules);
      expect(after.length).toBeGreaterThan(0);
      expect(after.length).toBe(before.length);
    } finally {
      if (unlinkFixtureNodeModules) await unlinkFixtureNodeModules();
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("continues the isolated implementation when dependency provisioning is unavailable", async () => {
    const f = await claimedImplementFixture("d218-degraded");
    try {
      const agent = isolatedAgentStub(f.helperRoot, "degraded-agent", "evidence/D218-degraded.txt");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, dependencyProvisioning: { status: "missing", strategy: "none" } });
      expect(await readFile(path.join(f.root, "evidence", "D218-degraded.txt"), "utf8")).toContain("isolated implementation");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("requires a mandatory type self-check in the implementer prompt when dependencies are available", async () => {
    const f = await claimedImplementFixture("d219-mandatory-typecheck-prompt");
    let unlinkFixtureNodeModules: (() => Promise<void>) | null = null;
    try {
      unlinkFixtureNodeModules = await linkRealNodeModules(f.root);
      const promptLog = path.join(f.helperRoot, "d219-mandatory-prompt.txt");
      const agent = await promptCapturingAgentStub(f.helperRoot, "d219-mandatory-agent", promptLog, "evidence/D219-mandatory.txt");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("Dependency self-check support: node_modules is available");
      expect(prompt).toContain("After making your changes and before printing the final `SUMMARY:` line, run `npm run typecheck`");
      expect(prompt).toContain("or `tsc --noEmit` as a mandatory non-authoritative syntax/type self-check.");
      expect(prompt).toContain("Fix every error");
      expect(prompt).toContain("re-run it until it is clean");
      expect(prompt).toContain("Finishing with a known-failing");
      expect(prompt).toContain("compile is not acceptable");
      expect(prompt).toContain("say so explicitly");
      expect(prompt).not.toContain("You may run only a non-authoritative syntax/type self-check");
      expect(prompt).not.toMatch(/\bmay run\b/i);
      expectImplementationPromptProhibitions(prompt);
    } finally {
      if (unlinkFixtureNodeModules) await unlinkFixtureNodeModules();
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("waives the mandatory type self-check in the implementer prompt when dependencies are missing", async () => {
    const f = await claimedImplementFixture("d219-waived-typecheck-prompt");
    try {
      const promptLog = path.join(f.helperRoot, "d219-waived-prompt.txt");
      const agent = await promptCapturingAgentStub(f.helperRoot, "d219-waived-agent", promptLog, "evidence/D219-waived.txt");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("node_modules could not be provisioned");
      expect(prompt).toContain("the mandatory type self-check is waived for this round");
      expect(prompt).toContain("Do not pretend it ran");
      expect(prompt).toContain("say that explicitly in the `SUMMARY:` line");
      expect(prompt).not.toContain("Fix every error");
      expect(prompt).not.toContain("You may run only a non-authoritative syntax/type self-check");
      expect(prompt).not.toMatch(/\bmay run\b/i);
      expectImplementationPromptProhibitions(prompt);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("uses a mandatory but still restricted Claude system prompt", async () => {
    const f = await claimedImplementFixture("d219-claude-system-prompt");
    try {
      const promptLog = path.join(f.helperRoot, "d219-claude-prompt.txt");
      const claude = await claudeAgentStub(f.helperRoot, "d219-claude-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", claude.launcher, "--agent-provider", "claude"], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const invocation = JSON.parse(await readFile(claude.log, "utf8")) as { argv: string[] };
      const systemPrompt = invocation.argv.slice(invocation.argv.indexOf("--system-prompt") + 1).join(" ");
      expect(systemPrompt).toContain("mandatory non-authoritative syntax/type self-check");
      expect(systemPrompt).toContain("npm run typecheck or tsc --noEmit");
      expect(systemPrompt).not.toMatch(/Bash is allowed only for non-authoritative/i);
      expect(systemPrompt).not.toMatch(/\bmay run\b/i);
      expectClaudeSystemPromptProhibitions(systemPrompt);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("uses Executor A's Codex leader with CLI-default model and medium reasoning", async () => {
    const f = await claimedImplementFixture("configured-codex");
    try {
      const codex = await codexAgentStub(f.helperRoot, "configured-codex-agent");
      const configDir = path.join(path.dirname(f.statePath), "executor-a");
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.json"), JSON.stringify({
        leader: "codex/cli",
        worker: "minimax/minimax-m3",
        codexCliPath: codex.launcher,
        codexCliReasoningEffort: "medium",
      }), "utf8");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202"], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: true, item: "W9202", isolated: true, provider: "codex", agent: codex.launcher });
      expect(out.paths).toEqual(["evidence/D204-codex.txt"]);
      const invocation = JSON.parse(await readFile(codex.log, "utf8"));
      expect(invocation.argv).toEqual(expect.arrayContaining([
        "exec",
        "--sandbox",
        "workspace-write",
        "--ephemeral",
        "--json",
        "-c",
        "model_reasoning_effort=medium",
        "-",
      ]));
      expect(invocation.argv).not.toContain("-m");
      expect(invocation.input).toMatch(/wishlist item W9202/);
      expect((await readFile(path.join(f.root, "evidence", "D204-codex.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("codex implementation\n");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("prefers the dashboard implementation-helper model over Executor A's leader", async () => {
    const f = await claimedImplementFixture("implementation-helper-model");
    try {
      const codex = await codexAgentStub(f.helperRoot, "implementation-helper-agent");
      const stateDir = path.dirname(f.statePath);
      const configDir = path.join(stateDir, "executor-a");
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.json"), JSON.stringify({
        leader: "minimax/minimax-m3",
        worker: "minimax/minimax-m3",
        codexCliPath: codex.launcher,
      }), "utf8");
      const implementationConfigPath = path.join(stateDir, "reciprocal-implement-config.json");
      await writeFile(implementationConfigPath, JSON.stringify({
        schemaVersion: 1,
        leader: "codex/cli",
        codexCliReasoningEffort: "high",
      }), "utf8");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202"], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({
        ok: true,
        provider: "codex",
        agent: codex.launcher,
        configSource: "implementation-helper",
      });
      const invocation = JSON.parse(await readFile(codex.log, "utf8"));
      expect(invocation.argv).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=high"]));
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("fails closed instead of silently falling back to Claude for a non-CLI leader", async () => {
    const f = await claimedImplementFixture("unsupported-leader");
    try {
      const configDir = path.join(path.dirname(f.statePath), "executor-a");
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.json"), JSON.stringify({
        leader: "minimax/minimax-m3",
        worker: "minimax/minimax-m3",
      }), "utf8");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202"], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: false, step: "resolve-agent", item: "W9202" });
      expect(out.message).toMatch(/not a supported CLI implementation provider/);
      expect(out.message).toMatch(/minimax\/minimax-m3/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("stages isolated deletions without dropping the first path character", async () => {
    const f = await claimedImplementFixture("isolated-delete");
    try {
      const target = path.join(f.root, "app", "renderer", "src", "cli-model-options.ts");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const oldModel = 'sonnet';\n", "utf8");
      await execa("git", ["-C", f.root, "add", "app/renderer/src/cli-model-options.ts"]);
      await execa("git", ["-C", f.root, "commit", "-m", "add app model fixture"]);
      const agent = deletingAgentStub(f.helperRoot, "delete-agent", "app/renderer/src/cli-model-options.ts");
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out.paths).toEqual(["app/renderer/src/cli-model-options.ts"]);
      const changed = (await execa("git", ["-C", f.root, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"])).stdout;
      expect(changed).toContain("D\tapp/renderer/src/cli-model-options.ts");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("omits retry failure feedback from the first-attempt prompt", async () => {
    const f = await claimedImplementFixture("d215-first-prompt");
    try {
      const promptLog = path.join(f.helperRoot, "first-prompt.txt");
      const agent = await promptCapturingAgentStub(f.helperRoot, "first-prompt-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("The item text is:\nCreate isolated evidence");
      expect(prompt).not.toContain("=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===");
      expect(prompt).not.toContain("Failed command:");
      expect(prompt).toContain("A self-check pass is not round success.");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("renders retry failure command, exit code, output tail, round, and previous commit in the prompt", async () => {
    const f = await claimedImplementFixture("d215-retry-prompt");
    try {
      const promptLog = path.join(f.helperRoot, "retry-prompt.txt");
      const previousCommit = "35a063935a063935a063935a063935a063935a063";
      await writeFile(f.statePath, JSON.stringify({
        phase: "improving",
        currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence" },
        consecutiveFailures: 1,
        lastImplementCommit: previousCommit,
        failures: [{
          command: "npm run typecheck && npm test && git diff --check",
          exitCode: 2,
          output: "src/tools/shell.ts(309,24): error TS2367: retry-specific compiler failure",
          attemptCommit: previousCommit,
        }],
      }, null, 2), "utf8");
      await execa("git", ["-C", f.root, "add", "state/orchestrator-state.json"]);
      await execa("git", ["-C", f.root, "commit", "-m", "add retry state"]);
      const agent = await promptCapturingAgentStub(f.helperRoot, "retry-prompt-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===");
      expect(prompt).toContain("Retry round: 2");
      expect(prompt).toContain(`Previous attempt commit: ${previousCommit}`);
      expect(prompt).toContain("Failed command: npm run typecheck && npm test && git diff --check");
      expect(prompt).toContain("Exit code: 2");
      expect(prompt).toContain("src/tools/shell.ts(309,24): error TS2367");
      expect(prompt).toContain("The previous attempt failed verification. Your first priority is to fix the reported failure below.");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("renders failure history preserved by a same-item resume in the next prompt", async () => {
    const f = await claimedImplementFixture("d217-preserved-resume-prompt");
    try {
      const promptLog = path.join(f.helperRoot, "d217-preserved-prompt.txt");
      const previousCommit = "36b173136b173136b173136b173136b173136b1731";
      await writeFile(f.statePath, JSON.stringify({
        phase: "improving",
        currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence" },
        consecutiveFailures: 0,
        lastImplementCommit: previousCommit,
        failures: [{
          item: "W9202",
          command: "npm test -- tests/tools.test.ts",
          exitCode: 1,
          output: "D217 preserved failure from reviewed failed-paused resume",
          attemptCommit: previousCommit,
        }],
      }, null, 2), "utf8");
      await execa("git", ["-C", f.root, "add", "state/orchestrator-state.json"]);
      await execa("git", ["-C", f.root, "commit", "-m", "add D217 preserved retry state"]);
      const agent = await promptCapturingAgentStub(f.helperRoot, "d217-preserved-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===");
      expect(prompt).toContain("Retry round: 2");
      expect(prompt).toContain("Failed command: npm test -- tests/tools.test.ts");
      expect(prompt).toContain("D217 preserved failure from reviewed failed-paused resume");
      expect(prompt).toContain("The item text is:\nCreate isolated evidence");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("truncates oversized retry output to the documented tail while preserving the item text", async () => {
    const f = await claimedImplementFixture("d215-retry-truncate");
    try {
      const promptLog = path.join(f.helperRoot, "retry-truncate-prompt.txt");
      const hugeOutput = `${"older noise\n".repeat(900)}FINAL TYPECHECK ERROR`;
      await writeFile(f.statePath, JSON.stringify({
        phase: "improving",
        currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence" },
        consecutiveFailures: 1,
        lastImplementCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        failures: [{ command: "npm run typecheck", exitCode: 2, output: hugeOutput }],
      }, null, 2), "utf8");
      await execa("git", ["-C", f.root, "add", "state/orchestrator-state.json"]);
      await execa("git", ["-C", f.root, "commit", "-m", "add oversized retry state"]);
      const agent = await promptCapturingAgentStub(f.helperRoot, "retry-truncate-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const prompt = await readFile(promptLog, "utf8");
      expect(prompt).toContain("Output shown below is the tail, truncated to 6000 bytes so the item text remains visible.");
      expect(prompt).toContain("FINAL TYPECHECK ERROR");
      expect(prompt).toContain("The item text is:\nCreate isolated evidence");
      expect(prompt.length).toBeLessThan(9000);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("makes the retry prompt differ from the first-attempt prompt for the same item", async () => {
    const first = await claimedImplementFixture("d215-first-diff");
    const retry = await claimedImplementFixture("d215-retry-diff");
    try {
      const firstPromptLog = path.join(first.helperRoot, "first.txt");
      const retryPromptLog = path.join(retry.helperRoot, "retry.txt");
      const firstAgent = await promptCapturingAgentStub(first.helperRoot, "first-diff-agent", firstPromptLog);
      const firstResult = spawnSync("node", [implementScript, "--repo", first.root, "--state-path", first.statePath, "--claimed-item-id", "W9202", "--agent-bin", firstAgent], {
        cwd: first.root,
        encoding: "utf8",
      });
      expect(firstResult.status).toBe(0);
      await writeFile(retry.statePath, JSON.stringify({
        phase: "improving",
        currentItem: { id: "W9202", priority: "P0", text: "Create isolated evidence" },
        consecutiveFailures: 1,
        lastImplementCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        failures: [{ command: "npm run typecheck", exitCode: 2, output: "retry failure" }],
      }, null, 2), "utf8");
      await execa("git", ["-C", retry.root, "add", "state/orchestrator-state.json"]);
      await execa("git", ["-C", retry.root, "commit", "-m", "add retry diff state"]);
      const retryAgent = await promptCapturingAgentStub(retry.helperRoot, "retry-diff-agent", retryPromptLog);
      const retryResult = spawnSync("node", [implementScript, "--repo", retry.root, "--state-path", retry.statePath, "--claimed-item-id", "W9202", "--agent-bin", retryAgent], {
        cwd: retry.root,
        encoding: "utf8",
      });
      expect(retryResult.status).toBe(0);
      const firstPrompt = await readFile(firstPromptLog, "utf8");
      const retryPrompt = await readFile(retryPromptLog, "utf8");
      expect(retryPrompt).not.toBe(firstPrompt);
      expect(retryPrompt).toContain("=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===");
      expect(firstPrompt).not.toContain("=== RETRY FAILURE FEEDBACK - FIX THIS FIRST ===");
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(first.helperRoot, { recursive: true, force: true });
      await rm(retry.root, { recursive: true, force: true });
      await rm(retry.helperRoot, { recursive: true, force: true });
    }
  });

  windowsIt("treats a non-authoritative self-check failure as agent failure, not round success", async () => {
    const f = await claimedImplementFixture("d215-self-check-fails");
    try {
      const promptLog = path.join(f.helperRoot, "self-check-prompt.txt");
      const agent = await failingSelfCheckAgentStub(f.helperRoot, "self-check-agent", promptLog);
      const result = spawnSync("node", [implementScript, "--repo", f.root, "--state-path", f.statePath, "--claimed-item-id", "W9202", "--agent-bin", agent], {
        cwd: f.root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      const out = JSON.parse(String(result.stdout));
      expect(out).toMatchObject({ ok: false, step: "agent-exit" });
      expect(out.message).toContain("agent exited 17");
      expect(out.stderrTail).toContain("npm run typecheck failed in self-check");
      const head = (await execa("git", ["-C", f.root, "log", "--oneline", "--max-count=1"])).stdout;
      expect(head).toContain("fixture base");
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.helperRoot, { recursive: true, force: true });
    }
  });
});

describe("D200 retroactive false-completion audit", () => {
  windowsIt("flags a synthetic read-only completion entry without modifying the log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tandem-d200-audit-"));
    const log = path.join(root, "orchestrator-operations.ndjson");
    const entries = [
      { at: "2026-07-24T01:00:00.000Z", action: "cycle.claimed", phase: "improving", item: "W9999", step: null },
      { at: "2026-07-24T01:00:01.000Z", action: "a-implements.started", phase: "improving", item: "W9999", step: "a-implements", command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Show -ControlPath wishlist" },
      { at: "2026-07-24T01:00:02.000Z", action: "a-implements.passed", phase: "improving", item: "W9999", step: "a-implements", command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Show -ControlPath wishlist", exitCode: 0, outputHash: "abc" },
      { at: "2026-07-24T01:00:30.000Z", action: "stable-ref.updated", phase: "swapping", item: "W9999", step: null, sourceSha: "0000000000000000000000000000000000000000" },
      { at: "2026-07-24T01:00:31.000Z", action: "cycle.completed", phase: "idle", item: null, step: null, completedItem: "W9999" },
    ];
    const before = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(log, before, "utf8");
    try {
      const result = spawnSync("node", [auditScript, "--log-path", log, "--repo", root], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(String(result.stdout));
      expect(parsed.totalCycleCompletions).toBe(1);
      expect(parsed.falseCompletionsSuspected).toBe(1);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0].item).toBe("W9999");
      expect(parsed.findings[0].reason).toMatch(/read-only/);
      const after = await readFile(log, "utf8");
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt("does not attribute an unrelated stable update outside the claim/completion window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tandem-d202-audit-unrelated-"));
    const log = path.join(root, "orchestrator-operations.ndjson");
    const entries = [
      { at: "2026-07-24T01:00:00.000Z", action: "cycle.claimed", phase: "improving", item: "W9998", step: null },
      { at: "2026-07-24T01:00:01.000Z", action: "a-implements.started", phase: "improving", item: "W9998", step: "a-implements", command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Show -ControlPath wishlist" },
      { at: "2026-07-24T01:00:02.000Z", action: "a-implements.passed", phase: "improving", item: "W9998", step: "a-implements", command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-direction.ps1 -Action Show -ControlPath wishlist", exitCode: 0 },
      { at: "2026-07-24T01:00:03.000Z", action: "cycle.completed", phase: "idle", completedItem: "W9998" },
      { at: "2026-07-24T01:01:00.000Z", action: "implement-commit.accepted", phase: "improving", item: "W9997", lastImplementCommit: "1111111111111111111111111111111111111111" },
      { at: "2026-07-24T01:01:01.000Z", action: "stable-ref.updated", phase: "swapping", sourceSha: "1111111111111111111111111111111111111111" },
    ];
    await writeFile(log, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    try {
      const result = spawnSync("node", [auditScript, "--log-path", log, "--repo", root], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(String(result.stdout));
      expect(parsed.falseCompletionsSuspected).toBe(1);
      expect(parsed.findings[0].item).toBe("W9998");
      expect(parsed.findings[0].verifiedImplementingCommit).toMatchObject({
        implemented: false,
        reason: "no cycle-local implement-commit.accepted entry",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  windowsIt("honors the since tag boundary and verifies exact cycle-local implementation promotion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tandem-d202-audit-since-"));
    const log = path.join(root, "orchestrator-operations.ndjson");
    await execa("git", ["init", "--initial-branch=master", root]);
    await execa("git", ["-C", root, "config", "user.email", "test@tandem"]);
    await execa("git", ["-C", root, "config", "user.name", "test"]);
    await execa("git", ["-C", root, "commit", "--allow-empty", "-m", "before boundary"], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-07-24T00:00:00.000Z",
        GIT_COMMITTER_DATE: "2026-07-24T00:00:00.000Z",
      },
    });
    await execa("git", ["-C", root, "tag", "D196-1"]);
    const entries = [
      { at: "2026-07-23T23:59:00.000Z", action: "cycle.claimed", phase: "improving", item: "WOLD", step: null },
      { at: "2026-07-23T23:59:01.000Z", action: "cycle.completed", phase: "idle", completedItem: "WOLD" },
      { at: "2026-07-24T00:01:00.000Z", action: "cycle.claimed", phase: "improving", item: "WNEW", step: null },
      { at: "2026-07-24T00:01:01.000Z", action: "implement-commit.accepted", phase: "improving", item: "WNEW", lastImplementCommit: "2222222222222222222222222222222222222222" },
      { at: "2026-07-24T00:01:02.000Z", action: "stable-ref.updated", phase: "swapping", sourceSha: "2222222222222222222222222222222222222222" },
      { at: "2026-07-24T00:01:03.000Z", action: "cycle.completed", phase: "idle", completedItem: "WNEW" },
    ];
    await writeFile(log, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    try {
      const result = spawnSync("node", [auditScript, "--log-path", log, "--repo", root, "--since", "D196-1"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(String(result.stdout));
      expect(parsed.totalCycleCompletions).toBe(1);
      expect(parsed.falseCompletionsSuspected).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
