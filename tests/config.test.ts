import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { resolveModel, validateModelEnv } from "../src/providers/registry.js";

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
  });

  it("names the missing env var for selected models", () => {
    const entry = resolveModel("openai/gpt-5", []);
    expect(() => validateModelEnv(entry, {})).toThrow(/OPENAI_API_KEY/);
  });
});
