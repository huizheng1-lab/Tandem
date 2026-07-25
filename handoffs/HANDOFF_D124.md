# Handoff D124 (make codex/cli + GPT-5.6 work as the reciprocal executors' leader)

User request: the reciprocal executors' leader must be Codex CLI with GPT-5.6 - the
minimax fallback D122 applied was a workaround, not the desired end state.

## Verified facts (I tested these live - build on them, don't re-derive)

- There is NO MSIX app-execution alias: `%LOCALAPPDATA%\Microsoft\WindowsApps\codex.exe`
  does not exist on this machine.
- `C:\Users\huizh\AppData\Local\OpenAI\Codex\bin\3135b80b111fd431\codex.exe` EXISTS and IS
  SPAWNABLE - I ran it directly: reports `codex-cli 0.144.2`. (The sibling hash folder
  `ada252862d154cdd` contains no codex.exe.)
- D119's dashboard resolution and D122's live executor run both ended up at
  `C:\Program Files\WindowsApps\OpenAI.Codex_...\app\resources\codex.exe`, which CANNOT be
  spawned by ordinary processes (MSIX ACL restriction) - that's the D122 "inaccessible"
  failure.
- The user's daily Tandem runs codex/cli leader successfully, so resolution in the normal
  environment lands on a spawnable path.

## D124-1: fix resolution so it never returns an unspawnable candidate

In `src/agents/codex-cli/locate.ts`: the problem is ordering/validation, not existence -
`existsSync` returns true for the WindowsApps MSIX path even though spawning it fails.
Fix direction (pick the cleanest that keeps D105's self-healing cache intact):
- Skip PATH candidates residing under `...\Program Files\WindowsApps\...` (they are
  MSIX-internal payload paths; if an execution alias existed it would live under
  `%LOCALAPPDATA%\Microsoft\WindowsApps` instead, which is fine to accept), OR
- validate spawnability before caching a candidate (a fast `codexCliVersion()`-style
  probe), falling through to `newestWindowsFallback` when the probe fails.
Also check WHY the executor context resolved to the WindowsApps path at all while the
daily app doesn't - trace what `env`/PATH the executor's leader spawn actually receives
(the isolated launch may inherit a different PATH; understand it, state it in the marker).
`newestWindowsFallback` must also skip hash folders lacking codex.exe (it already filters
by existence - confirm it lands on `3135b80b111fd431`). Regression tests for the skip/
validation logic using the existing injected-fakes pattern in tests/codex-cli.test.ts.
Do NOT hardcode the hash path anywhere - it changes on codex updates (D105 lesson).

## D124-2: GPT-5.6 as the codex model, verified live

Determine the exact model string the installed codex-cli 0.144.2 accepts for GPT-5.6
(candidates: `gpt-5.6`, `gpt-5.6-codex`, or the CLI's own default may already be a 5.6
variant - check `codex --help` / config surface, then verify with one real cheap call and
paste the raw output showing which model actually served it, per the D113/fable
discipline: prove the model ran, don't assume from exit 0). Set both executors' config:
`leader: "codex/cli"`, `codexCliModel: "<verified string>"` (or omit if the CLI default is
already correct - state which), worker stays `minimax/minimax-m3`. Write configs BOM-less
(D122 lesson - use the fixed update-model-config.ps1 path or equivalent).

## D124-3: prove it end to end in the real executor context

The failure was context-specific, so verification must run in that context: with both
executors running hidden (D122 launch path), drive ONE real leader call through executor
A - either a real relay turn (if a wishlist item is queued) or a minimal
automation-endpoint prompt that triggers leader planning - and confirm the codex/cli
leader actually spawns and returns real output (no ENOENT, no MSIX access error). Paste
the relevant session/audit evidence. Confirm the dashboard model picker (D119 logic) now
shows codex/cli available for the executors with the fixed resolution.

## Acceptance

tsc + `npm test` green (rerun; include the new locate regressions). Marker includes: the
resolution fix explanation + why the executor env differed, the verified GPT-5.6 model
string with raw call output, BOM-less config diffs (byte-prefix check), and the live
executor-context leader-call evidence from D124-3. Commit `D124-<n>:` for admin-repo
changes; describe dashboard/state changes in the marker. If codex/cli genuinely cannot be
made spawnable in the executor context after root-causing (e.g. an OS-level restriction
with no sane workaround), say so plainly with the evidence and leave minimax in place -
do not ship a flaky half-working leader. Create `handoffs/D124_done.txt`.
