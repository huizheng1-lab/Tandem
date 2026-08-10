import { homedir } from "node:os";
import path from "node:path";

export function tandemStateDir(homeDir?: string): string {
  const resolved = homeDir ? path.join(homeDir, ".tandem") : path.resolve(process.env.TANDEM_HOME?.trim() || path.join(homedir(), ".tandem"));
  if (process.env.TANDEM_TEST_REAL_HOME_GUARD === "1") {
    const realHome = path.resolve(path.join(homedir(), ".tandem"));
    if (path.resolve(resolved) === realHome) {
      throw new Error(`Test attempted to resolve the real Tandem home at ${realHome}; use TANDEM_HOME or an injected homeDir.`);
    }
  }
  return resolved;
}
