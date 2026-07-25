// Generates the before/after evidence for the D58 done file.
import { mergeCompletionReports } from "../src/orchestrator/artifacts.js";

const aReport = {
  status: "complete",
  summary: "stream A done",
  taskResults: [{ id: "A1", status: "done" }],
  filesChanged: ["a.txt"],
  verificationResults: [{ command: "npm test", passed: true, output: "ok" }],
  deviationsFromPlan: []
};
const bReport = {
  status: "complete",
  summary: "stream B done",
  taskResults: [{ id: "B1", status: "done" }],
  filesChanged: ["b.txt"],
  verificationResults: [{ command: "npm test", passed: true, output: "ok" }],
  deviationsFromPlan: []
};

console.log("AFTER (D58-1 fix: mergeCompletionReports(roundStreams) - both streams present):");
console.log(JSON.stringify(mergeCompletionReports([
  { streamId: "A", report: aReport },
  { streamId: "B", report: bReport }
]), null, 2));

console.log("\nBEFORE (buggy: mergeCompletionReports(newReports only) - stream A's work is gone):");
console.log(JSON.stringify(mergeCompletionReports([{ streamId: "B", report: bReport }]), null, 2));
