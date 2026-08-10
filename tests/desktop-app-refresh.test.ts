import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const serverScript = path.resolve("dashboard-source/reciprocal-control-panel/server.mjs");
const activeServers = new Set<ChildProcess>();

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number, child: ChildProcess) {
  const started = Date.now();
  let last = "";
  child.stdout?.on("data", (chunk) => { last += chunk.toString(); });
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return await response.text();
    } catch {
      // Server is still starting.
    }
    await wait(80);
  }
  throw new Error(`dashboard server did not start; stdout=${last}`);
}

async function git(cwd: string, ...args: string[]) {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tandem-d222-"));
  const repoRoot = path.join(root, "repo");
  const relayRoot = path.join(root, "relay");
  await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
  await mkdir(path.join(relayRoot, "control"), { recursive: true });
  await mkdir(path.join(relayRoot, "state"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ version: "0.1.0", type: "module" }), "utf8");
  await writeFile(path.join(repoRoot, "scripts", "runtime-package-integrity.mjs"), "export async function verifyPackage() { return { packageIdentity: { ok: true }, buildInfo: {} }; }\n", "utf8");
  await writeFile(path.join(repoRoot, "file.txt"), "fixture\n", "utf8");
  await git(repoRoot, "init");
  await git(repoRoot, "config", "user.email", "test@example.com");
  await git(repoRoot, "config", "user.name", "Test");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-m", "fixture");
  const sha = await git(repoRoot, "rev-parse", "HEAD");
  await git(repoRoot, "update-ref", "refs/tandem-relay/stable", sha);
  await writeFile(path.join(relayRoot, "control", "WISHLIST.md"), "No items\n", "utf8");
  await writeFile(path.join(relayRoot, "control", "SHARED_DIRECTION.md"), "General direction\n", "utf8");
  await writeFile(path.join(relayRoot, "state", "orchestrator-state.json"), JSON.stringify({ schemaVersion: 1, phase: "idle", stableCommit: sha }, null, 2), "utf8");
  return { root, repoRoot, relayRoot, sha };
}

async function writeRuntime(root: string, relativeDir: string, sha: string, marker: string) {
  const runtime = path.join(root, relativeDir);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "Tandem.exe"), marker, "utf8");
  await writeFile(path.join(runtime, "payload.txt"), marker, "utf8");
  await writeFile(path.join(runtime, "BUILD_INFO.json"), `${JSON.stringify({
    sourceSha: sha,
    sourceShortSha: sha.slice(0, 7),
    builtAt: "2026-08-10T00:00:00.000Z",
    artifact: relativeDir.replaceAll("\\", "/"),
  }, null, 2)}\n`, "utf8");
  return runtime;
}

async function withDashboard(fixture: Awaited<ReturnType<typeof makeFixture>>, env: Record<string, string> = {}) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [serverScript, `--port=${port}`], {
    cwd: path.resolve("dashboard-source/reciprocal-control-panel"),
    windowsHide: true,
    env: {
      ...process.env,
      TANDEM_RECIPROCAL_ROOT: fixture.relayRoot,
      TANDEM_SOURCE_REPO: fixture.repoRoot,
      TANDEM_DASHBOARD_TEST_HARNESS: "1",
      TANDEM_DASHBOARD_TEST_DESKTOP_LOCK_REPORT: "__none__",
      TANDEM_ORCHESTRATOR_STATUS_TICK_MS: "600000",
      ...env,
    },
  });
  activeServers.add(child);
  const html = await waitForServer(port, child);
  const token = html.match(/name="control-token" content="([^"]+)"/)?.[1];
  if (!token) throw new Error("missing dashboard control token");
  return {
    port,
    child,
    async post(pathname: string, body = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-control-token": token },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() };
    },
    async get(pathname: string) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return { response, body: await response.json() };
    },
  };
}

afterEach(async () => {
  for (const child of activeServers) {
    if (child.exitCode === null && child.pid) child.kill();
    await once(child, "exit").catch(() => {});
    activeServers.delete(child);
  }
});

