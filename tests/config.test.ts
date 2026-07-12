import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globalConfigPath, loadConfig, loadConfigDetails, loadEnv, saveGlobalConfigPatch } from "../src/config/load.js";
import { resolveModel, validateModelEnv } from "../src/providers/registry.js";
import { makeModel } from "../src/providers/client.js";
import { buildCodexExecArgv } from "../src/agents/codex-cli/exec.js";
import { buildClaudeExecArgv } from "../src/agents/claude-code-cli/exec.js";
import { defaultConfig } from "../src/config/schema.js";
import { sessionDir } from "../src/session/store.js";
import { withConfiguredCliModel } from "../src/providers/cli-models.js";

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
    expect(config.triage).toBe("auto");
    expect(config.showThinking).toBe(false);
    expect(config.desktopTheme).toBe("auto");
  });

  it("allows triage to be forced back to the old always-plan behavior", async () => {
    const home = await tempDir("home");
    const cwd = await tempDir("cwd");
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await writeFile(path.join(home, ".tandem", "config.json"), JSON.stringify({ triage: "always-plan" }));

    expect(loadConfig({ cwd, homeDir: home }).triage).toBe("always-plan");
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

  it("allows native-provider custom models without baseURL", async () => {
    const home = await tempDir("home");
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await writeFile(
      path.join(home, ".tandem", "config.json"),
      JSON.stringify({
        customModels: [{ id: "google/custom-flash", provider: "google", apiKeyEnv: "GEMINI_API_KEY", modelName: "gemini-custom-flash" }]
      })
    );

    const config = loadConfig({ homeDir: home, cwd: await tempDir("cwd") });
    const entry = resolveModel("google/custom-flash", config.customModels);

    expect(entry).toMatchObject({ id: "google/custom-flash", provider: "google", modelName: "gemini-custom-flash", envKey: "GEMINI_API_KEY" });
    expect(entry.baseURL).toBeUndefined();
  });

  it("keeps provider-less custom models openai-compatible for back compatibility", () => {
    const entry = resolveModel("minimax/minimax-m2.7", defaultConfig.customModels);

    expect(entry).toMatchObject({ provider: "openai-compatible", baseURL: "https://api.minimax.io/v1" });
  });

  it("requires baseURL only for openai-compatible custom models", async () => {
    const home = await tempDir("home");
    await mkdir(path.join(home, ".tandem"), { recursive: true });
    await writeFile(
      path.join(home, ".tandem", "config.json"),
      JSON.stringify({
        customModels: [{ id: "compatible/no-url", provider: "openai-compatible", apiKeyEnv: "API_KEY", modelName: "model" }]
      })
    );

    expect(() => loadConfig({ homeDir: home, cwd: path.join(home, "project") })).toThrow(/baseURL is required/);
  });

  it("routes google custom models through the native provider", async () => {
    const config = {
      ...defaultConfig,
      customModels: [{ id: "google/custom-flash", provider: "google" as const, apiKeyEnv: "GEMINI_API_KEY", modelName: "gemini-custom-flash" }]
    };

    const resolution = await makeModel("google/custom-flash", config, { GEMINI_API_KEY: "test-key" });

    expect(resolution.entry.provider).toBe("google");
    expect(resolution.entry.modelName).toBe("gemini-custom-flash");
    expect(resolution.model).toBeTruthy();
  });

  it("pins built-in CLI model names from config without changing defaults", async () => {
    const cwd = await tempDir("cli-models");
    const codexCliPath = path.join(cwd, process.platform === "win32" ? "codex.exe" : "codex");
    const claudeCliPath = path.join(cwd, process.platform === "win32" ? "claude.exe" : "claude");
    await writeFile(codexCliPath, "", "utf8");
    await writeFile(claudeCliPath, "", "utf8");

    const codexDefault = await makeModel("codex/cli", { ...defaultConfig, codexCliPath }, { CODEX_CLI_PATH: codexCliPath });
    expect(codexDefault.entry.modelName).toBe("");

    const codexPinned = await makeModel("codex/cli", { ...defaultConfig, codexCliPath, codexCliModel: "gpt-5-mini", codexCliReasoningEffort: "medium" }, { CODEX_CLI_PATH: codexCliPath });
    expect(codexPinned.entry.modelName).toBe("gpt-5-mini");
    expect(
      buildCodexExecArgv({
        cwd,
        sandbox: "workspace-write",
        schemaPath: "schema.json",
        outputPath: "out.json",
        prompt: "do work",
        modelName: codexPinned.entry.modelName,
        modelReasoningEffort: "medium"
      })
    ).toEqual(expect.arrayContaining(["-m", "gpt-5-mini", "-c", "model_reasoning_effort=medium"]));

    const claudePinned = await makeModel("claude-code/cli", { ...defaultConfig, claudeCliPath, claudeCliModel: "haiku" }, { CLAUDE_CLI_PATH: claudeCliPath });
    expect(claudePinned.entry.modelName).toBe("haiku");
    expect(
      buildClaudeExecArgv({
        prompt: "answer",
        systemPrompt: "rules",
        schema: { type: "object" },
        permissionMode: "plan",
        modelName: claudePinned.entry.modelName
      })
    ).toEqual(expect.arrayContaining(["--model", "haiku"]));
  });

  it("registers the current Gemini 3.x built-ins without guessed pricing", () => {
    for (const id of ["google/gemini-3.5-flash", "google/gemini-3.1-pro-preview", "google/gemini-3-pro-preview", "google/gemini-3.1-flash-lite"]) {
      const entry = resolveModel(id, []);
      expect(entry).toMatchObject({ provider: "google", envKey: "GEMINI_API_KEY", media: { images: true, pdf: true } });
      expect(entry.costHints).toBeUndefined();
    }
    expect(() => resolveModel("google/gemini-3.5-pro", [])).toThrow(/Unknown model/);
  });

  it("D98: default MiniMax M3 custom model includes standard-tier cost hints", () => {
    const entry = resolveModel("minimax/minimax-m3", defaultConfig.customModels);
    expect(entry.costHints).toEqual({ inputPerMillion: 0.3, outputPerMillion: 1.2 });
  });

  it("D100: MiniMax M3 cannot resolve to a CLI-backed provider", () => {
    const entry = withConfiguredCliModel(resolveModel("minimax/minimax-m3", defaultConfig.customModels), defaultConfig);
    expect(entry.provider).toBe("openai-compatible");
  });

  it("allows custom models to override media capabilities", () => {
    const entry = resolveModel("compatible/vision", [
      {
        id: "compatible/vision",
        provider: "openai-compatible",
        baseURL: "https://example.test/v1",
        apiKeyEnv: "VISION_KEY",
        modelName: "vision-model",
        media: { images: true }
      }
    ]);

    expect(entry.media).toEqual({ images: true });
  });
});
