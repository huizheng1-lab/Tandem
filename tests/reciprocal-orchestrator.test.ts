import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;
const script = path.resolve("scripts/reciprocal-orchestrator.mjs");
const PROCESS_SPAWNING_TEST_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: PROCESS_SPAWNING_TEST_TIMEOUT_MS });

async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `tandem-orchestrator-${name}-`));
  const relayRoot = path.join(root, "relay");
  await mkdir(path.join(relayRoot, "control"), { recursive: true });
  await writeFile(
    path.join(relayRoot, "control", "WISHLIST.md"),
    [
      "# Wishlist",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W1000 | P1 | Lower priority | QUEUED added=now",
      "- [ ] W0001 | P0 | Build the thing | QUEUED added=now",
      "",
    ].join("\n"),
    "utf8",
  );
  await execa("git", ["init", "--initial-branch=master", root]);
  await execa("git", ["-C", root, "config", "user.email", "test@tandem"]);
  await execa("git", ["-C", root, "config", "user.name", "test"]);
  await execa("git", ["-C", root, "commit", "--allow-empty", "-m", "fixture base"]);
  return { root, relayRoot };
}

function commandLog(root: string) {
  return path.join(root, "commands.ndjson");
}

function command(root: string, label: string, exitCode = 0, extra = "") {
  const log = commandLog(root).replaceAll("\\", "\\\\");
  const text = `${label}${extra ? ` ${extra}` : ""}`;
  return `node -e "require('fs').appendFileSync('${log}', JSON.stringify({label:'${label}', argv:process.argv.slice(1), text:'${text}'})+'\\n'); process.exit(${exitCode})"`;
}

