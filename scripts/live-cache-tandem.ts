import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { generateText } from "ai";
import { defaultConfig } from "../src/config/schema.js";
import { makeModel } from "../src/providers/client.js";

type GoogleProviderMetadata = {
  google?: {
    usageMetadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function stablePrefix(): string {
  const base = [
    "You are Tandem's leader. Keep answers short, deterministic, and factual.",
    "This is a D48 Gemini implicit-cache audit. The repeated prefix must remain byte-identical.",
    "The following padding is intentionally stable across all calls."
  ].join("\n");
  return `${base}\n${"Stable cached-prefix paragraph. ".repeat(4200)}`;
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in env.");
  }

  const { model, entry } = await makeModel("google/gemini-2.5-pro", defaultConfig, env);
  const system = stablePrefix();
  const prompts = [
    "Call 1: reply with only the token ALPHA.",
    "Call 2: reply with only the token BRAVO.",
    "Call 3: reply with only the token CHARLIE."
  ];

  console.log(`Model entry: ${JSON.stringify(entry)}`);
  console.log(`Stable prefix chars: ${system.length} (~${Math.ceil(system.length / 4)} rough tokens)`);

  for (let index = 0; index < prompts.length; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 2500));
    const result = await generateText({
      model,
      system,
      prompt: prompts[index],
      maxOutputTokens: 16
    });
    const providerMetadata = result.providerMetadata as GoogleProviderMetadata | undefined;
    const googleMetadata = providerMetadata?.google ?? {};
    const usageMetadata = googleMetadata.usageMetadata ?? {};

    console.log(`\n=== CALL ${index + 1} ===`);
    console.log("text:", result.text);
    console.log("usage:", JSON.stringify(result.usage, null, 2));
    console.log("providerMetadata:", JSON.stringify(providerMetadata, null, 2));
    console.log("usageMetadata:", JSON.stringify(usageMetadata, null, 2));
    console.log("usage.cachedInputTokens:", result.usage?.cachedInputTokens);
    console.log("usageMetadata.cachedContentTokenCount:", usageMetadata.cachedContentTokenCount);
  }
}

await main();
