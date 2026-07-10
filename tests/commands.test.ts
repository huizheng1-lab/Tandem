import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchCommand } from "../src/commands/index.js";
import { defaultConfig, type TandemConfig } from "../src/config/schema.js";
import { CostLedger } from "../src/session/cost.js";

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-commands-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function context(cwd: string, config: TandemConfig, setConfig: (config: TandemConfig) => void) {
  return {
    config,
    env: {},
    cwd,
    ledger: new CostLedger(),
    setConfig
  };
}

describe("slash commands", () => {
  it("sets and clears Claude Code CLI model pins", async () => {
    const cwd = await tempDir();
    let config = { ...defaultConfig };

    await expect(dispatchCommand("/model claude-cli haiku", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Claude Code CLI model to haiku.");
    expect(config.claudeCliModel).toBe("haiku");
    await expect(readFile(path.join(cwd, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ claudeCliModel: "haiku" });

    await expect(dispatchCommand("/model claude-cli clear", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Claude Code CLI model to CLI default.");
    expect(config.claudeCliModel).toBeUndefined();
    await expect(readFile(path.join(cwd, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.not.toHaveProperty("claudeCliModel");
  });

  it("sets and clears Codex CLI model pins", async () => {
    const cwd = await tempDir();
    let config = { ...defaultConfig };

    await expect(dispatchCommand("/model codex-cli gpt-5", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Codex CLI model to gpt-5.");
    expect(config.codexCliModel).toBe("gpt-5");

    await expect(dispatchCommand("/model codex-cli default", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Codex CLI model to CLI default.");
    expect(config.codexCliModel).toBeUndefined();
    await expect(readFile(path.join(cwd, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.not.toHaveProperty("codexCliModel");
  });

  it("sets, clears, and validates Codex CLI reasoning effort", async () => {
    const cwd = await tempDir();
    let config = { ...defaultConfig };

    await expect(dispatchCommand("/model codex-effort medium", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Codex CLI reasoning effort to medium.");
    expect(config.codexCliReasoningEffort).toBe("medium");

    await expect(dispatchCommand("/model codex-effort turbo", context(cwd, config, (next) => (config = next)))).resolves.toBe("Usage: /model codex-effort <minimal|low|medium|high|clear>");
    expect(config.codexCliReasoningEffort).toBe("medium");

    await expect(dispatchCommand("/model codex-effort clear", context(cwd, config, (next) => (config = next)))).resolves.toBe("Set Codex CLI reasoning effort to CLI default.");
    expect(config.codexCliReasoningEffort).toBeUndefined();
    await expect(readFile(path.join(cwd, ".tandem", "config.json"), "utf8").then(JSON.parse)).resolves.not.toHaveProperty("codexCliReasoningEffort");
  });
});
