import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startAutomationServer } from "../app/main/automation-server.js";
import { parseDesktopLaunchOptions } from "../app/main/launch-options.js";
import { defaultConfig } from "../src/config/schema.js";

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
    const tokenFile = path.join(root, "state", "automation.json");
    await mkdir(projectDir, { recursive: true });
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
      getAutomationState: () => ({ projectDir, sessionId, running })
    };
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
      await expect(fetch(`${base}/status`, { headers }).then((response) => response.json())).resolves.toMatchObject({ ok: true, instanceId: "A", allowedProjectDir: projectDir });
    } finally {
      await server.close();
    }
  });
});
