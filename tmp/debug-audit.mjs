import { readFileSync } from "node:fs";
import path from "node:path";

const logPath = "C:/Users/huizh/Apps/Tandem Reciprocal/control/orchestrator-operations.ndjson";
const log = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const startIdx = log.findIndex((entry) => entry.action === "cycle.claimed");
console.log("Start index:", startIdx);
const window = log.slice(startIdx);
console.log("Window length:", window.length);
const cycles = window.filter((entry) => entry.action === "cycle.completed");
console.log("Cycle completions:", cycles.length);
for (const entry of cycles) {
  const idx = window.indexOf(entry);
  console.log("cycle.completed idx:", idx, "item:", entry.completedItem || entry.item);
  const slice = window.slice(Math.max(0, idx - 8), idx + 1);
  const started = slice.find((e) => e.action === "a-implements.started");
  if (!started) {
    console.log("  no a-implements.started found in slice");
    continue;
  }
  const cmd = started.command || "";
  const r1 = /reciprocal-direction\.ps1[\s\S]*?-Action\s+Show\b/.test(cmd);
  const r2 = /-Action\s+Show[\s\S]*?-ControlPath\b/.test(cmd);
  console.log("  command (first 200):", cmd.slice(0, 200));
  console.log("  regex1:", r1, "regex2:", r2);
}
