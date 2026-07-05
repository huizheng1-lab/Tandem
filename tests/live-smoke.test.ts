import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadEnv } from "../src/config/load.js";
import { createLiveAgents } from "../src/agents/live.js";
import { runOrchestration } from "../src/orchestrator/machine.js";
import { workingTreeDiff } from "../src/orchestrator/diff.js";
import { CostLedger } from "../src/session/cost.js";

// Live end-to-end smoke test (BUILD_PLAN.md M3 acceptance). Costs real API tokens.
// Run with: RUN_LIVE=1 vitest run tests/live-smoke.test.ts
describe.runIf(process.env.RUN_LIVE === "1")("live leader/worker pipeline", () => {
  it("runs plan -> build -> review to DONE with real models", async () => {
    const projectRoot = process.cwd();
    const env = loadEnv(projectRoot);
    const config = { ...loadConfig({ cwd: projectRoot, env }), permissionMode: "yolo" as const, maxReviewRounds: 2 };
    const demoDir = path.join(projectRoot, "demo-todo");
    await rm(demoDir, { recursive: true, force: true });
    await mkdir(demoDir, { recursive: true });

    const ledger = new CostLedger();
    const agents = await createLiveAgents({
      config,
      cwd: demoDir,
      env,
      ledger,
      onLeaderText: (text) => process.stdout.write(text),
      onWorkerText: (text) => process.stdout.write(text)
    });

    const result = await runOrchestration({
      request:
        "Create todo.mjs, a Node.js CLI with commands: add <text>, list, done <id>. Store items in todo.json next to the script. Also create test.mjs that exercises add/list/done using child_process and exits non-zero on failure. Keep it dependency-free (no npm install).",
      config,
      agents,
      diffProvider: () => workingTreeDiff(demoDir),
      emit: (event) => console.log(`\n[machine] ${JSON.stringify(event).slice(0, 400)}`)
    });

    console.log("\n[result]", JSON.stringify({ phase: result.phase, takeover: result.takeover, summary: result.summary }, null, 2));
    console.log("[cost]", JSON.stringify(ledger.totals()));
    expect(result.phase).toBe("DONE");
    expect(result.plan, "leader should have produced a BuildPlan, not a plain answer").toBeDefined();
    expect(result.reports.length, "at least one worker/takeover report expected").toBeGreaterThan(0);
    const totals = ledger.totals();
    expect(totals.leader.outputTokens + totals.worker.outputTokens, "cost ledger should record real usage").toBeGreaterThan(0);

    const check = await import("node:child_process").then(({ execFileSync }) =>
      execFileSync("node", ["test.mjs"], { cwd: demoDir, encoding: "utf8" })
    );
    console.log("[demo test.mjs]", check.trim());
  }, 900_000);
});
