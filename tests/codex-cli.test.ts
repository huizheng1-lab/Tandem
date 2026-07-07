import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveAgents } from "../src/agents/live.js";
import { buildCodexExecArgv, handleCodexJsonLine, runCodexExec } from "../src/agents/codex-cli/exec.js";
import { clearCodexCliPathCache, locateCodexCli } from "../src/agents/codex-cli/locate.js";
import { jsonSchemaFor } from "../src/agents/codex-cli/schema-json.js";
import { defaultConfig } from "../src/config/schema.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";
import { CostLedger } from "../src/session/cost.js";
import type { ModelEntry } from "../src/providers/registry.js";

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function fakeCodexScript(): Promise<string> {
  const dir = await tempDir("fake-codex");
  const script = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const js = path.join(dir, "fake-codex.js");
  await writeFile(
    js,
    `
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.142.5"); process.exit(0); }
const output = args[args.indexOf("--output-last-message") + 1];
const schema = args[args.indexOf("--output-schema") + 1] || "";
const prompt = args.join(" ");
const counterFile = __filename + ".count";
let count = 0;
try { count = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(counterFile, String(count));
console.log(JSON.stringify({ type: "thread.started", thread_id: "test" }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "node -v", aggregated_output: "", exit_code: null, status: "in_progress" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "node -v", exit_code: 0, status: "completed" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24680, cached_input_tokens: 21760, output_tokens: 51, reasoning_output_tokens: 2 } }));
let value;
if (schema.includes("completion-report")) {
  value = { status: "complete", summary: "codex worker done", taskResults: [{ id: "T1", status: "done" }], filesChanged: ["hello35.txt"], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] };
} else if (schema.includes("plan-or-answer") && (/Create hello/.test(prompt) || count > 1)) {
  value = { kind: "implementation", plan: { title: "Hello", objective: "Create hello file", constraints: [], tasks: [{ id: "T1", description: "Create file" }], acceptanceCriteria: ["file exists"], verification: ["npm test"] } };
} else if (schema.includes("plan-or-answer")) {
  value = { kind: "question", answer: "4" };
} else if (schema.includes("review-verdict")) {
  value = { verdict: "approve", scores: { correctness: 5, planAdherence: 5, codeQuality: 5 }, feedback: [], userSummary: "approved" };
} else {
  value = { report: { status: "complete", summary: "takeover", taskResults: [{ id: "T1", status: "done" }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }, userSummary: "takeover" };
}
fs.writeFileSync(output, JSON.stringify(value));
console.log(JSON.stringify(value));
`,
    "utf8"
  );
  if (process.platform === "win32") {
    await writeFile(script, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, "utf8");
  } else {
    await writeFile(script, `#!/bin/sh\n"${process.execPath}" "${js}" "$@"\n`, "utf8");
    await chmod(script, 0o755);
  }
  return script;
}

const codexEntry: ModelEntry = { id: "codex/cli", provider: "codex-cli", modelName: "", contextWindow: 256000 };

describe("codex cli discovery", () => {
  it("uses config or env override first", () => {
    clearCodexCliPathCache();
    expect(locateCodexCli({ overridePath: "C:/Codex/codex.exe", exists: (filePath) => filePath === "C:/Codex/codex.exe" })).toBe("C:/Codex/codex.exe");
  });

  it("finds codex on PATH", () => {
    clearCodexCliPathCache();
    const found = path.join("C:/bin", process.platform === "win32" ? "codex.exe" : "codex");
    expect(locateCodexCli({ env: { PATH: "C:/bin" }, pathSeparator: path.delimiter, exists: (filePath) => filePath === found })).toBe(found);
  });

  it("chooses the newest Windows fallback install", () => {
    clearCodexCliPathCache();
    const local = "C:/Users/me/AppData/Local";
    const oldPath = path.join(local, "OpenAI", "Codex", "bin", "old", "codex.exe");
    const newPath = path.join(local, "OpenAI", "Codex", "bin", "new", "codex.exe");
    expect(
      locateCodexCli({
        platform: "win32",
        env: { LOCALAPPDATA: local },
        exists: (filePath) => filePath.endsWith(path.join("OpenAI", "Codex", "bin")) || filePath === oldPath || filePath === newPath,
        readdir: () => ["old", "new"],
        stat: (filePath) => ({ mtimeMs: filePath === newPath ? 2 : 1 })
      })
    ).toBe(newPath);
  });
});

describe("codex cli execution", () => {
  it("builds the expected exec argv", () => {
    expect(
      buildCodexExecArgv({
        cwd: "C:/project",
        sandbox: "workspace-write",
        schemaPath: "schema.json",
        outputPath: "out.json",
        prompt: "do work",
        modelName: "gpt-5.5"
      })
    ).toEqual([
      "exec",
      "-C",
      "C:/project",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--output-schema",
      "schema.json",
      "--output-last-message",
      "out.json",
      "-m",
      "gpt-5.5",
      "do work"
    ]);
  });

  it("parses JSONL events into text, tool events, and usage", () => {
    const ledger = new CostLedger();
    const text: string[] = [];
    const tools: unknown[] = [];
    const active = new Map<string, number>();
    const options = { role: "worker" as const, entry: codexEntry, ledger, onText: (value: string) => text.push(value), onToolEvent: (event: unknown) => tools.push(event) };
    handleCodexJsonLine('{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"npm test","status":"in_progress"}}', options, active);
    handleCodexJsonLine('{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}', options, active);
    handleCodexJsonLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}', options, active);
    handleCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"reasoning_output_tokens":3}}', options, active);

    expect(text).toEqual(["done"]);
    expect(tools).toHaveLength(2);
    expect(ledger.totals().worker).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("runs a fake codex executable and validates output file JSON", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const ledger = new CostLedger();
    const output = await runCodexExec({
      cwd,
      prompt: "build",
      schema: "completion-report",
      permissionMode: "yolo",
      codexCliPath,
      role: "worker",
      entry: codexEntry,
      ledger
    });

    expect(output).toMatchObject({ status: "complete", summary: "codex worker done" });
    expect(ledger.totals().worker.inputTokens).toBe(24680);
  });

  it("exposes hand-rolled schemas for every Codex artifact kind", () => {
    expect(jsonSchemaFor("completion-report")).toMatchObject({ type: "object" });
    expect(JSON.stringify(jsonSchemaFor("plan-or-answer"))).toContain("implementation");
    expect(JSON.stringify(jsonSchemaFor("takeover"))).toContain("userSummary");
  });
});

describe("codex cli mixed roles", () => {
  const plan: BuildPlan = {
    title: "Hello",
    objective: "Create hello file",
    constraints: [],
    tasks: [{ id: "T1", description: "Create file" }],
    acceptanceCriteria: ["file exists"],
    verification: ["npm test"]
  };

  it("supports API leader plus Codex CLI worker", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "openai/gpt-5-mini", worker: "codex/cli", permissionMode: "yolo", codexCliPath },
      cwd,
      env: { OPENAI_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.build({ plan, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
  });

  it("supports Codex CLI leader plus API worker", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "codex/cli", worker: "openai/gpt-5-mini", permissionMode: "yolo", codexCliPath },
      cwd,
      env: { OPENAI_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.plan({ request: "What is 2+2?", goals: [] })).resolves.toEqual({ kind: "answer", answer: "4" });
    await expect(agents.plan({ request: "Create hello35.txt with hi", goals: [] })).resolves.toMatchObject({ kind: "plan" });
  });
});
