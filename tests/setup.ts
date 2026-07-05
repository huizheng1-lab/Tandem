import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterAll } from "vitest";

type SnapshotEntry = { kind: "dir" } | { kind: "file"; hash: string; size: number };
type Snapshot = Record<string, SnapshotEntry>;

const realTandemDir = path.join(homedir(), ".tandem");
const testTandemHome = path.join(tmpdir(), `tandem-vitest-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
process.env.TANDEM_HOME = testTandemHome;

async function snapshotDir(root: string): Promise<Snapshot> {
  if (!existsSync(root)) return {};
  const snapshot: Snapshot = {};

  async function walk(current: string): Promise<void> {
    const relative = path.relative(root, current) || ".";
    const stat = await lstat(current);
    if (stat.isDirectory()) {
      snapshot[relative] = { kind: "dir" };
      const entries = await readdir(current);
      await Promise.all(entries.map((entry) => walk(path.join(current, entry))));
      return;
    }
    if (stat.isFile()) {
      const content = await readFile(current);
      snapshot[relative] = { kind: "file", hash: createHash("sha256").update(content).digest("hex"), size: content.byteLength };
    }
  }

  await walk(root);
  return snapshot;
}

const realTandemBefore = await snapshotDir(realTandemDir);

afterAll(async () => {
  assert.deepEqual(await snapshotDir(realTandemDir), realTandemBefore, "Tests must not read/write mutable state in the real ~/.tandem directory; use TANDEM_HOME or an injected homeDir.");
  await rm(testTandemHome, { recursive: true, force: true });
});
