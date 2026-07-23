import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const requiredReciprocalCapabilities = {
  candidatePreviewArtifactLifecycle: 1,
};

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function walkManagedFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Runtime package contains a symlink or junction escape: ${full}`);
    if (entry.isDirectory()) {
      files.push(...await walkManagedFiles(root, full));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Runtime package contains unsupported filesystem entry: ${full}`);
    if (entry.name === "BUILD_INFO.json") continue;
    const relative = path.relative(root, full).replaceAll(path.sep, "/");
    files.push({ path: relative, full });
  }
  return files;
}

export async function packageManifest(root) {
  const rootFull = path.resolve(root);
  const files = await walkManagedFiles(rootFull);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return Promise.all(files.map(async (file) => {
    const fileStat = await stat(file.full);
    return {
      path: file.path,
      sha256: await sha256File(file.full),
      bytes: fileStat.size,
    };
  }));
}

export function packageIdentity(sourceSha, manifest, capabilities = requiredReciprocalCapabilities) {
  return createHash("sha256").update(stableJson({
    sourceSha,
    manifest,
    reciprocalCapabilities: capabilities,
  })).digest("hex").toUpperCase();
}

export function assertManifestEqual(actual, expected) {
  const actualJson = stableJson(actual || []);
  const expectedJson = stableJson(expected || []);
  if (actualJson !== expectedJson) {
    throw new Error("Runtime package manifest mismatch.");
  }
}

export async function verifyPackage(root, options = {}) {
  const buildPath = path.join(root, "BUILD_INFO.json");
  const buildInfo = JSON.parse(await readFile(buildPath, "utf8"));
  const sourceSha = options.sourceSha || buildInfo.sourceSha;
  if (!sourceSha) throw new Error("Runtime package source SHA is missing.");
  if (options.sourceSha && buildInfo.sourceSha !== options.sourceSha) {
    throw new Error(`Runtime package source mismatch: ${buildInfo.sourceSha} != ${options.sourceSha}`);
  }
  const capabilities = buildInfo.reciprocalCapabilities || requiredReciprocalCapabilities;
  for (const [key, version] of Object.entries(requiredReciprocalCapabilities)) {
    if (Number(capabilities?.[key] || 0) < version) {
      throw new Error(`Runtime package capability ${key} is missing or below v${version}.`);
    }
  }
  const manifest = await packageManifest(root);
  assertManifestEqual(manifest, buildInfo.packageManifest);
  const identity = packageIdentity(sourceSha, manifest, capabilities);
  if (buildInfo.packageIdentity !== identity) {
    throw new Error(`Runtime package identity mismatch: ${buildInfo.packageIdentity} != ${identity}`);
  }
  if (options.packageIdentity && options.packageIdentity !== identity) {
    throw new Error(`Runtime package identity mismatch: ${identity} != ${options.packageIdentity}`);
  }
  return { root: path.resolve(root), buildInfo, manifest, packageIdentity: identity, sourceSha, capabilities };
}

async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source-sha") options.sourceSha = args[++index];
    else if (args[index] === "--package-identity") options.packageIdentity = args[++index];
  }
  if (command === "manifest") {
    const manifest = await packageManifest(root);
    console.log(JSON.stringify({ manifest }, null, 2));
    return;
  }
  if (command === "identity") {
    const sourceSha = options.sourceSha;
    if (!sourceSha) throw new Error("--source-sha is required for identity.");
    const manifest = await packageManifest(root);
    const identity = packageIdentity(sourceSha, manifest, requiredReciprocalCapabilities);
    console.log(JSON.stringify({ sourceSha, manifest, packageIdentity: identity, reciprocalCapabilities: requiredReciprocalCapabilities }, null, 2));
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await verifyPackage(root, options), null, 2));
    return;
  }
  throw new Error("Usage: runtime-package-integrity.mjs manifest|identity|verify <runtimeRoot> [--source-sha SHA] [--package-identity ID]");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
