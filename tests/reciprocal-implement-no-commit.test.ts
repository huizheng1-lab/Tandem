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
      expect(out).toMatchObject({ ok: true, dryRun: true, item: "W9002" });
      expect(out.headBefore).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
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
});
