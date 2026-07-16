# Handoff to GPT-5 - Round D49 (stabilize Claude live verification harness after D47/D48)

## Prior round verification
D48 is complete and should be treated as the latest completed round.

- D48 implementation commit: `19a824c D48-1: add Gemini cache audit scripts`
- D48 marker commit: `d3b298d D48-2: add completion marker`
- Marker file: `D48_done.txt`
- D48 conclusion: Gemini implicit caching was not observed through the current `@ai-sdk/google` Gemini Developer API path because three real `google/gemini-2.5-pro` calls returned no `usageMetadata.cachedContentTokenCount` and no `usage.cachedInputTokens`.

Do not revisit D48 unless new provider evidence appears. D49 is about the Claude live harness and the current dirty workspace state.

## Current situation
After D47 was committed, `scripts/live-d47-claude.ts` was edited again in the working tree. The dirty version appears to undo some of the D47 live-harness safeguards:

- removes `locateClaudeCli(...)` and calls `execa("claude", ...)` again
- removes temp-directory isolation via `mkdtemp(...)`
- uses a fixed `C:/tmp-d47-test` directory
- stops printing raw stdout for the leader success case

D47's core production fix was not just prompt wording; it also discovered that Windows npm `.cmd` shims can mangle multiline `-p` prompt argv. The committed production locator now prefers Anthropic's real `node_modules/@anthropic-ai/claude-code/bin/claude.exe` path. The D47 live script should continue exercising that production discovery route so future live verification does not accidentally pass or fail through PowerShell/`.cmd` behavior.

## D49-1: Reconcile `scripts/live-d47-claude.ts` with D47's accepted harness
Inspect the current dirty diff for `scripts/live-d47-claude.ts` and decide whether any of the post-D47 edits are useful. Preserve only changes that strengthen the harness without reintroducing the Windows `.cmd` argv problem.

Required final behavior:

- use `locateClaudeCli({ env: process.env })` or another direct production path that proves the real executable selected by Tandem is used
- do not call bare `execa("claude", ...)` on Windows
- run the worker scenario in an isolated throwaway directory, not a fixed path that can retain prior artifacts
- print raw stdout for at least the leader direct-question scenario and the worker build scenario
- keep the prompt assertions implicit in the logged `USER PROMPT` output: no D44 preamble, no `Worker task:` lead-in, and worker prompt starts with actionable `BuildPlan:`

If the current dirty edit was made intentionally by another agent, keep any harmless improvements but explain in the completion marker exactly what was kept and what was reverted.

## D49-2: Add a static regression test for the harness route if practical
If it can be done without overfitting the live script, add or update a unit test that protects the Windows launcher rule already discovered in D47:

- PATH discovery should prefer `node_modules/@anthropic-ai/claude-code/bin/claude.exe` over `claude.cmd` on Windows
- explicit config/env override should still win even if the override is a `.cmd` path

If the existing tests already cover this fully, do not add redundant tests; just mention that coverage in the marker.

## D49-3: Run live verification only if safe
Run:

```
npx tsx scripts/live-d47-claude.ts
```

Expected live result:

- leader direct question returns `structured_output.kind="question"` and `answer="81"`
- worker build returns `structured_output.status="complete"`
- worker verification result includes the exact node verification command from the BuildPlan and `passed=true`
- no empty/error/acknowledgment envelope

If live Claude quota or auth blocks the run, do not fake success. Keep the code/test fix scoped, record the blocker, and do not create `D49_done.txt` unless the round genuinely meets acceptance or the handoff is explicitly amended.

## Acceptance checks
At minimum run:

```
npm run typecheck
npm test
git diff --check
```

Also run the D47 live script as described above unless blocked by external quota/auth.

## Commit and marker requirements
Stage only intended D49 files. Leave untracked handoff docs untouched.

Suggested commit messages:

- `D49-1: restore Claude live harness executable isolation`
- `D49-2: add completion marker`

After successful implementation and verification, create `D49_done.txt` in the workspace root. Include:

- round number
- implementation commit hash
- whether the dirty pre-existing `scripts/live-d47-claude.ts` edit was preserved, revised, or reverted
- static verification summary
- live `scripts/live-d47-claude.ts` result summary with raw stdout excerpts or a clear blocker
