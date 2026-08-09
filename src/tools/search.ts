import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { resolveInside } from "./fs.js";
import { sanitizePromptText } from "./sanitize.js";

export const MAX_SEARCH_RESULTS = 500;
export const MAX_SEARCH_RUNTIME_MS = 10000;

export interface FileSearchMatch {
  path: string;
  line?: number;
  text?: string;
}

export interface FileSearchResult {
  status: "matched" | "no-match";
  operation: "glob" | "grep";
  roots: string[];
  patterns: string[];
  matches: FileSearchMatch[];
  truncated: boolean;
  elapsedMs: number;
}

const searchOptions = {
  dot: true,
  ignore: ["node_modules/**", "dist/**", ".git/**"]
};

function boundedSearch<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`File search exceeded ${timeoutMs}ms.`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function searchFilesTool(input: {
  root: string;
  patterns: string[];
  contentPattern?: string;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<FileSearchResult> {
  const started = Date.now();
  const roots = [path.resolve(input.root)];
  const patterns = [...new Set(input.patterns.map((value) => value.trim()).filter(Boolean))];
  if (patterns.length === 0) throw new Error("File search requires at least one glob pattern.");
  const maxResults = Math.min(Math.max(input.maxResults ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? MAX_SEARCH_RUNTIME_MS, 1), MAX_SEARCH_RUNTIME_MS);
  const deadline = Date.now() + timeoutMs;
  const nextSearch = <T>(promise: Promise<T>): Promise<T> => boundedSearch(promise, Math.max(1, deadline - Date.now()));
  const matches: FileSearchMatch[] = [];
  let truncated = false;
  const add = (match: FileSearchMatch) => {
    if (matches.length < maxResults) matches.push(match);
    else truncated = true;
  };

  if (input.contentPattern !== undefined) {
    const regex = new RegExp(input.contentPattern);
    for (const pattern of patterns) {
      const files = await nextSearch(fg(pattern, { cwd: roots[0], ...searchOptions, onlyFiles: true }));
      for (const file of files) {
        if (matches.length >= maxResults) { truncated = true; break; }
        try {
          const content = sanitizePromptText(await readFile(path.join(roots[0], file), "utf8"));
          for (const [index, line] of content.split(/\r?\n/).entries()) {
            regex.lastIndex = 0;
            if (regex.test(line)) add({ path: path.resolve(roots[0], file), line: index + 1, text: line });
            if (matches.length >= maxResults) break;
          }
        } catch { /* unreadable files are not search errors */ }
      }
    }
  } else {
    for (const pattern of patterns) {
      const files = await nextSearch(fg(pattern, { cwd: roots[0], ...searchOptions, onlyFiles: true }));
      for (const file of files) add({ path: path.resolve(roots[0], file) });
    }
  }
  return {
    status: matches.length > 0 ? "matched" : "no-match",
    operation: input.contentPattern === undefined ? "glob" : "grep",
    roots,
    patterns,
    matches,
    truncated,
    elapsedMs: Date.now() - started
  };
}

export async function globTool(cwd: string, pattern: string): Promise<string[]> {
  const result = await searchFilesTool({ root: cwd, patterns: [pattern] });
  return result.matches.map((match) => path.relative(cwd, match.path));
}

export async function grepTool(cwd: string, pattern: string, globPattern = "**/*", searchPath = "."): Promise<string> {
  const root = resolveInside(cwd, searchPath);
  const result = await searchFilesTool({ root, patterns: [globPattern], contentPattern: pattern, maxResults: 200 });
  return result.matches.map((match) => `${path.relative(cwd, match.path)}:${match.line}:${match.text}`).join("\n");
}
