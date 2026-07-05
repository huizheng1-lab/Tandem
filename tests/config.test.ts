import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globalConfigPath, loadConfig, loadConfigDetails, loadEnv, saveGlobalConfigPatch } from "../src/config/load.js";
import { resolveModel, validateModelEnv } from "../src/providers/registry.js";
import { sessionDir } from "../src/session/store.js";

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("config", () => {
  it("merges defaults < global < project < flags", async () => {
    const home = await tempDir("home");
    const cwd = await tempDir("cwd");
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await mkdir(path.join(cwd, ".tandem"), { recursive: true });
    await writeFile(path.join(home, ".tandem", "config.json"), JSON.stringify({ maxReviewRounds: 4, leader: "openai/gpt-5" }));
    await writeFile(path.join(cwd, ".tandem", "config.json"), JSON.stringify({ maxReviewRounds: 2, worker: "openai/gpt-5-mini" }));

    const config = loadConfig({ cwd, homeDir: home, flags: { maxReviewRounds: 7 } });
    expect(config.leader).toBe("openai/gpt-5");
    expect(config.worker).toBe("openai/gpt-5-mini");
    expect(config.maxReviewRounds).toBe(7);
    expect(config.permissionMode).toBe("ask");
    expect(config.showThinking).toBe(false);
  });

  it("tracks project config fields that override global defaults", async () => {
    const home = await tempDir("home");
    const cwd = await tempDir("cwd");
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await mkdir(path.join(cwd, ".tandem"), { recursive: true });
    await writeFile(path.join(home, ".tandem", "config.json"), JSON.stringify({ permissionMode: "yolo", worker: "openai/gpt-5-mini" }));
    await writeFile(path.join(cwd, ".tandem", "config.json"), JSON.stringify({ permissionMode: "ask" }));

    const details = loadConfigDetails({ cwd, homeDir: home });

    expect(details.config.permissionMode).toBe("ask");
    expect(details.globalConfig.permissionMode).toBe("yolo");
    expect(details.projectOverrides).toContain("permissionMode");
    expect(details.projectOverrides).not.toContain("worker");
  });

  it("saves global config patches for future project defaults", async () => {
    const home = await tempDir("home");
    await saveGlobalConfigPatch({ permissionMode: "yolo", leader: "openai/gpt-5" }, home);
    await saveGlobalConfigPatch({ worker: "openai/gpt-5-mini" }, home);

    const saved = JSON.parse(await readFile(globalConfigPath(home), "utf8")) as Record<string, unknown>;

    expect(saved).toMatchObject({ permissionMode: "yolo", leader: "openai/gpt-5", worker: "openai/gpt-5-mini" });
    expect(loadConfig({ cwd: await tempDir("cwd"), homeDir: home }).permissionMode).toBe("yolo");
  });

  it("uses TANDEM_HOME for default global state paths", async () => {
    const cwd = await tempDir("cwd");
    const tandemHome = await tempDir("tandem-home");
    const previous = process.env.TANDEM_HOME;
    process.env.TANDEM_HOME = tandemHome;
    try {
      await writeFile(path.join(tandemHome, "config.json"), JSON.stringify({ worker: "openai/gpt-5-mini" }));
      await writeFile(path.join(tandemHome, ".env"), "OPENAI_API_KEY=test-key\n", "utf8");

      expect(globalConfigPath()).toBe(path.join(tandemHome, "config.json"));
      expect(sessionDir(cwd)).toContain(path.join(tandemHome, "sessions"));
      expect(loadConfig({ cwd }).worker).toBe("openai/gpt-5-mini");
      expect(loadEnv(cwd, undefined, {}).OPENAI_API_KEY).toBe("test-key");
    } finally {
      if (previous === undefined) delete process.env.TANDEM_HOME;
      else process.env.TANDEM_HOME = previous;
    }
  });

  it("names the missing env var for selected models", () => {
    const entry = resolveModel("openai/gpt-5", []);
    expect(() => validateModelEnv(entry, {})).toThrow(/OPENAI_API_KEY/);
  });
});
