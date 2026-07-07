import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveAgents } from "../src/agents/live.js";
import { buildClaudeExecArgv, claudePermissionFor, parseClaudeEnvelope, runClaudeExec } from "../src/agents/claude-code-cli/exec.js";
import { clearClaudeCliPathCache, locateClaudeCli } from "../src/agents/claude-code-cli/locate.js";
import { buildClaudeWorkerPrompt } from "../src/agents/claude-code-cli/worker.js";
import { buildPlanJsonSchema, completionReportJsonSchema, stripNulls } from "../src/agents/codex-cli/schema-json.js";
import { defaultConfig } from "../src/config/schema.js";
import type { BuildPlan } from "../src/orchestrator/artifacts.js";
import type { ModelEntry } from "../src/providers/registry.js";
import { CostLedger } from "../src/session/cost.js";

async function tempDir(name: string): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeNodeShim(name: string, source: string): Promise<string> {
  const dir = await tempDir(name);
  const script = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const js = path.join(dir, `${name}.js`);
  await writeFile(js, source, "utf8");
  if (process.platform === "win32") {
    await writeFile(script, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, "utf8");
  } else {
    await writeFile(script, `#!/bin/sh\n"${process.execPath}" "${js}" "$@"\n`, "utf8");
    await chmod(script, 0o755);
  }
  return script;
}

async function fakeClaudeScript(mode: "auto" | "completion" | "answer" = "auto"): Promise<string> {
  return makeNodeShim(
    "claude",
    `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.144 (Claude Code)"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] || "";
const schema = args[args.indexOf("--json-schema") + 1] || "";
const mode = ${JSON.stringify(mode)};
let structured_output;
let result = "claude result text";
if (mode === "completion" || schema.includes("taskResults")) {
  structured_output = { status: "complete", summary: "claude worker done", taskResults: [{ id: "T1", status: "done", notes: null }], filesChanged: ["hello.txt"], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] };
} else if (schema.includes("plan") && (/Create hello/.test(prompt) || /implementation/.test(prompt))) {
  structured_output = { kind: "implementation", answer: null, plan: { title: "Hello", objective: "Create hello file", constraints: [], tasks: [{ id: "T1", description: "Create file", files: null }], acceptanceCriteria: ["file exists"], verification: ["npm test"] } };
} else if (mode === "answer" || schema.includes("kind")) {
  result = "4";
  structured_output = { kind: "question", answer: "4", plan: null };
} else if (schema.includes("verdict")) {
  structured_output = { verdict: "approve", scores: { correctness: 5, planAdherence: 5, codeQuality: 5 }, feedback: [], userSummary: "approved" };
} else {
  structured_output = { report: { status: "complete", summary: "takeover", taskResults: [{ id: "T1", status: "done", notes: null }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }, userSummary: "takeover" };
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, structured_output, usage: { input_tokens: 18, cache_creation_input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.25, permission_denials: [] }));
`
  );
}

async function fakeCodexScript(): Promise<string> {
  return makeNodeShim(
    "codex",
    `
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.142.5"); process.exit(0); }
const output = args[args.indexOf("--output-last-message") + 1];
const value = { kind: "implementation", answer: null, plan: { title: "Hello", objective: "Create hello file", constraints: [], tasks: [{ id: "T1", description: "Create file", files: null }], acceptanceCriteria: ["file exists"], verification: ["npm test"] } };
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
fs.writeFileSync(output, JSON.stringify(value));
`
  );
}

const claudeEntry: ModelEntry = { id: "claude-code/cli", provider: "claude-code-cli", modelName: "", contextWindow: 200000 };

describe("claude code cli discovery", () => {
  it("uses config or env override before PATH", () => {
    clearClaudeCliPathCache();
    const found = path.join("C:/bin", process.platform === "win32" ? "claude.cmd" : "claude");
    expect(
      locateClaudeCli({
        env: { PATH: "C:/bin" },
        overridePath: "C:/Claude/claude.cmd",
        pathSeparator: path.delimiter,
        exists: (filePath) => filePath === found || filePath === "C:/Claude/claude.cmd"
      })
    ).toBe("C:/Claude/claude.cmd");
  });

  it("finds claude on PATH", () => {
    clearClaudeCliPathCache();
    const found = path.join("C:/bin", process.platform === "win32" ? "claude.cmd" : "claude");
    expect(locateClaudeCli({ env: { PATH: "C:/bin" }, pathSeparator: path.delimiter, exists: (filePath) => filePath === found })).toBe(found);
  });

  it("uses config or env override when PATH does not contain claude", () => {
    clearClaudeCliPathCache();
    expect(locateClaudeCli({ overridePath: "C:/Claude/claude.cmd", exists: (filePath) => filePath === "C:/Claude/claude.cmd" })).toBe("C:/Claude/claude.cmd");
  });
});

