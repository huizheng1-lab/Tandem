import { homedir } from "node:os";
import path from "node:path";

export function tandemStateDir(homeDir?: string): string {
  if (homeDir) return path.join(homeDir, ".tandem");
  const override = process.env.TANDEM_HOME?.trim();
  return path.resolve(override || path.join(homedir(), ".tandem"));
}
