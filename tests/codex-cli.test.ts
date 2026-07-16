import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveAgents } from "../src/agents/live.js";
import { buildCodexExecArgv, codexWritableRoots, handleCodexJsonLine, runCodexExec, stripNulls } from "../src/agents/codex-cli/exec.js";
import { clearCodexCliPathCache, locateCodexCli } from "../src/agents/codex-cli/locate.js";
import { buildPlanJsonSchema, completionReportJsonSchema, jsonSchemaFor, planOrAnswerJsonSchema, reviewVerdictJsonSchema, takeoverJsonSchema } from "../src/agents/codex-cli/schema-json.js";
import { buildCodexWorkerPrompt } from "../src/agents/codex-cli/worker.js";
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
const counterFile = __filename + ".count";
let count = 0;
try { count = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(counterFile, String(count));
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
console.log(JSON.stringify({ type: "thread.started", thread_id: "test" }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "node -v", aggregated_output: "", exit_code: null, status: "in_progress" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "node -v", exit_code: 0, status: "completed" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24680, cached_input_tokens: 21760, output_tokens: 51, reasoning_output_tokens: 2 } }));
let value;
if (schema.includes("completion-report")) {
  value = { status: "complete", summary: "codex worker done", taskResults: [{ id: "T1", status: "done", notes: null }], filesChanged: ["hello35.txt"], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] };
} else if (schema.includes("plan-or-answer") && (/Create hello/.test(prompt) || count > 1)) {
  value = { kind: "implementation", answer: null, plan: { title: "Hello", objective: "Create hello file", constraints: [], tasks: [{ id: "T1", description: "Create file", files: null }], acceptanceCriteria: ["file exists"], verification: ["npm test"] } };
} else if (schema.includes("plan-or-answer")) {
  value = { kind: "question", answer: "4", plan: null };
} else if (schema.includes("review-verdict")) {
  value = { verdict: "approve", scores: { correctness: 5, planAdherence: 5, codeQuality: 5 }, feedback: [], userSummary: "approved" };
} else {
  value = { report: { status: "complete", summary: "takeover", taskResults: [{ id: "T1", status: "done", notes: null }], filesChanged: [], verificationResults: [{ command: "npm test", passed: true, output: "ok" }], deviationsFromPlan: [] }, userSummary: "takeover" };
}
fs.writeFileSync(output, JSON.stringify(value));
console.log(JSON.stringify(value));
});
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