describe("claude code cli execution", () => {
  it("builds argv with inline shared schema, no persistence, model, and read-only tools", () => {
    expect(
      buildClaudeExecArgv({
        prompt: "answer",
        schema: buildPlanJsonSchema,
        permissionMode: "plan",
        modelName: "haiku",
        readOnly: true
      })
    ).toEqual(["-p", "answer", "--output-format", "json", "--json-schema", JSON.stringify(buildPlanJsonSchema), "--permission-mode", "plan", "--no-session-persistence", "--tools", "Read,Grep,Glob", "--model", "haiku"]);
  });

  it("maps Tandem permission modes to Claude Code permission modes", () => {
    expect(claudePermissionFor("ask")).toBe("bypassPermissions");
    expect(claudePermissionFor("auto-edit")).toBe("acceptEdits");
    expect(claudePermissionFor("yolo")).toBe("bypassPermissions");
    expect(claudePermissionFor("yolo", true)).toBe("plan");
  });

  it("parses result prose separately from structured output and records direct cost", () => {
    const ledger = new CostLedger();
    const text: string[] = [];
    const output = parseClaudeEnvelope(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "clean text",
        structured_output: { answer: "4", unused: null },
        usage: { input_tokens: 18, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
        total_cost_usd: 0.125,
        permission_denials: []
      }),
      { role: "leader", entry: claudeEntry, ledger, onText: (value) => text.push(value) }
    );

    expect(output).toEqual({ answer: "4" });
    expect(text).toEqual(["clean text"]);
    expect(ledger.totals().leader).toMatchObject({ inputTokens: 23, outputTokens: 5, dollars: 0.125 });
  });

  it("surfaces permission denials as diagnostic failures", () => {
    expect(() =>
      parseClaudeEnvelope(
        JSON.stringify({
          result: "done",
          structured_output: { answer: "4" },
          permission_denials: [{ tool_name: "Write", tool_input: { file_path: "x" } }],
          usage: {},
          total_cost_usd: 0
        }),
        { role: "leader", entry: claudeEntry, ledger: new CostLedger() }
      )
    ).toThrow(/permission denials.*Write/);
  });

  it("runs a fake claude executable and validates envelope JSON", async () => {
    const cwd = await tempDir("project");
    const claudeCliPath = await fakeClaudeScript("completion");
    const ledger = new CostLedger();
    const output = await runClaudeExec({
      cwd,
      prompt: "build",
      schema: "completion-report",
      permissionMode: "yolo",
      claudeCliPath,
      env: { ...process.env, PATH: path.dirname(claudeCliPath) },
      role: "worker",
      entry: claudeEntry,
      ledger
    });

    expect(output).toMatchObject({ status: "complete", summary: "claude worker done" });
    expect(JSON.stringify(output)).not.toContain("notes");
    expect(ledger.totals().worker.dollars).toBe(0.25);
  });

  it("reuses the stricter shared Codex schema helpers", () => {
    expect(completionReportJsonSchema.required).toContain("taskResults");
    expect(stripNulls({ taskResults: [{ notes: null }] })).toEqual({ taskResults: [{}] });
  });
});

describe("claude code cli mixed roles", () => {
  const plan: BuildPlan = {
    title: "Hello",
    objective: "Create hello file",
    constraints: [],
    tasks: [{ id: "T1", description: "Create file" }],
    acceptanceCriteria: ["file exists"],
    verification: ["npm test"]
  };

  it("gives Claude Code CLI workers the same verification and project instructions as SDK workers", async () => {
    const prompt = await buildClaudeWorkerPrompt(
      {
        env: { ComSpec: "powershell.exe" },
        projectInstructions: async () => "Project instructions:\n- Use the local style."
      },
      { plan, round: 1, feedback: [] }
    );

    expect(prompt).toContain("Project instructions:\n- Use the local style.");
    expect(prompt).toContain("Host: Windows");
    expect(prompt).toContain("If read_file says you CANNOT view a file's visual content");
    expect(prompt).toContain("In verificationResults[].command, repeat the BuildPlan verification command string verbatim.");
    expect(prompt).toContain("BuildPlan:");
  });

  it("supports Gemini leader plus Claude Code CLI worker", async () => {
    const cwd = await tempDir("project");
    const claudeCliPath = await fakeClaudeScript("completion");
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "google/gemini-2.5-flash", worker: "claude-code/cli", permissionMode: "yolo", claudeCliPath },
      cwd,
      env: { ...process.env, PATH: path.dirname(claudeCliPath), GEMINI_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.build({ plan, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
  });

  it("supports Claude Code CLI leader plus MiniMax worker", async () => {
    const cwd = await tempDir("project");
    const claudeCliPath = await fakeClaudeScript("answer");
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "claude-code/cli", worker: "minimax/minimax-m2.7", permissionMode: "yolo", claudeCliPath },
      cwd,
      env: { ...process.env, PATH: path.dirname(claudeCliPath), MINIMAX_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.plan({ request: "What is 2+2?", goals: [] })).resolves.toEqual({ kind: "answer", answer: "4" });
  });

  it("supports Codex CLI leader plus Claude Code CLI worker", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const claudeCliPath = await fakeClaudeScript("completion");
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "codex/cli", worker: "claude-code/cli", permissionMode: "yolo", codexCliPath, claudeCliPath },
      cwd,
      env: { ...process.env, PATH: path.dirname(claudeCliPath) },
      ledger: new CostLedger()
    });

    const planned = await agents.plan({ request: "Create hello.txt with hi", goals: [] });
    expect(planned).toMatchObject({ kind: "plan" });
    if (planned.kind === "plan") {
      await expect(agents.build({ plan: planned.plan, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
    }
  });
});