function implementingCommand(root: string, label: string) {
  const stub = path.join(root, `${label}.stub.cjs`);
  const log = commandLog(root);
  const lines = [
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const root = ${JSON.stringify(root)};`,
    `const log = ${JSON.stringify(log)};`,
    `fs.appendFileSync(log, JSON.stringify({label:${JSON.stringify(label)}}) + "\\n");`,
    `cp.execFileSync('git', ['-C', root, 'add', '-A'], {stdio:'ignore'});`,
    `cp.execFileSync('git', ['-C', root, 'commit', '-m', ${JSON.stringify(`D200-N: ${label} stub`)}, '--allow-empty'], {stdio:'ignore'});`,
    "process.exit(0);",
  ];
  writeFileSync(stub, lines.join("\n"), "utf8");
  return `node "${stub}"`;
}

function commands(root: string, overrides: Record<string, string> = {}) {
  const base = {
    implement: implementingCommand(root, "implement"),
    test: command(root, "test"),
    packageB: command(root, "packageB"),
    startB: command(root, "startB"),
    verifyRuntime: command(root, "verifyRuntime"),
    rebuildA: command(root, "rebuildA"),
    verifyA: command(root, "verifyA"),
    stopB: command(root, "stopB"),
  };
  return { ...base, ...overrides };
}

function noCommitCommand(root: string) {
  const log = commandLog(root).replaceAll("\\", "\\\\");
  return `node -e "require('fs').appendFileSync('${log}', JSON.stringify({label:'implement'})+'\\n'); process.exit(0)"`;
}

async function run(root: string, relayRoot: string, commandMap: Record<string, string>, extraArgs: string[] = []) {
  return execa("node", [script, "--repo", root, "--relay-root", relayRoot, ...extraArgs], {
    cwd: root,
    env: { ...process.env, TANDEM_ORCHESTRATOR_COMMANDS_JSON: JSON.stringify(commandMap), TANDEM_ORCHESTRATOR_SOURCE_SHA: "fixture-sha" },
    reject: false,
  });
}

async function labels(root: string) {
  return (await readFile(commandLog(root), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line).label);
}

describe("single reciprocal orchestrator", () => {
  windowsIt("aborts a successful no-op implementation and requeues the item", async () => {
    const f = await fixture("d200-no-commit");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root, { implement: noCommitCommand(f.root) }));
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: false, aborted: "no-commit" });
      expect(parsed.headAfter).toBe(parsed.headBefore);
      const wishlist = await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8");
      expect(wishlist).toMatch(/- \[ \] W0001 .* QUEUED .*D200 no-commit abort/);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cycle\.aborted\.no-commit/);
      expect(log).not.toMatch(/cycle\\.completed/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("accepts only a descendant implementation commit", async () => {
    const f = await fixture("d200-commit");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.state.lastImplementCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(parsed.state.stableCommit).toBe(parsed.state.lastImplementCommit);
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[x\] W0001 .* DONE/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("marks a completed wishlist item by id when the stored line is stale", async () => {
    const f = await fixture("d200-stale-line");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "improving",
          currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 999 },
          consecutiveFailures: 0,
          failures: [],
          step: "a-tests",
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[x\] W0001 .* DONE/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("drives the happy-path full cycle with B as mechanical swap authority", async () => {
    const f = await fixture("happy");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, completed: "W0001" });
      expect(await labels(f.root)).toEqual(["implement", "test", "packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[x\] W0001 .* DONE/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state.phase).toBe("idle");
      expect(state.currentItem).toBeNull();
      expect(state.lastImplementCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(state.stableCommit).toBe(state.lastImplementCommit);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("feeds first failure output to round two and succeeds", async () => {
    const f = await fixture("retry");
    try {
      const sentinel = path.join(f.root, "attempt.txt").replaceAll("\\", "\\\\");
      const retryTest = `node -e "const fs=require('fs'); const p='${sentinel}'; const n=fs.existsSync(p)?2:1; fs.writeFileSync(p,String(n)); fs.appendFileSync('${commandLog(f.root).replaceAll("\\", "\\\\")}', JSON.stringify({label:'test', attempt:n})+'\\n'); process.exit(n===1?9:0)"`;
      const result = await run(f.root, f.relayRoot, commands(f.root, { test: retryTest }));
      expect(result.exitCode).toBe(0);
      expect(await labels(f.root)).toEqual(["implement", "test", "implement", "test", "packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cycle.retry-feedback/);
      expect(log).toMatch(/feedbackBytes/);
      expect(log).toMatch(/feedbackDeliveredVia/);
      expect(log).toMatch(/state\.failures/);
      expect(log).toMatch(/attemptCommit/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("pauses with a report after two failed rounds", async () => {
    const f = await fixture("two-strike");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root, { test: command(f.root, "test", 7, "boom") }));
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: false, failedPaused: true });
      expect(await readFile(parsed.report, "utf8")).toMatch(/two consecutive failed A rounds/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "failed-paused", consecutiveFailures: 2 });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("retries infrastructure steps independently without spending item strikes", async () => {
      const f = await fixture("infrastructure-retry");
    try {
      const sentinel = path.join(f.root, "package-attempts");
      const escapedSentinel = sentinel.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
      const packageCommand = `node -e "const fs=require('fs'); const p='${escapedSentinel}'; const n=fs.existsSync(p)?Number(fs.readFileSync(p))+1:1; fs.writeFileSync(p,String(n)); process.exit(n<6?9:0)"`;
      const result = await run(f.root, f.relayRoot, commands(f.root, { packageB: packageCommand }));
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", consecutiveFailures: 0 });
      expect(state.infrastructureFailures["package-b"]).toMatchObject({ consecutiveCycles: 0 });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("pauses after bounded infrastructure exhaustion while naming the passed commit", async () => {
    const f = await fixture("infrastructure-exhausted");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root, { packageB: command(f.root, "packageB", 9, "lock remains") }));
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(result.stdout);
      const report = await readFile(parsed.report, "utf8");
      expect(report).toMatch(/implementation itself passed/i);
      expect(report).toMatch(/successful implementation commit:/i);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "failed-paused", consecutiveFailures: 0 });
      expect(state.failures.at(-1)).toMatchObject({ kind: "infrastructure", step: "package-b", implementationPassed: true });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("resumes failed-paused state after human-reviewed failure report", async () => {
    const f = await fixture("resume-failed-paused");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "failed-paused",
          currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 4 },
          consecutiveFailures: 2,
          failures: [{ item: "W0001", command: "old", exitCode: 1, output: "old failure" }],
          failureReport: path.join(f.relayRoot, "control", "failure-reports", "W0001.md"),
          step: "failed-paused",
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--resume", "--reason", "reviewed and fixed"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: true, resumed: true, reason: "reviewed and fixed" });
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({
        phase: "idle",
        currentItem: { id: "W0001" },
        consecutiveFailures: 0,
        step: null
      });
      expect(state.failures).toEqual([{ item: "W0001", command: "old", exitCode: 1, output: "old failure" }]);
      expect(state.failureReport).toBeUndefined();
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/failed-paused\.resumed/);
      expect(log).toMatch(/same-item-history/);
      expect(log).toMatch(/"preserve":true/);
      expect(log).toMatch(/reviewed and fixed/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("resumes failed-paused state with an explicit failure-history discard", async () => {
    const f = await fixture("resume-discard-failures");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "failed-paused",
          currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 4 },
          consecutiveFailures: 2,
          failures: [{ item: "W0001", command: "old", exitCode: 1, output: "old failure" }],
          failureReport: path.join(f.relayRoot, "control", "failure-reports", "W0001.md"),
          step: "failed-paused",
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--resume", "--discard-failures"]);
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", currentItem: { id: "W0001" }, consecutiveFailures: 0, step: null });
      expect(state.failures).toEqual([]);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/discard-failures-requested/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("clears stale failure history when resume has no current item", async () => {
    const f = await fixture("resume-no-current-item");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "failed-paused",
          currentItem: null,
          consecutiveFailures: 2,
          failures: [{ item: "W0001", command: "old", exitCode: 1, output: "old failure" }],
          failureReport: path.join(f.relayRoot, "control", "failure-reports", "W0001.md"),
          step: "failed-paused",
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--resume"]);
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", currentItem: null, consecutiveFailures: 0, step: null });
      expect(state.failures).toEqual([]);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/no-current-item/);

      const retry = await run(f.root, f.relayRoot, commands(f.root));
      expect(retry.exitCode).toBe(0);
      expect(await labels(f.root)).toEqual(["implement", "test", "packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
      const completedState = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(completedState.failures).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("clears stale failure history when resume item differs from recorded failures", async () => {
    const f = await fixture("resume-item-mismatch");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "failed-paused",
          currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 4 },
          consecutiveFailures: 2,
          failures: [{ item: "W9999", command: "old", exitCode: 1, output: "old failure" }],
          failureReport: path.join(f.relayRoot, "control", "failure-reports", "W9999.md"),
          step: "failed-paused",
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--resume"]);
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state.failures).toEqual([]);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/failure-item-mismatch:W9999/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("finalizes an already accepted item during resume after a duplicate pause", async () => {
    const f = await fixture("resume-finalize-accepted");
    try {
      const head = (await execa("git", ["-C", f.root, "rev-parse", "HEAD"])).stdout.trim();
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({
          phase: "failed-paused",
          currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 999 },
          consecutiveFailures: 2,
          failures: [{ command: "duplicate", exitCode: 1, output: "limit" }],
          failureReport: path.join(f.relayRoot, "control", "failure-reports", "W0001.md"),
          step: "failed-paused",
          lastImplementCommit: head,
          acceptedSourceSha: head,
          updatedAt: new Date().toISOString()
        }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--resume", "--finalize-accepted", "--reason", "accepted source already promoted"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: true, finalized: true, sourceSha: head });
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[x\] W0001 .* DONE .*stable=/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", currentItem: null, stableCommit: head, consecutiveFailures: 0 });
      expect(state.failures).toEqual([]);
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/failed-paused\.accepted-finalized/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("resumes cleanly after a crash-mid-cycle state write", async () => {
    const f = await fixture("resume");
    try {
      await mkdir(path.join(f.relayRoot, "state"), { recursive: true });
      await writeFile(
        path.join(f.relayRoot, "state", "orchestrator-state.json"),
        JSON.stringify({ phase: "improving", currentItem: { id: "W0001", priority: "P0", text: "Build the thing", line: 4 }, consecutiveFailures: 1, failures: [{ command: "old", exitCode: 1, output: "old failure" }], step: "a-tests", updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      expect(await labels(f.root)).toEqual(["implement", "test", "packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("idles when the wishlist is empty", async () => {
    const f = await fixture("idle");
    try {
      await writeFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "# Wishlist\n\n<!-- wishlist-items -->\n", "utf8");
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, idle: true, state: { phase: "idle" } });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("runs explicit cutover through the mechanical swap path without claiming wishlist work", async () => {
    const f = await fixture("cutover");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root), ["--cutover"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, cutover: true });
      expect(await labels(f.root)).toEqual(["packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[ \] W0001 .* QUEUED/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", currentItem: null, stableCommit: "fixture-sha" });
      const log = await readFile(path.join(f.relayRoot, "control", "orchestrator-operations.ndjson"), "utf8");
      expect(log).toMatch(/cutover\.started/);
      expect(log).toMatch(/cutover\.completed/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  windowsIt("leaves rejection requeue semantics in the shared wishlist file", async () => {
    const f = await fixture("requeue");
    try {
      const wishlist = path.join(f.relayRoot, "control", "WISHLIST.md");
      await writeFile(wishlist, "# Wishlist\n\n<!-- wishlist-items -->\n- [x] W0002 | P0 | Reviewed thing | DONE stable=abc completed=now\n", "utf8");
      await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/reciprocal-direction.ps1"), "-Action", "Requeue", "-Id", "W0002", "-ControlPath", wishlist, "-Note", "human rejected review"]);
      expect(await readFile(wishlist, "utf8")).toMatch(/- \[ \] W0002 .* QUEUED note=human rejected review/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
