const { execa } = require("execa");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d200-retry-direct-"));
  const relay = path.join(root, "relay");
  fs.mkdirSync(path.join(relay, "control"), { recursive: true });
  fs.writeFileSync(
    path.join(relay, "control", "WISHLIST.md"),
    [
      "# Wishlist",
      "",
      "<!-- wishlist-items -->",
      "- [ ] W1000 | P1 | Lower priority | QUEUED added=now",
      "- [ ] W0001 | P0 | Build the thing | QUEUED added=now",
      "",
    ].join("\n"),
    "utf8",
  );
  execaSync("git", ["init", "--initial-branch=master", root]);
  execaSync("git", ["-C", root, "config", "user.email", "test@tandem"]);
  execaSync("git", ["-C", root, "config", "user.name", "test"]);
  execaSync("git", ["-C", root, "commit", "--allow-empty", "-m", "fixture base"]);

  const log = path.join(root, "commands.ndjson");
  const sentinel = path.join(root, "attempt.txt");
  const stub = path.join(root, "implement.stub.cjs");
  fs.writeFileSync(stub, [
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const root = ${JSON.stringify(root)};`,
    `const log = ${JSON.stringify(log)};`,
    "fs.appendFileSync(log, JSON.stringify({label:'implement'}) + '\\n');",
    "cp.execFileSync('git', ['-C', root, 'add', '-A'], {stdio:'ignore'});",
    `cp.execFileSync('git', ['-C', root, 'commit', '-m', 'D200-N: stub', '--allow-empty'], {stdio:'ignore'});`,
    "process.exit(0);",
  ].join("\n"));
  const testStub = path.join(root, "test.stub.cjs");
  fs.writeFileSync(testStub, [
    "const fs = require('fs');",
    `const sentinel = ${JSON.stringify(sentinel)};`,
    `const log = ${JSON.stringify(log)};`,
    "const n = fs.existsSync(sentinel) ? 2 : 1;",
    "fs.writeFileSync(sentinel, String(n));",
    "fs.appendFileSync(log, JSON.stringify({label:'test', attempt:n}) + '\\n');",
    "process.exit(n === 1 ? 9 : 0);",
  ].join("\n"));

  const commands = {
    implement: `node "${stub}"`,
    test: `node "${testStub}"`,
    packageB: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'packageB'})+\\n); process.exit(0)"`,
    startB: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'startB'})+\\n); process.exit(0)"`,
    verifyRuntime: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'verifyRuntime'})+\\n); process.exit(0)"`,
    rebuildA: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'rebuildA'})+\\n); process.exit(0)"`,
    verifyA: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'verifyA'})+\\n); process.exit(0)"`,
    stopB: `node -e "require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({label:'stopB'})+\\n); process.exit(0)"`,
  };

  const result = require("node:child_process").spawnSync("node", [path.resolve("scripts/reciprocal-orchestrator.mjs"), "--repo", root, "--relay-root", relay], {
    env: { ...process.env, TANDEM_ORCHESTRATOR_COMMANDS_JSON: JSON.stringify(commands), TANDEM_ORCHESTRATOR_SOURCE_SHA: "fixture-sha" },
    reject: false,
  });
  console.log("ExitCode:", result.status);
  console.log("STDOUT:", String(result.stdout || ""));
  console.log("STDERR:", String(result.stderr || ""));
  console.log("Labels:", fs.readFileSync(log, "utf8"));
  console.log("Git log:");
  execaSync("git", ["-C", root, "log", "--oneline", "-5"]);
}

function execaSync(file, args) {
  const cp = require("node:child_process");
  return cp.spawnSync(file, args, { encoding: "utf8", stdio: "inherit" });
}

main().catch((e) => { console.error(e); process.exit(2); });
