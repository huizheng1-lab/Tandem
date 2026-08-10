import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterAll } from "vitest";

const testTandemHome = path.join(tmpdir(), `tandem-vitest-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
process.env.TANDEM_HOME = testTandemHome;
process.env.TANDEM_TEST_REAL_HOME_GUARD = "1";

afterAll(async () => {
  assert.equal(process.env.TANDEM_TEST_REAL_HOME_GUARD, "1", "Tests must keep the real ~/.tandem resolution guard enabled.");
  await rm(testTandemHome, { recursive: true, force: true });
});
