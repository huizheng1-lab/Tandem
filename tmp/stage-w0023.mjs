import { execSync } from "node:child_process";
try {
  execSync(
    "git add src/remote-control/bridge.ts src/remote-control/telegram-session-stream.ts tests/remote-control-bridge-prompt.test.ts tests/remote-control-telegram-session-stream.test.ts",
    { stdio: "inherit" }
  );
  console.log("staged");
} catch (error) {
  console.error("stage-failed", error?.message || error);
  process.exit(1);
}
