# Handoff D119 (dashboard model pickers are out of sync with real Tandem model resolution)

User report: Codex CLI models show grayed-out/unavailable in the reciprocal dashboard even
though the live Tandem app can use them fine, and the Claude Code CLI variant dropdown is
missing Fable 5 (added in D113).

## Root cause 1: CLI availability check does not use Tandem's real resolution logic

`dashboard/server.mjs`, `getModelSettings()` (~line 201-204):

```js
const cliAvailable = {
  "codex-cli": await run("where.exe", ["codex"]).then(() => true).catch(() => false),
  "claude-code-cli": await run("where.exe", ["claude"]).then(() => true).catch(() => false),
};
```

This is a bare PATH lookup from the dashboard server process's own environment. It does NOT
match how Tandem itself resolves these CLIs: `src/agents/codex-cli/locate.ts`'s
`locateCodexCli()` and `src/agents/claude-code-cli/locate.ts`'s `locateClaudeCli()` both
check an explicit override, walk PATH with the correct candidate names per platform, AND
(Codex, Windows) fall back to scanning the versioned `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>`
folder for the newest `codex.exe` (see D105's whole saga - this fallback exists precisely
because the CLI is often NOT a bare PATH entry on Windows). A dashboard-side reimplementation
that only checks `where.exe` will report "unavailable" in exactly the cases the real
resolvers were built to handle.

**Fix**: don't reimplement detection - reuse the real functions. The dashboard is plain
Node/ESM already; import `locateCodexCli` and `locateClaudeCli` directly from the compiled
output (`dist/agents/codex-cli/locate.js` / `dist/agents/claude-code-cli/locate.js` -
check whether `npm run build`'s output is what's actually consumable, or import the `.ts`
via whatever the dashboard's existing Node setup supports; it already imports project
source as plain text for regex parsing, so check if it can import compiled JS directly
instead). Call each locate function with the executor's own isolated env (already loaded
via `configuredEnvKeys`/the executor's `.env` - pass a real `env` object matching what
`locateCodexCli(options)`/`locateClaudeCli(options)` expect, not `process.env` of the
dashboard server) and treat `available = Boolean(resolvedPath)`. Do not duplicate the
hash-folder-scanning logic in the dashboard - call the real function so the two code paths
can never diverge again.

## Root cause 2: Claude CLI model variant list is a separate hardcoded array

`dashboard/public/app.js` (~line 140): `["default", "haiku", "sonnet", "opus"]` is
hand-maintained separately from `app/renderer/src/cli-model-options.ts`'s
`claudeCliModelOptions` (which D113 added specifically so this list has one source of
truth, verified live to include `claude-fable-5`).

**Fix**: the dashboard cannot easily `import` a TS/ESM renderer module into a plain browser
`<script>` without a build step - check what's simplest given how `app.js` is currently
served (a static file per `server.mjs`'s `serveFile`). Reasonable options, pick whichever
fits the existing serving mechanism with the least new machinery:
(a) Have `server.mjs` read `app/renderer/src/cli-model-options.ts` (same pattern already
used for `registry.ts`/`schema.ts` - textFile + parse) and inject the options into a
new/existing status or models endpoint response, then have `app.js` render from that
response instead of its own hardcoded array.
(b) Have a small build/copy step produce a plain JSON or JS file from
`cli-model-options.ts` that the dashboard serves alongside `app.js`.
Do NOT hand-add `"claude-fable-5"` as a third separate hardcoded copy - that just
recreates the same drift a third time when the next CLI model option is added.

## General note

Both root causes are the same shape: the dashboard reimplements something Tandem's real
source already does correctly, and the two copies drifted. Prefer reuse over
reimplementation for anything touching model resolution or CLI availability - this is
exactly the category of "looks reasonable in isolation, silently wrong versus the real
app" bug this project has hit repeatedly (D41-D47, D105).

## Acceptance

Manual dashboard check: with Codex CLI and Claude Code CLI genuinely usable from a real
Tandem session (confirm via `/model` in the live app or the existing test coverage), the
dashboard's model picker must show BOTH as available for at least one executor role, and
the Claude Code CLI variant list must include `claude-fable-5` alongside
haiku/sonnet/opus/default. Paste the actual `/api/models` (or equivalent) response showing
this. If a regression test is practical for the parsing/rendering logic added, add it;
otherwise a clear manual verification note is acceptable since this is dashboard code
outside the main test suite. tsc + `npm test` in the admin repo unaffected - run as sanity.
Commit any admin-repo-side changes (if reuse requires exporting something new from
`src/`/`app/renderer/src/`) with `D119-<n>:`; dashboard-side changes live outside the repo
at `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard` - describe them in the marker. Create
`handoffs/D119_done.txt`.
