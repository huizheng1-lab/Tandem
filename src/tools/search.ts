import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { resolveInside } from "./fs.js";

export async function globTool(cwd: string, pattern: string): Promise<string[]> {
  return fg(pattern, { cwd, dot: true, onlyFiles: false, ignore: ["node_modules/**", "dist/**", ".git/**"] });
}

export async function grepTool(cwd: string, pattern: string, globPattern = "**/*", searchPath = "."): Promise<string> {
  const root = resolveInside(cwd, searchPath);
  const regex = new RegExp(pattern);
  const files = await fg(globPattern, { cwd: root, dot: true, onlyFiles: true, ignore: ["node_modules/**", "dist/**", ".git/**"] });
  const matches: string[] = [];
  for (const file of files.slice(0, 2000)) {
    const fullPath = path.join(root, file);
    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (regex.test(line) && matches.length < 200) matches.push(`${path.relative(cwd, fullPath)}:${index + 1}:${line}`);
    });
  }
  return matches.join("\n");
}