describe("desktop app refresh dashboard actions", () => {
  it("promotes the last verified passive runtime and stamps the desktop build info", async () => {
    const fixture = await makeFixture();
    try {
      const oldSha = "1111111111111111111111111111111111111111";
      const newSha = "2222222222222222222222222222222222222222";
      await writeRuntime(fixture.repoRoot, path.join("release", "win-unpacked"), oldSha, "old");
      await writeRuntime(fixture.repoRoot, path.join("release", "reciprocal-passive", "win-unpacked"), newSha, "new");
      const stateBefore = await readFile(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), "utf8");
      const wishlistBefore = await readFile(path.join(fixture.relayRoot, "control", "WISHLIST.md"), "utf8");
      const stableBefore = await git(fixture.repoRoot, "rev-parse", "refs/tandem-relay/stable");
      const dashboard = await withDashboard(fixture);

      const { response, body } = await dashboard.post("/api/desktop-app/promote");

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      const promoted = JSON.parse(await readFile(path.join(fixture.repoRoot, "release", "win-unpacked", "BUILD_INFO.json"), "utf8"));
      expect(promoted.sourceSha).toBe(newSha);
      expect(promoted.sourceShortSha).toBe("2222222");
      expect(promoted.artifact).toBe("release/win-unpacked");
      expect(await readFile(path.join(fixture.repoRoot, "release", "win-unpacked", "payload.txt"), "utf8")).toBe("new");
      expect(await readFile(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), "utf8")).toBe(stateBefore);
      expect(await readFile(path.join(fixture.relayRoot, "control", "WISHLIST.md"), "utf8")).toBe(wishlistBefore);
      expect(await git(fixture.repoRoot, "rev-parse", "refs/tandem-relay/stable")).toBe(stableBefore);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses both actions with the holding process report when the desktop app is running", async () => {
    const fixture = await makeFixture();
    try {
      await writeRuntime(fixture.repoRoot, path.join("release", "reciprocal-passive", "win-unpacked"), "3333333333333333333333333333333333333333", "new");
      const report = "Candidate lock holders for 'release/win-unpacked': PID=4321, Name=Tandem.exe, Path=C:\\app\\release\\win-unpacked\\Tandem.exe";
      const dashboard = await withDashboard(fixture, { TANDEM_DASHBOARD_TEST_DESKTOP_LOCK_REPORT: report });

      const promote = await dashboard.post("/api/desktop-app/promote");
      const rebuild = await dashboard.post("/api/desktop-app/rebuild");

      expect(promote.response.status).toBe(400);
      expect(promote.body.error).toContain("PID=4321");
      expect(rebuild.response.status).toBe(400);
      expect(rebuild.body.error).toContain("PID=4321");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses full rebuild while the orchestrator is packaging", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(path.join(fixture.relayRoot, "state", "orchestrator-state.json"), JSON.stringify({ phase: "swapping", step: "package-b", stableCommit: fixture.sha }, null, 2), "utf8");
      const dashboard = await withDashboard(fixture);

      const result = await dashboard.post("/api/desktop-app/rebuild");

      expect(result.response.status).toBe(400);
      expect(result.body.error).toContain("phase=swapping");
      expect(result.body.error).toContain("step=package-b");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns immediately for a long rebuild and exposes failure output through status", async () => {
    const fixture = await makeFixture();
    try {
      const dashboard = await withDashboard(fixture, {
        TANDEM_DASHBOARD_TEST_REBUILD_MODE: "synthetic",
        TANDEM_DASHBOARD_TEST_REBUILD_DELAY_MS: "5000",
      });

      const started = Date.now();
      const result = await dashboard.post("/api/desktop-app/rebuild");
      const elapsed = Date.now() - started;
      const running = await dashboard.get("/api/status");
      await wait(5500);
      const failed = await dashboard.get("/api/status");

      expect(result.response.status).toBe(202);
      expect(elapsed).toBeLessThan(200);
      expect(running.body.desktopApp.rebuild.status).toBe("running");
      expect(failed.body.desktopApp.rebuild.status).toBe("failed");
      expect(failed.body.desktopApp.rebuild.outputTail).toContain("synthetic rebuild failure tail");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("keeps D196 mutation allowlist enforcement around omitted endpoints", async () => {
    const fixture = await makeFixture();
    try {
      const dashboard = await withDashboard(fixture);

      const result = await dashboard.post("/api/desktop-app/not-allowlisted");

      expect(result.response.status).toBe(410);
      expect(result.body.error).toContain("D196 replaced dashboard mutation paths");
      expect(result.body.allowedMutations).toContain("/api/desktop-app/promote");
      expect(result.body.allowedMutations).toContain("/api/desktop-app/rebuild");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces desktop, passive, stable, and behind state", async () => {
    const fixture = await makeFixture();
    try {
      await writeRuntime(fixture.repoRoot, path.join("release", "win-unpacked"), "4444444444444444444444444444444444444444", "old");
      await writeRuntime(fixture.repoRoot, path.join("release", "reciprocal-passive", "win-unpacked"), "5555555555555555555555555555555555555555", "new");
      const dashboard = await withDashboard(fixture);

      const status = await dashboard.get("/api/status");

      expect(status.response.status).toBe(200);
      expect(status.body.desktopApp.current.sourceShortSha).toBe("4444444");
      expect(status.body.desktopApp.passive.sourceShortSha).toBe("5555555");
      expect(status.body.desktopApp.stable.sourceShortSha).toBe(fixture.sha.slice(0, 7));
      expect(status.body.desktopApp.appBehindPassive).toBe(true);
      expect(status.body.desktopApp.defaultAction).toBe("promote-last-verified");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
