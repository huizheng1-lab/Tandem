import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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

function commands(root: string, overrides: Record<string, string> = {}) {
  const base = {
    implement: command(root, "implement"),
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

async function run(root: string, relayRoot: string, commandMap: Record<string, string>) {
  return execa("node", [script, "--repo", root, "--relay-root", relayRoot], {
    cwd: root,
    env: { ...process.env, TANDEM_ORCHESTRATOR_COMMANDS_JSON: JSON.stringify(commandMap), TANDEM_ORCHESTRATOR_SOURCE_SHA: "fixture-sha" },
    reject: false,
  });
}

async function labels(root: string) {
  return (await readFile(commandLog(root), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line).label);
}

describe("single reciprocal orchestrator", () => {
  windowsIt("drives the happy-path full cycle with B as mechanical swap authority", async () => {
    const f = await fixture("happy");
    try {
      const result = await run(f.root, f.relayRoot, commands(f.root));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, completed: "W0001" });
      expect(await labels(f.root)).toEqual(["implement", "test", "packageB", "startB", "verifyRuntime", "rebuildA", "verifyA", "stopB"]);
      expect(await readFile(path.join(f.relayRoot, "control", "WISHLIST.md"), "utf8")).toMatch(/- \[x\] W0001 .* DONE/);
      const state = JSON.parse(await readFile(path.join(f.relayRoot, "state", "orchestrator-state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "idle", currentItem: null, stableCommit: "fixture-sha" });
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
