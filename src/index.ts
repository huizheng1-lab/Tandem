#!/usr/bin/env node
import process from "node:process";
import { render } from "ink";
import React from "react";
import { loadConfig, loadEnv } from "./config/load.js";
import { validateModelEnv } from "./providers/registry.js";
import { resolveModel } from "./providers/registry.js";
import { dispatchCommand } from "./commands/index.js";
import { CostLedger } from "./session/cost.js";
import { App } from "./tui/App.js";

const version = "0.1.0";

function parseFlags(argv: string[]) {
  return {
    version: argv.includes("--version") || argv.includes("-v"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.version) {
    console.log(version);
    return;
  }
  const env = loadEnv(process.cwd());
  const config = loadConfig({ cwd: process.cwd(), env });

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const input = process.argv.slice(2).join(" ");
    if (input.startsWith("/")) {
      const output = await dispatchCommand(input, { config, env, cwd: process.cwd(), ledger: new CostLedger() });
      console.log(output ?? "");
      return;
    }
    for (const id of [config.leader, config.worker]) {
      validateModelEnv(resolveModel(id, config.customModels), env, { codexCliPath: config.codexCliPath, claudeCliPath: config.claudeCliPath });
    }
    console.log("Tandem non-TTY mode. Use a TTY for chat, or pass /help, /models, /status, or other slash commands.");
    return;
  }

  const validationErrors: string[] = [];
  for (const id of [config.leader, config.worker]) {
    try {
      validateModelEnv(resolveModel(id, config.customModels), env, { codexCliPath: config.codexCliPath, claudeCliPath: config.claudeCliPath });
    } catch (error) {
      validationErrors.push(String(error));
    }
  }

  render(React.createElement(App, { config, env, cwd: process.cwd(), initialError: validationErrors.join("\n") || undefined }));
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
