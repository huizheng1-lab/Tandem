// Shared PATH-resolution helper used by D57-1. Locates an executable on PATH the same way
// the host shell would: split env.PATH / env.Path on the platform's path separator, and for
// each directory yield `path.join(dir, name)` candidates in the caller's specified order. The
// first candidate that exists() returns true is the resolved path; returns undefined if none
// match. Caller provides its own existence predicate so tests can stub filesystem layout.
//
// On win32, the platform's cmd.exe / PowerShell look up bare commands by also trying
// `PATHEXT` extensions; we approximate that by letting the caller pass a list of names that
// already include the right suffixes. Returning `undefined` when the tool isn't installed is
// the graceful-fallback case (verification entry then falls back to the D55-2 shape heuristic
// per D57-3).
import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolveOnPathOptions {
  token: string;
  // Ordered list of file names to try per PATH directory. On win32 include the suffixes
  // the caller's environment expects (e.g. ["claude.exe", "claude.cmd"]). On POSIX the token
  // alone is usually enough.
  names: string[];
  env?: NodeJS.ProcessEnv;
  pathSeparator?: string;
  // Exists predicate. Defaults to a real fs.existsSync-based check. Tests stub this.
  exists?: (filePath: string) => boolean;
}

export function resolveOnPath(options: ResolveOnPathOptions): string | undefined {
  if (!options.token) return undefined;
  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const separator = options.pathSeparator ?? path.delimiter;
  const exists = options.exists ?? defaultExists;

  for (const dir of pathValue.split(separator)) {
    if (!dir) continue;
    for (const name of options.names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function defaultExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}
