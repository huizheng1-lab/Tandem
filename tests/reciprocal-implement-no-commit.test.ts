import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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
  await execa("git", ["init", "--initial-branch=master", root]);
  await execa("git", ["-C", root, "config", "user.email", "test@tandem"]);
  await execa("git", ["-C", root, "config", "user.name", "test"]);
  await execa("git", ["-C", root, "add", "state/orchestrator-state.json"]);
  await execa("git", ["-C", root, "commit", "-m", "fixture base"]);
  return { root, helperRoot, statePath: path.join(stateDir, "orchestrator-state.json") };
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