async function fakeFailingCodexScript(): Promise<string> {
  const dir = await tempDir("fake-codex-fail");
  const script = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const js = path.join(dir, "fake-codex-fail.js");
  await writeFile(
    js,
    `
console.error("Reading additional input from stdin...");
console.log(JSON.stringify({ type: "error", message: "Invalid schema for response_format codex_output_schema: Missing notes." }));
process.exit(1);
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

function assertRequiredCoversProperties(schema: unknown, pathLabel = "$"): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as { additionalProperties?: unknown; properties?: Record<string, unknown>; required?: unknown; items?: unknown; anyOf?: unknown[] };
  if (node.additionalProperties === false && node.properties) {
    expect(Array.isArray(node.required), `${pathLabel}.required`).toBe(true);
    for (const key of Object.keys(node.properties)) {
      expect(node.required, `${pathLabel}.required includes ${key}`).toContain(key);
    }
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) assertRequiredCoversProperties(child, `${pathLabel}.properties.${key}`);
  if (node.items) assertRequiredCoversProperties(node.items, `${pathLabel}.items`);
  for (const [index, child] of (node.anyOf ?? []).entries()) assertRequiredCoversProperties(child, `${pathLabel}.anyOf.${index}`);
}

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

  it("D124: skips protected MSIX payloads and continues to a spawnable PATH candidate", () => {
    clearCodexCliPathCache();
    const protectedPath = path.win32.join("C:\\Program Files", "WindowsApps", "OpenAI.Codex_1.0_x64", "app", "resources", "codex.exe");
    const spawnablePath = path.win32.join("C:\\Tools", "Codex", "codex.exe");
    expect(
      locateCodexCli({
        platform: "win32",
        env: { PATH: `${path.win32.dirname(protectedPath)};${path.win32.dirname(spawnablePath)}` },
        pathSeparator: ";",
        exists: (filePath) => [protectedPath, spawnablePath].includes(filePath)
      })
    ).toBe(spawnablePath);
  });

  it("D124: falls back past a protected PATH payload and version folders without codex.exe", () => {
    clearCodexCliPathCache();
    const local = "C:/Users/me/AppData/Local";
    const binRoot = path.join(local, "OpenAI", "Codex", "bin");
    const protectedDir = "C:/Program Files/WindowsApps/OpenAI.Codex_1.0_x64/app/resources";
    const protectedPath = path.join(protectedDir, "codex.exe");
    const spawnablePath = path.join(binRoot, "3135b80b111fd431", "codex.exe");
    expect(
      locateCodexCli({
        platform: "win32",
        env: { PATH: protectedDir, LOCALAPPDATA: local },
        pathSeparator: ";",
        exists: (filePath) => filePath === protectedPath || filePath === binRoot || filePath === spawnablePath,
        readdir: () => ["ada252862d154cdd", "3135b80b111fd431"],
        stat: () => ({ mtimeMs: 1 })
      })
    ).toBe(spawnablePath);
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

  it("D105: cache invalidates when the cached path no longer exists (background updater removed the versioned folder)", () => {
    clearCodexCliPathCache();
    // First call: cache a "stale" codex.exe path under the existing test path.
    const local = "C:/Users/me/AppData/Local";
    const stalePath = path.join(local, "OpenAI", "Codex", "bin", "a7c12ebff69fb123", "codex.exe");
    const freshFolder = path.join(local, "OpenAI", "Codex", "bin", "ada252862d154cdd");
    const freshPath = path.join(freshFolder, "codex.exe");
    let deleted = false;
    const existsFake = (filePath: string) => {
      if (filePath === path.join(local, "OpenAI", "Codex", "bin")) return true;
      if (filePath === stalePath) return !deleted;
      if (filePath === freshPath) return deleted;
      return false;
    };
    const readdirFake = () => (deleted ? ["ada252862d154cdd"] : ["a7c12ebff69fb123"]);
    const statFake = (filePath: string) => ({ mtimeMs: filePath === freshPath ? 2 : 1 });
    // Prime the cache with the stale path.
    const first = locateCodexCli({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      exists: existsFake,
      readdir: readdirFake,
      stat: statFake
    });
    expect(first).toBe(stalePath);
    // Simulate the updater: stale file is gone, fresh file exists. The cache key is
    // unchanged (PATH/LOCALAPPDATA didn't move), so without the existence check the second
    // call would return the stale path. With D105, it invalidates and re-resolves.
    deleted = true;
    const second = locateCodexCli({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      exists: existsFake,
      readdir: readdirFake,
      stat: statFake
    });
    expect(second).toBe(freshPath);
  });

  it("D105: cache short-circuits without a rescan when the cached path still exists (perf intent preserved)", () => {
    clearCodexCliPathCache();
    // First call resolves and caches a path. Track which directories the readdir / exists
    // fakes are called for so we can confirm the second call does NOT re-scan.
    const local = "C:/Users/me/AppData/Local";
    const cachedPath = path.join(local, "OpenAI", "Codex", "bin", "kept", "codex.exe");
    let readdirCalls = 0;
    let statCalls = 0;
    const existsFake = (filePath: string) => filePath === cachedPath || filePath === path.join(local, "OpenAI", "Codex", "bin");
    const readdirFake = () => {
      readdirCalls += 1;
      return ["kept"];
    };
    const statFake = (filePath: string) => {
      statCalls += 1;
      return { mtimeMs: 1 };
    };
    // Prime the cache.
    const first = locateCodexCli({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      exists: existsFake,
      readdir: readdirFake,
      stat: statFake
    });
    expect(first).toBe(cachedPath);
    const readdirAfterFirst = readdirCalls;
    const statAfterFirst = statCalls;
    // Second call: cached path still exists, key unchanged, the existence check passes, so
    // the function should return immediately without re-running the Windows fallback scan.
    const second = locateCodexCli({
      platform: "win32",
      env: { LOCALAPPDATA: local },
      exists: existsFake,
      readdir: readdirFake,
      stat: statFake
    });
    expect(second).toBe(cachedPath);
    // The whole point of the cache: the existence check is the only filesystem call on the
    // second invocation, not a full directory rescan. readdir/stat counts must not grow.
    expect(readdirCalls).toBe(readdirAfterFirst);
    expect(statCalls).toBe(statAfterFirst);
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
        modelName: "gpt-5-mini",
        modelReasoningEffort: "medium"
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
      "gpt-5-mini",
      "-c",
      "model_reasoning_effort=medium",
      "-"
    ]);
  });

  it("D84: keeps large prompts off argv and uses stdin marker mode", () => {
    const prompt = "review ".repeat(2000);
    const argv = buildCodexExecArgv({
      cwd: "C:/project",
      sandbox: "read-only",
      schemaPath: "schema.json",
      outputPath: "out.json",
      prompt
    });

    expect(prompt.length).toBeGreaterThan(10000);
    expect(argv).not.toContain(prompt);
    expect(argv.at(-1)).toBe("-");
  });

  it("D129: grants only explicitly configured roots to workspace-write Codex runs", () => {
    const separator = path.delimiter;
    const roots = codexWritableRoots({
      TANDEM_CODEX_WRITABLE_ROOTS: [`C:${path.sep}control`, `C:${path.sep}relay-state`, `C:${path.sep}relay-refs`, `C:${path.sep}control`].join(separator)
    });
    const argv = buildCodexExecArgv({
      cwd: "C:/project",
      sandbox: "workspace-write",
      schemaPath: "schema.json",
      outputPath: "out.json",
      prompt: "do work",
      writableRoots: roots
    });

    expect(argv.filter((arg) => arg === "--add-dir")).toHaveLength(3);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--add-dir",
        path.resolve(`C:${path.sep}control`),
        "--add-dir",
        path.resolve(`C:${path.sep}relay-state`),
        "--add-dir",
        path.resolve(`C:${path.sep}relay-refs`)
      ])
    );
    expect(
      buildCodexExecArgv({
        cwd: "C:/project",
        sandbox: "read-only",
        schemaPath: "schema.json",
        outputPath: "out.json",
        prompt: "review",
        writableRoots: roots
      })
    ).not.toContain("--add-dir");
  });

  it("parses JSONL events into tool events and usage without streaming schema JSON text", () => {
    const ledger = new CostLedger();
    const text: string[] = [];
    const tools: unknown[] = [];
    const active = new Map<string, number>();
    const options = { role: "worker" as const, entry: codexEntry, ledger, onText: (value: string) => text.push(value), onToolEvent: (event: unknown) => tools.push(event) };
    handleCodexJsonLine('{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"npm test","status":"in_progress"}}', options, active);
    handleCodexJsonLine('{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}', options, active);
    handleCodexJsonLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}', options, active);
    handleCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"reasoning_output_tokens":3}}', options, active);

    expect(text).toEqual([]);
    expect(tools).toHaveLength(2);
    expect(ledger.totals().worker).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("captures Codex JSON error events for diagnosable failures", () => {
    const ledger = new CostLedger();
    const diagnostics = { errors: [] as string[] };
    handleCodexJsonLine(
      '{"type":"error","message":"Invalid schema for response_format codex_output_schema: Missing notes."}',
      { role: "worker", entry: codexEntry, ledger },
      new Map<string, number>(),
      diagnostics
    );

    expect(diagnostics.errors.join("\n")).toContain("Missing notes");
  });

  it("strips nulls from Codex output before zod validation", () => {
    expect(stripNulls({ taskResults: [{ id: "T1", notes: null }], plan: null })).toEqual({ taskResults: [{ id: "T1" }] });
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
    expect(JSON.stringify(output)).not.toContain("notes");
    expect(ledger.totals().worker.inputTokens).toBe(24680);
  });

  it("includes structured Codex stdout errors when exec fails", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeFailingCodexScript();
    await expect(
      runCodexExec({
        cwd,
        prompt: "build",
        schema: "completion-report",
        permissionMode: "yolo",
        codexCliPath,
        role: "worker",
        entry: codexEntry,
        ledger: new CostLedger()
      })
    ).rejects.toThrow(/Missing notes/);
  });

  it("exposes hand-rolled schemas for every Codex artifact kind", () => {
    expect(jsonSchemaFor("completion-report")).toMatchObject({ type: "object" });
    expect(JSON.stringify(jsonSchemaFor("plan-or-answer"))).toContain("implementation");
    expect(JSON.stringify(jsonSchemaFor("takeover"))).toContain("userSummary");
  });

  it("requires every property key in OpenAI structured output schemas", () => {
    for (const schema of [buildPlanJsonSchema, completionReportJsonSchema, reviewVerdictJsonSchema, takeoverJsonSchema, planOrAnswerJsonSchema]) {
      assertRequiredCoversProperties(schema);
    }
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

  it("gives Codex CLI workers the same verification and project instructions as SDK workers", async () => {
    const prompt = await buildCodexWorkerPrompt(
      {
        env: { ComSpec: "powershell.exe" },
        projectInstructions: async () => "Project instructions:\n- Use the local style."
      },
      { plan, streamId: "__default__", tasks: plan.tasks, verification: plan.verification, round: 1, feedback: [] }
    );

    expect(prompt).toContain("Project instructions:\n- Use the local style.");
    expect(prompt).toContain("Host: Windows");
    expect(prompt).toContain("If read_file says you CANNOT view a file's visual content");
    expect(prompt).toContain(
      "In verificationResults[].command, repeat the BuildPlan verification command string verbatim. If you adapt a command for the host platform, still use the plan's original command as command and describe the adapted command plus real output in output."
    );
    expect(prompt).toContain("BuildPlan:");
  });

  it("supports API leader plus Codex CLI worker", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "openai/gpt-5-mini", worker: "codex/cli", permissionMode: "yolo", codexCliPath },
      cwd,
      env: { OPENAI_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.build({ plan, streamId: "__default__", tasks: plan.tasks, verification: plan.verification, round: 1, feedback: [] })).resolves.toMatchObject({ status: "complete" });
  });

  it("supports Codex CLI leader plus API worker", async () => {
    const cwd = await tempDir("project");
    const codexCliPath = await fakeCodexScript();
    const agents = await createLiveAgents({
      config: { ...defaultConfig, leader: "codex/cli", worker: "openai/gpt-5-mini", permissionMode: "yolo", codexCliPath, codexCliModel: "gpt-5-mini", codexCliReasoningEffort: "medium" },
      cwd,
      env: { OPENAI_API_KEY: "test-key" },
      ledger: new CostLedger()
    });

    await expect(agents.plan({ request: "What is 2+2?", goals: [] })).resolves.toEqual({ kind: "answer", answer: "4" });
    await expect(agents.plan({ request: "Create hello35.txt with hi", goals: [] })).resolves.toMatchObject({ kind: "plan" });
  });
});
