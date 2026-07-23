import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

type RuntimeIntegrity = {
  packageIdentity: (sourceSha: string, manifest: unknown[], capabilities?: Record<string, number>) => string;
  packageManifest: (root: string) => Promise<unknown[]>;
  requiredReciprocalCapabilities: Record<string, number>;
  verifyPackage: (root: string, options?: { sourceSha?: string; packageIdentity?: string }) => Promise<Record<string, unknown>>;
};

// @ts-ignore The runtime integrity helper is an ESM script without TypeScript declarations.
const integrity = await import("../scripts/runtime-package-integrity.mjs") as RuntimeIntegrity;
const { packageIdentity, packageManifest, requiredReciprocalCapabilities, verifyPackage } = integrity;

const windowsIt = process.platform === "win32" ? it : it.skip;

async function writeBuildInfo(runtimeDir: string, sourceSha: string) {
  const manifest = await packageManifest(runtimeDir);
  const identity = packageIdentity(sourceSha, manifest, requiredReciprocalCapabilities);
  const buildInfo = {
    sourceSha,
    sourceShortSha: sourceSha.slice(0, 7),
    packageIdentity: identity,
    packageManifest: manifest,
    immutablePackagePath: runtimeDir,
    reciprocalCapabilities: requiredReciprocalCapabilities,
  };
  await writeFile(path.join(runtimeDir, "BUILD_INFO.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
  return { manifest, identity, buildInfo };
}

async function makeRuntime(prefix = "runtime-integrity-") {
  const root = path.join(tmpdir(), `${prefix}${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "Tandem.exe"), "runtime-binary\n", "utf8");
  await mkdir(path.join(root, "resources"), { recursive: true });
  await writeFile(path.join(root, "resources", "app.asar"), "app payload\n", "utf8");
  const sourceSha = "1111111111111111111111111111111111111111";
  const proof = await writeBuildInfo(root, sourceSha);
  return { root, sourceSha, ...proof };
}

describe("runtime package integrity", () => {
  it("D184 rejects independent package tamper cases while claimed identity is unchanged", async () => {
    const cases: Array<[string, (runtimeDir: string) => Promise<void>, RegExp]> = [
      ["file bytes", async (runtimeDir) => writeFile(path.join(runtimeDir, "resources", "app.asar"), "tampered\n", "utf8"), /manifest mismatch/i],
      ["added file", async (runtimeDir) => writeFile(path.join(runtimeDir, "resources", "extra.txt"), "extra\n", "utf8"), /manifest mismatch/i],
      ["removed file", async (runtimeDir) => rm(path.join(runtimeDir, "resources", "app.asar")), /manifest mismatch/i],
      ["renamed file", async (runtimeDir) => rename(path.join(runtimeDir, "resources", "app.asar"), path.join(runtimeDir, "resources", "renamed.asar")), /manifest mismatch/i],
      ["manifest hash", async (runtimeDir) => {
        const buildPath = path.join(runtimeDir, "BUILD_INFO.json");
        const buildInfo = JSON.parse(await readFile(buildPath, "utf8"));
        buildInfo.packageManifest[0].sha256 = "0".repeat(64);
        await writeFile(buildPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
      }, /manifest mismatch/i],
      ["source sha", async (runtimeDir) => {
        const buildPath = path.join(runtimeDir, "BUILD_INFO.json");
        const buildInfo = JSON.parse(await readFile(buildPath, "utf8"));
        buildInfo.sourceSha = "2222222222222222222222222222222222222222";
        await writeFile(buildPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
      }, /source mismatch/i],
      ["capability", async (runtimeDir) => {
        const buildPath = path.join(runtimeDir, "BUILD_INFO.json");
        const buildInfo = JSON.parse(await readFile(buildPath, "utf8"));
        buildInfo.reciprocalCapabilities.candidatePreviewArtifactLifecycle = 0;
        await writeFile(buildPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
      }, /capability/i],
    ];

    for (const [name, tamper, message] of cases) {
      const runtime = await makeRuntime(`runtime-integrity-${name.replace(/\W+/g, "-")}-`);
      try {
        await expect(verifyPackage(runtime.root, { sourceSha: runtime.sourceSha, packageIdentity: runtime.identity })).resolves.toMatchObject({ packageIdentity: runtime.identity });
        await tamper(runtime.root);
        await expect(verifyPackage(runtime.root, { sourceSha: runtime.sourceSha, packageIdentity: runtime.identity })).rejects.toThrow(message);
      } finally {
        await rm(runtime.root, { recursive: true, force: true });
      }
    }
  });

  it("D184 rejects symlink or junction entries inside a package", async () => {
    const runtime = await makeRuntime("runtime-integrity-link-");
    const outside = path.join(tmpdir(), `runtime-integrity-outside-${randomUUID()}`);
    try {
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(runtime.root, "linked-outside"), "junction");
      await expect(verifyPackage(runtime.root, { sourceSha: runtime.sourceSha, packageIdentity: runtime.identity })).rejects.toThrow(/symlink|junction/i);
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  windowsIt("D184 promotion retry preserves one original runtime backup and verifies the target", async () => {
    const relayRoot = path.join(tmpdir(), `runtime-promote-${randomUUID()}`);
    const source = path.join(relayRoot, "packages", "candidate");
    const target = path.join(relayRoot, "runtimes", "executor-a");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "Tandem.exe"), "candidate runtime\n", "utf8");
      await writeFile(path.join(source, "resources.bin"), "candidate resources\n", "utf8");
      const sourceSha = "3333333333333333333333333333333333333333";
      const sourceProof = await writeBuildInfo(source, sourceSha);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "Tandem.exe"), "old runtime\n", "utf8");
      await writeFile(path.join(target, "BUILD_INFO.json"), `${JSON.stringify({ sourceSha: "0000000000000000000000000000000000000000", sourceShortSha: "0000000" }, null, 2)}\n`, "utf8");

      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/promote-reciprocal-runtime.ps1"), "-RelayRoot", relayRoot, "-Source", source, "-SourceSha", sourceSha, "-TargetRole", "A", "-BuildRound", "D184", "-PromotedRound", "D184"];
      await execa("powershell", args);
      const operationPath = path.join(relayRoot, "state", "promotion-operations", "executor-a.json");
      const firstOperation = JSON.parse(await readFile(operationPath, "utf8"));
      expect(firstOperation).toMatchObject({ stage: "completed", packageIdentity: sourceProof.identity });
      expect(existsSync(firstOperation.backupPath)).toBe(true);
      expect(await readFile(path.join(firstOperation.backupPath, "Tandem.exe"), "utf8")).toBe("old runtime\n");

      await execa("powershell", args);
      const secondOperation = JSON.parse(await readFile(operationPath, "utf8"));
      expect(secondOperation.backupPath).toBe(firstOperation.backupPath);
      expect(secondOperation).toMatchObject({ stage: "completed", packageIdentity: sourceProof.identity });
      expect(await readFile(path.join(secondOperation.backupPath, "Tandem.exe"), "utf8")).toBe("old runtime\n");
      await expect(verifyPackage(target, { sourceSha, packageIdentity: sourceProof.identity })).resolves.toMatchObject({ packageIdentity: sourceProof.identity });
    } finally {
      await rm(relayRoot, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D193 retires completed promotion operations before promoting a different package", async () => {
    const relayRoot = path.join(tmpdir(), `runtime-promote-completed-${randomUUID()}`);
    const sourceOne = path.join(relayRoot, "packages", "one");
    const sourceTwo = path.join(relayRoot, "packages", "two");
    const target = path.join(relayRoot, "runtimes", "executor-b");
    try {
      await mkdir(sourceOne, { recursive: true });
      await writeFile(path.join(sourceOne, "Tandem.exe"), "first runtime\n", "utf8");
      await writeFile(path.join(sourceOne, "resources.bin"), "first resources\n", "utf8");
      const sourceOneSha = "1111111111111111111111111111111111111111";
      const sourceOneProof = await writeBuildInfo(sourceOne, sourceOneSha);

      await mkdir(sourceTwo, { recursive: true });
      await writeFile(path.join(sourceTwo, "Tandem.exe"), "second runtime\n", "utf8");
      await writeFile(path.join(sourceTwo, "resources.bin"), "second resources\n", "utf8");
      const sourceTwoSha = "2222222222222222222222222222222222222222";
      const sourceTwoProof = await writeBuildInfo(sourceTwo, sourceTwoSha);

      const script = path.resolve("scripts/promote-reciprocal-runtime.ps1");
      const firstArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RelayRoot", relayRoot, "-Source", sourceOne, "-SourceSha", sourceOneSha, "-TargetRole", "B", "-BuildRound", "D193", "-PromotedRound", "D193"];
      const secondArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RelayRoot", relayRoot, "-Source", sourceTwo, "-SourceSha", sourceTwoSha, "-TargetRole", "B", "-BuildRound", "D193", "-PromotedRound", "D193"];
      await execa("powershell", firstArgs);

      const operationPath = path.join(relayRoot, "state", "promotion-operations", "executor-b.json");
      const firstOperation = JSON.parse(await readFile(operationPath, "utf8"));
      expect(firstOperation).toMatchObject({ stage: "completed", packageIdentity: sourceOneProof.identity });

      await execa("powershell", secondArgs);

      const secondOperation = JSON.parse(await readFile(operationPath, "utf8"));
      expect(secondOperation).toMatchObject({ stage: "completed", packageIdentity: sourceTwoProof.identity });
      expect(existsSync(path.join(relayRoot, "state", "promotion-operations", "completed", `executor-b-${firstOperation.operationId}.json`))).toBe(true);
      await expect(verifyPackage(target, { sourceSha: sourceTwoSha, packageIdentity: sourceTwoProof.identity })).resolves.toMatchObject({ packageIdentity: sourceTwoProof.identity });
    } finally {
      await rm(relayRoot, { recursive: true, force: true });
    }
  }, 60_000);

  windowsIt("D194 keeps in-flight promotion operations fail-closed for different packages", async () => {
    const relayRoot = path.join(tmpdir(), `runtime-promote-inflight-${randomUUID()}`);
    const sourceOne = path.join(relayRoot, "packages", "one");
    const sourceTwo = path.join(relayRoot, "packages", "two");
    const operationRoot = path.join(relayRoot, "state", "promotion-operations");
    try {
      await mkdir(sourceOne, { recursive: true });
      await writeFile(path.join(sourceOne, "Tandem.exe"), "first runtime\n", "utf8");
      await writeFile(path.join(sourceOne, "resources.bin"), "first resources\n", "utf8");
      const sourceOneSha = "1111111111111111111111111111111111111111";
      const sourceOneProof = await writeBuildInfo(sourceOne, sourceOneSha);

      await mkdir(sourceTwo, { recursive: true });
      await writeFile(path.join(sourceTwo, "Tandem.exe"), "second runtime\n", "utf8");
      await writeFile(path.join(sourceTwo, "resources.bin"), "second resources\n", "utf8");
      const sourceTwoSha = "2222222222222222222222222222222222222222";
      await writeBuildInfo(sourceTwo, sourceTwoSha);

      await mkdir(operationRoot, { recursive: true });
      await writeFile(path.join(operationRoot, "executor-b.json"), `${JSON.stringify({
        schemaVersion: 1,
        operationId: "promote-b-inflight",
        role: "b",
        sourceSha: sourceOneSha,
        packageIdentity: sourceOneProof.identity,
        sourcePath: sourceOne,
        targetPath: path.join(relayRoot, "runtimes", "executor-b"),
        stagingPath: path.join(relayRoot, "runtimes", ".promote-staging-executor-b-promote-b-inflight"),
        backupPath: path.join(relayRoot, "runtimes", "backups", "executor-b-promote-b-inflight"),
        stage: "backup-created",
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");

      const script = path.resolve("scripts/promote-reciprocal-runtime.ps1");
      await expect(execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RelayRoot", relayRoot, "-Source", sourceTwo, "-SourceSha", sourceTwoSha, "-TargetRole", "B", "-BuildRound", "D194", "-PromotedRound", "D194"]))
        .rejects.toThrow(/targets a different package/);
    } finally {
      await rm(relayRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
