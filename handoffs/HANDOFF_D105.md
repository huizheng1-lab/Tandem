# Handoff D105 (Codex CLI path cache goes stale after a background auto-update, causing ENOENT)

Found live: the user's "three kingdoms" project (leader = codex/cli) hit
`Leader planning could not produce a valid result after retries: Error: spawn
C:\Users\huizh\AppData\Local\OpenAI\Codex\bin\a7c12ebff69fb123\codex.exe ENOENT`.

## Root cause

`locateCodexCli()` in `src/agents/codex-cli/locate.ts` (~line 16-73) caches the resolved
path in two module-level variables (`cachedPath`/`cachedKey`) for the lifetime of the
process. The cache key is `JSON.stringify({ override, path: env.PATH, local:
env.LOCALAPPDATA, platform })` - none of which change when Codex CLI silently updates
itself in the background. On Windows, resolution falls through to `newestWindowsFallback()`
(~line 23-35), which scans `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` subfolders and
picks the newest by mtime - a snapshot of the directory at the moment it first ran.

Confirmed live: the real bin directory no longer contains the hash folder from the error
(`a7c12ebff69fb123`) at all - it now has different folders (`3135b80b111fd431`,
`ada252862d154cdd`), meaning Codex CLI's own updater replaced/removed the old versioned
folder while Tandem's long-running desktop process was still alive. The cache key never
changed, so `locateCodexCli()` kept returning the stale, now-deleted path indefinitely -
every subsequent `codex/cli` leader call spawns a binary that no longer exists.

Also confirmed: `clearCodexCliPathCache()` (already exported from the same file, presumably
for test resets) is never called anywhere in `src/` or `app/` outside of tests - nothing
ever invalidates the cache during a real running session.

## Fix direction

The cache exists for a real reason (avoid re-scanning the filesystem on every single leader
call), so don't just delete it. Instead, make it self-healing: before trusting a cached
path, cheaply verify it still exists (`existsSync` is already imported and cheap relative to
a full directory rescan) and only fall through to a fresh `newestWindowsFallback()` scan (or
full re-resolution) when the cached path no longer exists. This keeps the cache's benefit
(no rescan on the common case) while fixing the actual bug (stale path survives a real
deletion). Don't change the cache key strategy itself unless you find that's insufficient -
the existence check alone should be enough to catch this failure mode.

Also worth checking (not required, only if trivial): does the equivalent Claude Code CLI
locate helper (`src/agents/claude-code-cli/locate.ts`, mentioned in prior D42 history as
already preferring the bundled `.exe` over the npm `.cmd` shim) have the same
cache-never-invalidates pattern? If it caches a resolved path the same way, it would be
vulnerable to the identical bug class on its own auto-update path. Only fix it if you find
the same pattern - don't go looking for unrelated work.

## Acceptance

tsc + `npm test` green. Regression test: seed `locateCodexCli()`'s cache with a path via one
call (using injected `exists`/`stat`/`readdir` fakes, matching this file's existing
dependency-injection test pattern), then change the injected `exists` fake so that cached
path now returns false and a *different* path is the real newest candidate, call
`locateCodexCli()` again with the same env/key inputs, and confirm it returns the new valid
path instead of the stale one. A second regression confirms the cache still short-circuits
(no rescan) when the cached path still exists, so the fix doesn't regress the original
performance intent. No live model call required - this is pure filesystem-resolution logic.
Commit `D105-<n>:`, create `handoffs/D105_done.txt`.
