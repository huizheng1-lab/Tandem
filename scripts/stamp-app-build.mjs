import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(repoRoot, "release", "win-unpacked");

async function git(args) {
  return (await execa("git", args, { cwd: repoRoot })).stdout.trim();
}

const [sourceSha, sourceBranch] = await Promise.all([
  git(["rev-parse", "HEAD"]),
  git(["branch", "--show-current"]).catch(() => ""),
]);

const buildInfo = {
  sourceSha,
  sourceShortSha: sourceSha.slice(0, 7),
  sourceBranch,
  builtAt: new Date().toISOString(),
  artifact: "release/win-unpacked",
};

await mkdir(releaseDir, { recursive: true });
await writeFile(path.join(releaseDir, "BUILD_INFO.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
console.log(`Stamped release/win-unpacked/BUILD_INFO.json for ${buildInfo.sourceShortSha}`);
