import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildPlan } from "./artifacts.js";

export interface WorkspaceArtifact {
  path: string;
  size: number;
  modifiedAt: string;
  complete: boolean;
}

export interface InventoryCriterion {
  criterion: string;
  status: "satisfied" | "unmatched";
  artifacts: string[];
  reason: string;
}

export interface WorkspaceInventory {
  generatedAt: string;
  root: string;
  artifacts: WorkspaceArtifact[];
  completeArtifactCount: number;
  incompleteArtifactCount: number;
  countsByExtension: Record<string, number>;
  criteria: InventoryCriterion[];
  satisfiedCriteria: string[];
  verificationRequired: true;
}

const ignoredDirectories = new Set([".git", "node_modules", ".tandem"]);
const partialSuffix = /(?:\.tmp|\.part|\.partial|\.writing|\.inprogress|\.lock)$/i;

async function filesUnder(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

async function stableArtifact(fullPath: string, root: string): Promise<WorkspaceArtifact | undefined> {
  try {
    const before = await stat(fullPath);
    // Take the second observation immediately. Comparing both observations still rejects
    // files whose size or mtime changes during the scan, while avoiding a per-file sleep
    // that makes orchestration tests and ordinary small workspaces needlessly time out.
    const after = await stat(fullPath);
    const relative = path.relative(root, fullPath).split(path.sep).join("/");
    const complete = !partialSuffix.test(relative) && before.size === after.size && before.mtimeMs === after.mtimeMs;
    return { path: relative, size: after.size, modifiedAt: after.mtime.toISOString(), complete };
  } catch {
    return undefined;
  }
}

function criterionCandidates(criterion: string): string[] {
  return [...criterion.matchAll(/[\w.-]+(?:[\\/][\w.-]+)*\.[A-Za-z0-9]{1,8}/g)].map((match) => match[0].replace(/\\/g, "/"));
}

function matchCriteria(criteria: string[], artifacts: WorkspaceArtifact[]): InventoryCriterion[] {
  const complete = artifacts.filter((artifact) => artifact.complete);
  return criteria.map((criterion) => {
    const candidates = criterionCandidates(criterion);
    const matches = complete.filter((artifact) => candidates.some((candidate) => artifact.path === candidate || artifact.path.endsWith(`/${candidate}`)));
    const count = Number(criterion.match(/\b(\d+)\b/)?.[1]);
    const extension = criterion.match(/\.([A-Za-z0-9]{1,8})\b/)?.[1]?.toLowerCase();
    const counted = Number.isFinite(count) && count > 0 && extension
      ? complete.filter((artifact) => path.extname(artifact.path).slice(1).toLowerCase() === extension)
      : [];
    if (matches.length > 0) return { criterion, status: "satisfied", artifacts: matches.map((a) => a.path), reason: "stable artifact path matched; verification still required" };
    if (counted.length >= count && count > 0) return { criterion, status: "satisfied", artifacts: counted.map((a) => a.path), reason: `filesystem count ${counted.length} meets requested count; verification still required` };
    return { criterion, status: "unmatched", artifacts: candidates, reason: candidates.length > 0 ? "no stable matching artifact found" : "no filesystem artifact reference could be inferred; verification is required" };
  });
}

export async function inventoryWorkspace(cwd: string, plan?: Pick<BuildPlan, "acceptanceCriteria">): Promise<WorkspaceInventory> {
  const root = path.resolve(cwd);
  const artifacts = (await Promise.all((await filesUnder(root)).map((file) => stableArtifact(file, root)))).filter((artifact): artifact is WorkspaceArtifact => artifact !== undefined);
  const countsByExtension: Record<string, number> = {};
  for (const artifact of artifacts) {
    if (!artifact.complete) continue;
    const extension = path.extname(artifact.path).slice(1).toLowerCase() || "[none]";
    countsByExtension[extension] = (countsByExtension[extension] ?? 0) + 1;
  }
  const criteria = matchCriteria(plan?.acceptanceCriteria ?? [], artifacts);
  return {
    generatedAt: new Date().toISOString(), root,
    artifacts, completeArtifactCount: artifacts.filter((a) => a.complete).length,
    incompleteArtifactCount: artifacts.filter((a) => !a.complete).length,
    countsByExtension, criteria,
    satisfiedCriteria: criteria.filter((c) => c.status === "satisfied").map((c) => c.criterion),
    verificationRequired: true
  };
}
