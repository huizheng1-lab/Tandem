# Handoff D57 (verify commands like Claude Code does: check the binary actually exists, don't guess from string shape)

## Why (user-requested philosophy change)
D55 fixed the ffprobe false-rejection by adding entries to an allowlist and a string-shape
heuristic (flags/paths after a bare word). Both approaches share the same flaw Claude Code
doesn't have: they GUESS whether a command is real from its text, instead of checking whether it
actually is. Claude Code has no "does this look like a real command" gate at all — it just
invokes the command and the shell is the ground truth (`command not found` if it isn't real).
User asked to move Tandem's verification validator toward that same method: stop guessing from
string shape, check for real PATH resolution instead — that's the actual authoritative signal,
and it can never have a "some legitimate tool I forgot to list" false-rejection class of bug
again.

## D57-1: Replace the primary signal with real PATH/executable resolution
In `src/orchestrator/artifacts.ts`, for the first token of a verification entry that isn't one of
the genuine SHELL BUILT-INS (see below — these can't be found via filesystem lookup since they
aren't separate files), check whether it resolves to a real executable:
- Reuse the exact PATH-scanning pattern already established in this codebase —
  `src/agents/codex-cli/locate.ts` and `src/agents/claude-code-cli/locate.ts` both already do
  this (split `env.PATH`/`env.Path` by `path.delimiter`, join each directory with candidate
  filenames, check existence). Extract a small shared helper (e.g.
  `src/tools/resolveOnPath.ts`) rather than re-implementing it a third time — refactor the two
  existing locate.ts files to use it too if that's a clean win, but don't let that refactor block
  D57 if it's risky; a new shared helper used going forward is enough.
- Platform-appropriate candidates: on win32, try the bare token plus `.exe`/`.cmd`/`.bat`/`.com`
  suffixes (check `PATHEXT` env var if set, matching how Windows itself resolves bare commands,
  rather than hardcoding the four); on POSIX, the bare token with the executable bit set.
- If the token resolves on PATH → this verification entry passes with HIGH confidence, same as
  Claude Code discovering a real binary. Skip the string-shape heuristic entirely for a resolved
  binary — no need to also check for flags/paths.

## D57-2: Keep a small allowlist ONLY for genuine shell built-ins
Some accepted verification commands are not separate executables and will never resolve via
PATH lookup: `dir`, `type`, `where`, `findstr`, `cmd`, `powershell`, `pwsh` (Windows shell
built-ins/interpreters) and their POSIX equivalents already in scope. Keep exactly these as a
small, explicitly-commented fast-path allowlist ("shell built-ins, not real PATH-resolvable
files — this list must stay tiny and only grow for genuine built-ins, not general tools").
Remove the general-purpose tool names from the old `runnableCommandStarters` list (npm, node,
python, ffprobe, docker, etc.) — those are all real PATH-resolvable binaries now, they don't need
to be hardcoded anymore, which is the whole point.

## D57-3: Graceful fallback when PATH resolution fails
Do NOT hard-reject just because a token doesn't resolve on PATH. Two real reasons that's not
proof of prose: (a) the tool is legitimate but not installed on whatever machine is doing plan
VALIDATION, which may differ from the machine that will actually EXECUTE the plan later, or a
prior task in the same plan installs it first (e.g. `npm install -g some-cli` in task 1, then
`some-cli check` in the plan's verification); (b) it's genuinely prose. When PATH resolution
fails, fall back to the existing D55-2 shape heuristic (bare word + flag/path indicators) as a
softer secondary signal — keep that code, don't delete it. Only reject if BOTH real resolution
fails AND the shape heuristic doesn't recognize it as command-shaped (i.e. it looks like prose).
This mirrors how a careful human would actually judge an unfamiliar command they can't test
locally: "does this look like a real invocation" is still useful as a fallback signal, just not
the PRIMARY one anymore.

## D57-4: This makes validation async — migrate all call sites and tests
PATH resolution requires filesystem/env access; make `validateBuildPlan` /
`validateVerificationEntry` / `hasCommandShape` async (return Promises). All 4 production call
sites are already inside async functions (confirmed): `src/agents/live.ts:487`,
`src/orchestrator/machine.ts:119`, `src/agents/claude-code-cli/leader.ts:108`,
`src/agents/codex-cli/leader.ts:105` — add `await` at each, no restructuring needed beyond that.
Existing tests calling `validateBuildPlan` synchronously (D55 added 9, there are more
pre-existing ones in tests/artifacts.test.ts and elsewhere — grep for all call sites) will need
updating to `async () => { await expect(...).resolves/rejects... }` form — this is expected
churn from the design change, not a red flag; update every call site, don't leave any
synchronous callers broken.

## Acceptance
tsc + `npm test` green. New/updated tests: the four original ffprobe commands and the D55 tool
list (magick, sox, pandoc, curl, docker, etc.) still validate — now via REAL PATH resolution, not
a hardcoded name check (verify this by confirming the test machine actually has these tools, or
mock/stub the PATH-resolution helper for tools not installed in CI — your call, document which);
a genuinely fake binary name (`totally-not-a-real-tool-xyz --check`) is now correctly rejected
even though it has flag syntax (proving PATH-resolution, not shape, is now the primary signal —
this is the concrete case D55-2 alone could NOT have caught, since it has flags and would pass
the old heuristic); prose is still rejected; shell built-ins (`dir`, `type`, `where`) still work
without needing PATH resolution; POSIX guard on win32 unchanged. Live check: submit a real plan
with a verification command for a tool NOT in any hardcoded list (pick something installed on
your dev machine, e.g. `git --version` is a bad example since git's already common — use
something more obscure that's actually installed, like `ffprobe` itself, to prove no hardcoded
allowlist entry made it pass) and confirm it now validates via genuine resolution rather than a
name match. Commit `D57-<n>:`, create `D57_done.txt` with the real PATH-resolution evidence
(e.g. print which directory the tool resolved to).
