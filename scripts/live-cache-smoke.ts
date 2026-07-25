import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

async function liveSmoke(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY in env.");
    return;
  }

  const googleProvider = createGoogleGenerativeAI({ apiKey });
  // Pad system prompt so the cached prefix exceeds Gemini 2.5 Pro's implicit cache min-token threshold (2048).
  const stable = `You are a concise assistant. `.repeat(1500);
  const variableA = `\nQuestion A: What is 9 times 9? Reply with just the number.`;
  const variableB = `\nQuestion B: What is 6 times 7? Reply with just the number.`;
  const variableC = `\nQuestion C: What is 8 times 8? Reply with just the number.`;

  console.log(`Stable prefix: ${stable.length} chars (~${Math.ceil(stable.length / 4)} tokens).`);

  async function oneCall(label: string, trailing: string) {
    const { text, usage, providerMetadata } = await generateText({
      model: googleProvider("gemini-2.5-pro"),
      system: stable,
      prompt: trailing
    });
    return { label, text, usage, providerMetadata };
  }

  const results = [];
  results.push(await oneCall("Warmup", variableA));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  results.push(await oneCall("Call 1", variableB));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  results.push(await oneCall("Call 2", variableC));

  for (const r of results) {
    console.log(`\n--- ${r.label} ---`);
    console.log("text:", r.text);
    console.log("usage:", JSON.stringify(r.usage, null, 2));
    console.log("usage.cachedInputTokens:", r.usage?.cachedInputTokens);
    const googleMeta = (r.providerMetadata as { google?: Record<string, unknown> } | undefined)?.google ?? {};
    const usageMeta = (googleMeta.usageMetadata as Record<string, unknown> | undefined) ?? {};
    console.log("usageMetadata keys:", Object.keys(usageMeta));
    console.log("cachedContentTokenCount:", usageMeta.cachedContentTokenCount);
    console.log("promptTokenCount:", usageMeta.promptTokenCount);
    console.log("totalTokenCount:", usageMeta.totalTokenCount);
  }
}

liveSmoke().catch((err) => {
  console.error("Live smoke failed:", err);
  process.exitCode = 1;
});
