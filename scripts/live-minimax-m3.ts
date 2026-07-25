import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { createLiveAgents } from "../src/agents/live.js";
import { defaultConfig } from "../src/config/schema.js";
import { CostLedger } from "../src/session/cost.js";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";

async function buildCleanProject(): Promise<string> {
  const projectDir = pathModule.join(tmpdir(), `tandem-minimax-m3-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    pathModule.join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "tandem-minimax-m3-smoke",
        version: "0.0.0",
        private: true,
        scripts: { test: "node -e \"console.log('test-ok')\"" }
      },
      null,
      2
    )
  );
  await writeFile(
    pathModule.join(projectDir, "hello.js"),
    "// intentionally empty\n"
  );
  return projectDir;
}

const plan = {
  title: "Add a README",
  objective: "Create a README.md file with project description",
  constraints: [],
  tasks: [{ id: "T1", description: "Write README.md", files: ["README.md"] }],
  acceptanceCriteria: ["README.md exists and contains 'Tandem MiniMax M3 smoke'"],
  verification: ["node -e \"const fs=require('fs');if(!fs.existsSync('README.md'))process.exit(1);if(!fs.readFileSync('README.md','utf8').includes('Tandem MiniMax M3 smoke'))process.exit(1);console.log('ok')\""]
};

async function runWorker(workerId: string, label: string): Promise<void> {
  const projectDir = await buildCleanProject();
  const cwd = projectDir;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const ledger = new CostLedger();

  const config = {
    ...defaultConfig,
    leader: "google/gemini-2.5-flash",
    worker: workerId,
    permissionMode: "yolo" as const
  };

  const agents = await createLiveAgents({
    config,
    cwd,
    env,
    ledger,
    projectInstructions: async () => "Project instructions:\n- Keep edits minimal."
  });

  console.log(`\n=== ${label}: worker=${workerId} ===`);
  const report = await agents.build({ plan, round: 1, feedback: [] });
  console.log(`status=${report.status} summary=${report.summary.slice(0, 200)}`);
  console.log(`taskResults=${JSON.stringify(report.taskResults)}`);
  console.log(`filesChanged=${JSON.stringify(report.filesChanged)}`);
  console.log(`verificationResults=${JSON.stringify(report.verificationResults)}`);
  console.log(`cost=${JSON.stringify(ledger.totals().worker)}`);
}

await runWorker("minimax/minimax-m3", "M3 build");
await runWorker("minimax/minimax-m2.7", "M2.7 regression");
