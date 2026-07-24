import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startAutomationServer } from "../app/main/automation-server.js";
import { parseDesktopLaunchOptions } from "../app/main/launch-options.js";
import { defaultConfig } from "../src/config/schema.js";

async function waitForCompletedStatus(base: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await fetch(`${base}/status`, { headers }).then((response) => response.json()) as Record<string, unknown>;
    if (typeof status.completedAt === "string") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for automation status to complete.");
}

describe("desktop automation", () => {
  it("is absent unless every explicit opt-in argument is supplied", () => {
    expect(parseDesktopLaunchOptions(["app.exe"])).toEqual({ hidden: false });
    expect(() => parseDesktopLaunchOptions(["--automation-port=4783"])).toThrow(/token-file/);
    expect(parseDesktopLaunchOptions([
      "--hidden",
      "--automation-port=4783",
      "--automation-token-file=C:\\state\\automation.json",
      "--automation-project-dir=C:\\peer"
    ])).toMatchObject({ hidden: true, automation: { port: 4783 } });
  });

  it("requires a bearer token and restricts session/prompt control to one project", async () => {
    const root = path.join(tmpdir(), `tandem-automation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const projectDir = path.join(root, "peer");
    const staleInstructions = "stale worktree tells executor to run retired commands\n";
    const currentInstructions = "current admin-root orchestrator instructions for executor A\n";
    const tokenFile = path.join(root, "state", "automation.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(root, "TANDEM.md"), currentInstructions, "utf8");
    await writeFile(path.join(projectDir, "TANDEM.md"), staleInstructions, "utf8");
    let sessionId: string | undefined;
    let running = false;
    const prompts: string[] = [];
    const service = {
      startSession: async () => {
        sessionId = "session-1";
        return { projectDir, sessionId, config: defaultConfig, defaultProject: false, projectSummary: "test" };
      },
      resumeSession: async (id: string) => ({ id, projectDir, config: defaultConfig, defaultProject: false, projectSummary: "test", events: [] }),
      run: async (prompt: string) => {
        running = true;
        prompts.push(prompt);
        running = false;
      },
      getAutomationState: () => ({ projectDir, sessionId, running, scheduleStatus: { ok: false, path: path.join(projectDir, ".tandem", "schedules.json"), error: "Malformed schedules.json at test path" } })
    };
    const oldInstructionsRoot = process.env.TANDEM_PROJECT_INSTRUCTIONS_ROOT;
    process.env.TANDEM_PROJECT_INSTRUCTIONS_ROOT = root;
    const server = await startAutomationServer({ port: 0, tokenFile, projectDir, instanceId: "A", service });
    try {
      const credentials = JSON.parse(await readFile(tokenFile, "utf8")) as { token: string; port: number };
      const base = `http://127.0.0.1:${credentials.port}`;
      expect((await fetch(`${base}/status`)).status).toBe(401);
      const headers = { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" };
      const forbidden = await fetch(`${base}/session`, { method: "POST", headers, body: JSON.stringify({ projectDir: path.join(root, "other") }) });
      expect(forbidden.status).toBe(403);
      const accepted = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ projectDir, prompt: "claim one turn" }) });
      expect(accepted.status).toBe(202);
      expect(prompts).toEqual(["claim one turn"]);
      await expect(fetch(`${base}/status`, { headers }).then((response) => response.json())).resolves.toMatchObject({
        ok: true,
        instanceId: "A",
        allowedProjectDir: projectDir,
        projectInstructionsRoot: root,
        capabilities: { candidatePreviewArtifactLifecycle: 1 },
        scheduleStatus: { ok: false, error: "Malformed schedules.json at test path" },
      });
      const proof = await fetch(`${base}/project-instructions`, { headers }).then((response) => response.json()) as Record<string, unknown>;
      expect(proof).toMatchObject({
        ok: true,
        projectInstructionsRoot: root,
        instructions: {
          fileName: "TANDEM.md via TANDEM_PROJECT_INSTRUCTIONS_ROOT",
          content: currentInstructions,
          truncated: false,
        },
      });
      expect(JSON.stringify(proof)).not.toContain(staleInstructions);
    } finally {
      if (oldInstructionsRoot === undefined) delete process.env.TANDEM_PROJECT_INSTRUCTIONS_ROOT;
      else process.env.TANDEM_PROJECT_INSTRUCTIONS_ROOT = oldInstructionsRoot;
      await server.close();
    }
  });

  it("clears a stale service running flag after a completed automation run", async () => {
    const root = path.join(tmpdir(), `tandem-automation-stale-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const projectDir = path.join(root, "peer");
    const tokenFile = path.join(root, "state", "automation.json");
    await mkdir(projectDir, { recursive: true });
    const sessionId = "session-1";
    let running = false;
    const prompts: string[] = [];
    const service = {
      startSession: async () => ({ projectDir, sessionId, config: defaultConfig, defaultProject: false, projectSummary: "test" }),
      resumeSession: async (id: string) => ({ id, projectDir, config: defaultConfig, defaultProject: false, projectSummary: "test", events: [] }),
      run: async (prompt: string) => {
        running = true;
        prompts.push(prompt);
      },
      getAutomationState: () => ({ projectDir, sessionId, running })
    };
    const server = await startAutomationServer({ port: 0, tokenFile, projectDir, instanceId: "A", service });
    try {
      const credentials = JSON.parse(await readFile(tokenFile, "utf8")) as { token: string; port: number };
      const base = `http://127.0.0.1:${credentials.port}`;
      const headers = { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" };

      const first = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ projectDir, prompt: "first" }) });
      expect(first.status).toBe(202);
      await expect(waitForCompletedStatus(base, headers)).resolves.toMatchObject({ running: false });

      const second = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ projectDir, prompt: "second" }) });
      expect(second.status).toBe(202);
      expect(prompts).toEqual(["first", "second"]);
    } finally {
      await server.close();
    }
  });
});
