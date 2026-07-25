const { execa } = require("execa");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");

function execaSync(file, args, opts) {
  return cp.spawnSync(file, args, { encoding: "utf8", ...(opts || {}) });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d200-success2-"));
  const relay = path.join(root, "relay");
  fs.mkdirSync(path.join(relay, "control"), { recursive: true });
  fs.mkdirSync(path.join(relay, "state"), { recursive: true });
  fs.writeFileSync(path.join(relay, "control", "WISHLIST.md"), [
    "# Wishlist",
    "",
    "<!-- wishlist-items -->",
    "- [ ] W9001 | P0 | Concrete acceptance | QUEUED added=now acceptance=evidence/D200-acceptance.txt",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(relay, "state", "orchestrator-state.json"), JSON.stringify({
    phase: "idle",
    currentItem: null,
    consecutiveFailures: 0,
    step: null,
    stableCommit: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    lastSummary: "fixture",
    failures: [],
  }, null, 2));
  execaSync("git", ["init", "--initial-branch=master", root]);
  execaSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execaSync("git", ["-C", root, "config", "user.name", "t"]);
  execaSync("git", ["-C", root, "commit", "--allow-empty", "-m", "base"]);

  const log = path.join(root, "commands.ndjson");
  const stub = path.join(root, "implement.cjs");
  const acceptance = path.join(root, "evidence", "D200-acceptance.txt");
  fs.writeFileSync(stub, [
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const root = ${JSON.stringify(root)};`,
    `const log = ${JSON.stringify(log)};`,
    `const acceptance = ${JSON.stringify(acceptance)};`,
    "const path = require('path');",
    "fs.appendFileSync(log, JSON.stringify({label:'implement'}) + '\\n');",
    "fs.mkdirSync(path.dirname(acceptance), { recursive: true });",
    "fs.writeFileSync(acceptance, 'D200 acceptance satisfied\\n');",
    "cp.execFileSync('git', ['-C', root, 'add', '-A'], {stdio:'ignore'});",
    "cp.execFileSync('git', ['-C', root, 'commit', '-m', 'D200-N: implements acceptance', '--allow-empty'], {stdio:'ignore'});",
    "process.exit(0);",
  ].join("\n"));

  const stubFor = (label) => {
    const s = path.join(root, `${label}.stub.cjs`);
    fs.writeFileSync(s, [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:${JSON.stringify(label)}}) + "\\n");`,
      "process.exit(0);",
    ].join("\n"));
    return `node "${s}"`;
  };
  const commands = {
    implement: `node "${stub}"`,
    test: stubFor("test"),
    packageB: stubFor("packageB"),
    startB: stubFor("startB"),
    verifyRuntime: stubFor("verifyRuntime"),
    rebuildA: stubFor("rebuildA"),
    verifyA: stubFor("verifyA"),
    stopB: stubFor("stopB"),
  };

  const result = cp.spawnSync("node", [path.resolve("scripts/reciprocal-orchestrator.mjs"), "--repo", root, "--relay-root", relay], {
    env: { ...process.env, TANDEM_ORCHESTRATOR_COMMANDS_JSON: JSON.stringify(commands) },
    encoding: "utf8",
  });
  console.log("ExitCode:", result.status);
  console.log("STDOUT:", result.stdout);
  console.log("STDERR:", result.stderr);
  console.log("Labels:", fs.readFileSync(log, "utf8"));
}

main().catch((e) => { console.error(e); process.exit(2); });
