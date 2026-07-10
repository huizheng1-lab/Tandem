import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveAgents } from "../src/agents/live.js";
import { buildClaudeExecArgv, claudePermissionFor, parseClaudeEnvelope, RateLimitError, runClaudeExec } from "../src/agents/claude-code-cli/exec.js";
import { buildClaudeLeaderPlanPrompts, buildClaudeLeaderReviewPrompts, buildClaudeLeaderTakeoverPrompts, claudeLeaderReview, claudeLeaderTakeover } from "../src/agents/claude-code-cli/leader.js";
import { clearClaudeCliPathCache, locateClaudeCli } from "../src/agents/claude-code-cli/locate.js";
import { buildClaudeWorkerPrompts } from "../src/agents/claude-code-cli/worker.js";
import { buildPlanJsonSchema, completionReportJsonSchema, stripNulls } from "../src/agents/codex-cli/schema-json.js";
import { defaultConfig } from "../src/config/schema.js";
import type { BuildPlan, CompletionReport } from "../src/orchestrator/artifacts.js";
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
    const found = path.join("C:/bin", process.platform === "win32" ? "node_modules/@anthropic-ai/claude-code/bin/claude.exe" : "claude");
    expect(locateClaudeCli({ env: { PATH: "C:/bin" }, pathSeparator: path.delimiter, exists: (filePath) => filePath === found })).toBe(found);
  });

  it("prefers Anthropic's Windows executable over the cmd shim", () => {
    clearClaudeCliPathCache();
    const exe = path.join("C:/bin", "node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    const cmd = path.join("C:/bin", "claude.cmd");
    expect(
      locateClaudeCli({
        env: { PATH: "C:/bin" },
        pathSeparator: path.delimiter,
        platform: "win32",
        exists: (filePath) => filePath === exe || filePath === cmd
      })
    ).toBe(exe);
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
        systemPrompt: "system rules",
        schema: buildPlanJsonSchema,
        permissionMode: "plan",
        modelName: "haiku",
        readOnly: true
      })
    ).toEqual([
      "-p",
      "answer",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(buildPlanJsonSchema),
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      "--system-prompt",
      "system rules",
      "--tools",
      "Read,Grep,Glob",
      "--model",
      "haiku"
    ]);
  });

  it("D68-2: appends --max-budget-usd when maxBudgetUsd is set (omits when not)", () => {
    const baseInput = {
      prompt: "answer",
      systemPrompt: "system rules",
      schema: buildPlanJsonSchema,
      permissionMode: "bypassPermissions" as const,
      modelName: "haiku"
    };
    // Without maxBudgetUsd - flag should be absent.
    expect(buildClaudeExecArgv(baseInput)).not.toContain("--max-budget-usd");
    // With maxBudgetUsd set - flag should be present with the stringified value.
    expect(buildClaudeExecArgv({ ...baseInput, maxBudgetUsd: 2.0 })).toEqual(
      expect.arrayContaining(["--max-budget-usd", "2"])
    );
    // With maxBudgetUsd 0 - flag should be absent (the buildClaudeExecArgv guard
    // `> 0` skips zero/negative).
    expect(buildClaudeExecArgv({ ...baseInput, maxBudgetUsd: 0 })).not.toContain("--max-budget-usd");
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
      systemPrompt: "Return a completion report.",
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

  it("splits Claude Code leader planning rules from the user request", async () => {
    const prompts = await buildClaudeLeaderPlanPrompts(
      {
        env: { ComSpec: "powershell.exe" },
        cwd: "C:/test",
        projectInstructions: async () => "Project instructions:\n- Use the local style."
      },
      { request: "What is 9 times 9?", goals: ["Goal 1: Ship"], history: "USER: hello" }
    );

    expect(prompts.systemPrompt).toContain("Project instructions:\n- Use the local style.");
    expect(prompts.systemPrompt).toContain("FIRST, classify the request:");
    expect(prompts.systemPrompt).not.toContain("Request: What is 9 times 9?");
    expect(prompts.prompt).toMatch(/^Request: What is 9 times 9\?/);
    expect(prompts.prompt.indexOf("Request: What is 9 times 9?")).toBeLessThan(prompts.prompt.indexOf("Conversation so far:"));
    expect(prompts.prompt).toContain("Conversation so far:");
    expect(prompts.prompt).toContain("Standing goals:");
    expect(prompts.prompt).toContain("Request: What is 9 times 9?");
    expect(prompts.prompt).not.toContain("FIRST, classify the request:");
    // D47: must not contain the "single non-interactive call" preamble, which D44-isolated testing showed collides with Claude Code CLI's turn/session control logic and triggers an empty/error envelope.
    expect(prompts.prompt).not.toContain("This is a single non-interactive call");
    expect(prompts.prompt).not.toContain("Act on the request below now");
  });

  it("omits empty Claude Code leader context placeholders", async () => {
    const prompts = await buildClaudeLeaderPlanPrompts({ env: {}, cwd: "C:/test", projectInstructions: async () => "Project instructions:\nnone" }, { request: "What is 9 times 9?", goals: [], history: "" });

    expect(prompts.prompt).toMatch(/^Request: What is 9 times 9\?/);
    expect(prompts.prompt).toContain("Request: What is 9 times 9?");
    expect(prompts.prompt).not.toContain("Conversation so far:");
    expect(prompts.prompt).not.toContain("Standing goals:");
    expect(prompts.prompt).not.toContain("\nnone");
  });

  it("gives Claude Code CLI workers the same verification and project instructions as SDK workers", async () => {
    const prompts = await buildClaudeWorkerPrompts(
      {
        env: { ComSpec: "powershell.exe" },
        projectInstructions: async () => "Project instructions:\n- Use the local style."
      },
      { plan, streamId: "__default__", tasks: plan.tasks, verification: plan.verification, round: 1, feedback: [] }
    );

    expect(prompts.systemPrompt).toContain("Project instructions:\n- Use the local style.");
    expect(prompts.systemPrompt).toContain("Host: Windows");
    expect(prompts.systemPrompt).toContain("If read_file says you CANNOT view a file's visual content");
    expect(prompts.systemPrompt).toContain("In verificationResults[].command, repeat the BuildPlan verification command string verbatim.");
    expect(prompts.systemPrompt).not.toContain("BuildPlan:");
    expect(prompts.prompt).toMatch(/^BuildPlan:/);
    expect(prompts.prompt.indexOf("BuildPlan:")).toBeLessThan(prompts.prompt.indexOf("Round 1"));
    expect(prompts.prompt).toContain("BuildPlan:");
    expect(prompts.prompt).not.toContain("Project instructions:\n- Use the local style.");
    // D47: no preamble, no "Worker task:" lead-in.
    expect(prompts.prompt).not.toContain("This is a single non-interactive call");
    expect(prompts.prompt).not.toContain("Worker task: build now from this worker task context.");
  });

  it("places the request/BuildPlan as the first content of leader review and takeover prompts", async () => {
    const reviewOptions = {
      env: { ComSpec: "powershell.exe" },
      cwd: "C:/test",
      projectInstructions: async () => "Project instructions:\n- Use the local style."
    };
    const reviewReport: CompletionReport = {
      status: "complete",
      summary: "ok",
      taskResults: [{ id: "T1", status: "done" }],
      filesChanged: [],
      verificationResults: [{ command: "npm test", passed: true, output: "ok" }],
      deviationsFromPlan: []
    };
    const reviewPrompts = await buildClaudeLeaderReviewPrompts(reviewOptions, { plan, report: reviewReport, round: 1, diff: "(empty diff)" });
    expect(reviewPrompts.prompt).toMatch(/^Review round 1\./);
    expect(reviewPrompts.prompt.indexOf("Review round 1.")).toBeLessThan(reviewPrompts.prompt.indexOf("BuildPlan:"));
    expect(reviewPrompts.prompt).toContain("BuildPlan:");
    expect(reviewPrompts.prompt).not.toContain("This is a single non-interactive call");
    expect(reviewPrompts.prompt).not.toContain("Review task: review the completed work now");

    const takeoverPrompts = await buildClaudeLeaderTakeoverPrompts(reviewOptions, { plan, reports: [reviewReport], feedback: [] });
    expect(takeoverPrompts.prompt).toMatch(/^BuildPlan:/);
    expect(takeoverPrompts.prompt).toContain("BuildPlan:");
    expect(takeoverPrompts.prompt).not.toContain("This is a single non-interactive call");
    expect(takeoverPrompts.prompt).not.toContain("Takeover task: take over the implementation now");
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

    await expect(agents.build({ plan, streamId: "__default__", tasks: plan.tasks, verification: plan.verification, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
  });

  it("supports Claude Code CLI leader plus MiniMax worker", async () => {
    const cwd = await tempDir("project");
    const claudeCliPath = await fakeClaudeScript("answer");
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "claude-code/cli", worker: "minimax/minimax-m2.7", permissionMode: "yolo", claudeCliPath, claudeCliModel: "haiku" },
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
      await expect(agents.build({ plan: planned.plan, streamId: "__default__", tasks: planned.plan.tasks, verification: planned.plan.verification, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
    }
  });

  it("passes the user-prompt bytes verbatim through the real Claude exec path with no preamble (D47 live verification)", async () => {
    const capturePath = path.join(await tempDir("project-capture"), "captured.json");
    const shimSource = `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.144 (Claude Code)"); process.exit(0); }
const promptIdx = args.indexOf("-p");
const sysPromptIdx = args.indexOf("--system-prompt");
const rawPrompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
const rawSystemPrompt = sysPromptIdx >= 0 ? args[sysPromptIdx + 1] : "";
const mode = process.env.TANDEM_FAKE_CLAUDE_MODE || "answer";
const structured_output =
  mode === "completion"
    ? { status: "complete", summary: "done", taskResults: [{ id: "T1", status: "done" }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }
    : mode === "verdict"
    ? { verdict: "approve", scores: { correctness: 5, planAdherence: 5, codeQuality: 5 }, feedback: [], userSummary: "approved" }
    : mode === "takeover"
    ? { report: { status: "complete", summary: "done", taskResults: [{ id: "T1", status: "done" }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }, userSummary: "done" }
    : { kind: "question", answer: "81", plan: null };
const fs = require("fs");
fs.writeFileSync(process.env.TANDEM_TEST_CAPTURE, JSON.stringify({ rawPrompt, rawSystemPrompt, args }, null, 2));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", structured_output, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, permission_denials: [] }));
`;
    const shimDir = await tempDir("project-shim");
    const shimJsPath = path.join(shimDir, "claude.js");
    await (await import("node:fs/promises")).writeFile(shimJsPath, shimSource, "utf8");

    const cwd = await tempDir("project-d47");
    const fs = await import("node:fs/promises");
    await fs.rm(capturePath, { force: true });

    const { execa } = await import("execa");
    const buildClaudeExecArgvLocal = (await import("../src/agents/claude-code-cli/exec.js")).buildClaudeExecArgv;
    const { jsonSchemaFor } = await import("../src/agents/codex-cli/schema-json.js");
    const { claudePermissionFor } = await import("../src/agents/claude-code-cli/exec.js");

    async function invokeShimDirectly<T>(options: Parameters<typeof runClaudeExec>[0]): Promise<unknown> {
      const argv = buildClaudeExecArgvLocal({
        prompt: options.prompt,
        systemPrompt: options.systemPrompt,
        schema: jsonSchemaFor(options.schema),
        permissionMode: claudePermissionFor(options.permissionMode, options.readOnly),
        modelName: options.modelName,
        readOnly: options.readOnly
      });
      const result = await execa(process.execPath, [shimJsPath, ...argv], {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        reject: false,
        windowsHide: true
      });
      if (result.exitCode !== 0) throw new Error(`shim exited ${result.exitCode}: ${result.stderr}\n${result.stdout}`);
      const { parseClaudeEnvelope } = await import("../src/agents/claude-code-cli/exec.js");
      return parseClaudeEnvelope(result.stdout, { role: options.role, entry: options.entry, ledger: options.ledger, onText: options.onText });
    }

    const planOptions = {
      env: { ...process.env, TANDEM_TEST_CAPTURE: capturePath, TANDEM_FAKE_CLAUDE_MODE: "answer" },
      cwd: process.cwd(),
      projectInstructions: async () => "Project instructions:\nnone"
    };
    const prompts = await buildClaudeLeaderPlanPrompts(planOptions, { request: "What is 9 times 9? Reply with only the number.", goals: [], history: "" });
    expect(prompts.prompt).toMatch(/^Request: What is 9 times 9\? Reply with only the number\./);
    expect(prompts.prompt).not.toContain("This is a single non-interactive call");
    expect(prompts.prompt).not.toContain("Act on the request below now");
    expect(prompts.prompt).toContain("Request: What is 9 times 9? Reply with only the number.");
    const ledger = new CostLedger();
    await invokeShimDirectly({
      cwd,
      prompt: prompts.prompt,
      systemPrompt: prompts.systemPrompt,
      schema: "plan-or-answer",
      permissionMode: "yolo",
      env: planOptions.env,
      claudeCliPath: shimJsPath,
      role: "leader",
      entry: claudeEntry,
      ledger
    });
    const capturedRaw = await fs.readFile(capturePath, "utf8");
    const captured = JSON.parse(capturedRaw) as { rawPrompt: string; rawSystemPrompt: string; args: string[] };
    expect(captured.rawPrompt).toBe(prompts.prompt);
    expect(captured.rawPrompt).toMatch(/^Request: What is 9 times 9\? Reply with only the number\./);
    expect(captured.rawPrompt).toContain("Request: What is 9 times 9? Reply with only the number.");
    expect(captured.rawPrompt).not.toContain("This is a single non-interactive call");
    expect(captured.rawPrompt).not.toContain("Conversation so far:");
    expect(captured.rawPrompt).not.toContain("Standing goals:");

    await fs.rm(capturePath, { force: true });
    const reviewPrompts = await buildClaudeLeaderReviewPrompts(planOptions, { plan, report: { status: "complete", summary: "ok", taskResults: [{ id: "T1", status: "done" }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }, round: 1, diff: "" });
    await invokeShimDirectly({
      cwd,
      prompt: reviewPrompts.prompt,
      systemPrompt: reviewPrompts.systemPrompt,
      schema: "review-verdict",
      permissionMode: "yolo",
      env: { ...planOptions.env, TANDEM_FAKE_CLAUDE_MODE: "verdict" },
      claudeCliPath: shimJsPath,
      readOnly: true,
      role: "leader",
      entry: claudeEntry,
      ledger
    });
    const reviewCaptured = JSON.parse(await fs.readFile(capturePath, "utf8")) as { rawPrompt: string };
    expect(reviewCaptured.rawPrompt).toBe(reviewPrompts.prompt);
    expect(reviewCaptured.rawPrompt).toMatch(/^Review round 1\./);
    expect(reviewCaptured.rawPrompt.indexOf("Review round 1.")).toBeLessThan(reviewCaptured.rawPrompt.indexOf("BuildPlan:"));
    expect(reviewCaptured.rawPrompt).not.toContain("This is a single non-interactive call");
    expect(reviewCaptured.rawPrompt).not.toContain("Review task: review the completed work now");

    await fs.rm(capturePath, { force: true });
    const workerPrompts = await buildClaudeWorkerPrompts(planOptions, { plan, streamId: "__default__", tasks: plan.tasks, verification: plan.verification, round: 1, feedback: [] });
    await invokeShimDirectly({
      cwd,
      prompt: workerPrompts.prompt,
      systemPrompt: workerPrompts.systemPrompt,
      schema: "completion-report",
      permissionMode: "yolo",
      env: { ...planOptions.env, TANDEM_FAKE_CLAUDE_MODE: "completion" },
      claudeCliPath: shimJsPath,
      role: "worker",
      entry: claudeEntry,
      ledger
    });
    const workerCaptured = JSON.parse(await fs.readFile(capturePath, "utf8")) as { rawPrompt: string };
    expect(workerCaptured.rawPrompt).toBe(workerPrompts.prompt);
    expect(workerCaptured.rawPrompt).toMatch(/^BuildPlan:/);
    expect(workerCaptured.rawPrompt.indexOf("BuildPlan:")).toBeLessThan(workerCaptured.rawPrompt.indexOf("Round 1"));
    expect(workerCaptured.rawPrompt).not.toContain("This is a single non-interactive call");
    expect(workerCaptured.rawPrompt).not.toContain("Worker task: build now from this worker task context.");
  });
});

describe("D66-1: claude-code-cli plan prompt states the absolute cwd explicitly", () => {
  it("includes the absolute project root in the system prompt for the leader", async () => {
    const prompts = await buildClaudeLeaderPlanPrompts(
      {
        env: {},
        cwd: "C:/Users/huizh/tmp_test_data/dogfight-game",
        projectInstructions: async () => "Project instructions:\nnone"
      },
      { request: "What is 9 times 9?", goals: [], history: "" }
    );
    expect(prompts.systemPrompt).toContain("C:/Users/huizh/tmp_test_data/dogfight-game");
    expect(prompts.systemPrompt).toMatch(/Absolute project root \(cwd\)/);
  });
});

describe("D66-2: retryArtifact fast-fails on RateLimitError instead of wasting retries", () => {
  // 429-shaped error path - runClaudeExec throws RateLimitError on 429, retryArtifact must
  // fast-fail (single attempt, immediate re-throw) instead of burning 2 more attempts that are
  // guaranteed to fail identically until the reset time.
  it("detects a 429-shaped envelope and throws RateLimitError with resetsAt", async () => {
    const { RateLimitError, runClaudeExec, parseClaudeEnvelope } = await import("../src/agents/claude-code-cli/exec.js");
    // Build a fake envelope matching the live failure shape (api_error_status: 429 + prose
    // reset time). parseClaudeEnvelope does not parse 429 itself; the detection lives in
    // runClaudeExec's exitCode!==0 branch. Build a 429-shaped stdout and call the actual
    // parsing path via a mock shell.
    const fakeEnvelope = {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your limit · resets 11:50pm (America/New_York)",
      structured_output: undefined,
      usage: {},
      total_cost_usd: 0,
      permission_denials: []
    };
    const tmpDir = path.join(tmpdir(), `tandem-d66-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    // Make a fake `claude` shim that just echoes the envelope as stdout, exits 0, and prints
    // version 2.1.144 so locateClaudeCli accepts it.
    const jsPath = path.join(tmpDir, "claude.js");
    const cmdPath = path.join(tmpDir, "claude.cmd");
    await writeFile(jsPath, `process.stdout.write(${JSON.stringify(JSON.stringify(fakeEnvelope))});`, "utf8");
    await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, "utf8");
    clearClaudeCliPathCache();
    try {
      const testRole: import("../src/session/cost.js").CostRole = "leader";
      const testEntry: import("../src/providers/registry.js").ModelEntry = { id: "claude-code/cli", provider: "claude-code-cli", modelName: "haiku", contextWindow: 200000 };
      const testLedger = new (await import("../src/session/cost.js")).CostLedger();
      await expect(
        runClaudeExec({
          cwd: tmpDir,
          env: { PATH: tmpDir + (process.platform === "win32" ? ";" : ":") + process.env.PATH },
          prompt: "hi",
          systemPrompt: "you are claude",
          schema: "plan-or-answer",
          permissionMode: "yolo",
          claudeCliPath: cmdPath,
          modelName: "haiku",
          role: testRole,
          entry: testEntry,
          ledger: testLedger,
          readOnly: true
        })
      ).rejects.toBeInstanceOf(RateLimitError);
    } finally {
      clearClaudeCliPathCache();
    }
  });

  it("RateLimitError carries a resetsAt property parsed from the envelope", async () => {
    const { RateLimitError } = await import("../src/agents/claude-code-cli/exec.js");
    const err = new RateLimitError("rate-limited", "11:50pm (America/New_York)");
    expect(err.name).toBe("RateLimitError");
    expect(err.resetsAt).toBe("11:50pm (America/New_York)");
    expect(err.message).toBe("rate-limited");
    expect(err).toBeInstanceOf(Error);
  });

  it("parseClaudeEnvelope throws RateLimitError on a 429-shaped envelope even when exit-code would be 0", () => {
    // D66-2: detection is in BOTH runClaudeExec's exitCode!==0 branch AND parseClaudeEnvelope.
    // If a future version of claude-code-cli starts returning exitCode 0 on 429 (the live
    // evidence shows non-zero, but the envelope signal is independent of exit code), the
    // parse-side check still surfaces the rate-limit error to the caller.
    const testEntry = { id: "claude-code/cli", provider: "claude-code-cli", modelName: "haiku", contextWindow: 200000 } as const;
    const testLedger = new CostLedger();
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      api_error_status: 429,
      result: "You've hit your limit · resets 11:50pm (America/New_York)",
      structured_output: undefined,
      usage: {},
      total_cost_usd: 0
    });
    expect(() => parseClaudeEnvelope(stdout, { role: "leader", entry: testEntry, ledger: testLedger })).toThrow(RateLimitError);
  });
});
