import { CostLedger } from "../src/session/cost.js";
import { runAgentText } from "../src/agents/runner.js";
import { makeModel } from "../src/providers/client.js";
import { defaultConfig } from "../src/config/schema.js";
import { leaderSystemProviderOptions } from "../src/agents/live.js";
import { leaderPlannerPrompt } from "../src/agents/leader.js";
import { hostPlatformPrompt } from "../src/agents/platform.js";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

async function liveRunnerRoutingSmoke(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY in env.");
    return;
  }

  const config = { ...defaultConfig, leader: "google/gemini-2.5-pro", worker: "google/gemini-2.5-flash" };
  const env: NodeJS.ProcessEnv = { ...process.env };
  const { model, entry } = await makeModel("google/gemini-2.5-pro", config, env);
  const hostPrompt = hostPlatformPrompt(process.platform, env);
  const projectInstructions = "Project instructions:\n- Be brief, accurate, and mention the magic word BANANA in every reply.\n" +
    `Padding: ${"Lorem ipsum dolor sit amet. ".repeat(800)}`;
  const memoryInstruction = "Honor Project instructions. Use remember only for durable project facts.";
  const trailer = "\nAnswer directly. Use read-only tools if helpful but submit any text answer when finished.";

  const stablePrefix =
    `${leaderPlannerPrompt}\n` +
    `${hostPrompt}\n` +
    `${projectInstructions}\n` +
    `${memoryInstruction}`;

  // For Gemini, systemProviderOptions is undefined (implicit caching).
  // To verify routing, we test that runAgentText still works identically with/without providerOptions.
  const systemProviderOptions: ProviderOptions | undefined = leaderSystemProviderOptions(entry);
  console.log(`Leader entry provider: ${entry.provider}. systemProviderOptions:`, systemProviderOptions);

  const ledger = new CostLedger();
  const sysOpts = systemProviderOptions;

  const prompts = [
    "\nQuestion 1: What is 2+2? Reply with the number only.",
    "\nQuestion 2: What is 3+3? Reply with the number only.",
    "\nQuestion 3: What is 5+5? Reply with the number only."
  ];

  console.log(`Stable prefix: ${stablePrefix.length} chars (~${Math.ceil(stablePrefix.length / 4)} tokens).`);
  console.log("\nCalling runAgentText 3 times with shared prefix...\n");

  for (let i = 0; i < prompts.length; i++) {
    const system = stablePrefix + prompts[i] + trailer;
    const result = await runAgentText({
      model,
      modelEntry: entry,
      costRole: "leader",
      ledger,
      system,
      systemProviderOptions: sysOpts,
      messages: [{ role: "user", content: "Proceed with the task." }],
      maxSteps: 5,
      onUsage: (usage) => {
        console.log(`[Call ${i + 1}] onUsage:`, JSON.stringify(usage, null, 2));
      }
    });
    console.log(`[Call ${i + 1}] text:`, result.text.slice(0, 200));
  }

  console.log("\n=== Ledger totals ===");
  console.log(JSON.stringify(ledger.totals(), null, 2));
}

liveRunnerRoutingSmoke()
  .catch((err) => {
    console.error("Live runner smoke failed:", err);
    process.exitCode = 1;
  });
