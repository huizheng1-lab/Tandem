# Handoff D66 (two real findings from live use: recurring wrong-path reads, and wasteful blind retries on rate limits)

Two separate, real issues observed in live Claude-Code-CLI-backed sessions, both with concrete
evidence (pasted below). Independent fixes, can be done in either order.

## D66-1: recurring wrong-path file reads (4 occurrences observed this session)

Across several real sessions, the `claude-code/cli` leader has repeatedly tried to Read a file at
a path missing the actual project subdirectory — resolving relative-looking references (like
`alpha.txt`, `scripts/RENDER-NOTES.md`, `.tandem/goals.json`) against `C:\Users\huizh` (the
user's home directory) instead of the real project cwd Tandem passes to the subprocess (e.g.
`C:\Users\huizh\tmp_test_data\tandem_hyperframe_video\...`). All four observed instances are
READ-only permission denials (Claude Code CLI's own sandbox correctly blocks the out-of-project
access) — never a write, so nothing destructive happened — but it wastes real attempts and, per
D66-2 below, real cost when it happens to coincide with other retry-triggering failures. One
instance included a revealing detail: the leader also tried writing an internal plan file to
`C:\Users\huizh\.claude\plans\...` and self-recovered gracefully when that was blocked ("no Write
tool is exposed in this session — the plan is delivered inline as a BuildPlan instead") — that
one is likely harmless Claude Code CLI internal plan-persistence habit, not the same bug; don't
spend effort on it.

This looks like a Claude Code CLI internal project-root heuristic falling back to `$HOME` for some
path resolutions when the actual scratch/project directory lacks markers the CLI recognizes (no
`.git`, no obvious repo structure) — not something Tandem's source can directly control, since
it's inside the CLI's own closed behavior. The lever Tandem does have: make the absolute project
directory unmistakable and repeated in the prompt, and instruct the model to never construct a
bare/relative file reference.

Add a new shared rule in `src/agents/leader.ts` (same pattern as the existing rules), threaded
into all three Claude-Code-CLI-backed prompt builders
(`src/agents/claude-code-cli/leader.ts`/`worker.ts` — check whether this needs to be
engine-specific since it's about a claude-code-cli quirk specifically, or whether it's safe/
useful to include generically; your call, but at minimum wire it into the claude-code-cli leader
prompts):
```
Always use fully-qualified absolute paths for every file read or write - never a bare relative
reference like "scripts/foo.js" or ".tandem/goals.json". The project's absolute root is stated
above; prefix every file path with it exactly, every time, even for files you've already
referenced earlier in the same turn.
```
Also check whether the project root path is stated clearly and prominently enough already in the
claude-code-cli prompt builders (`buildClaudeLeaderPlanPrompts` etc. in
`src/agents/claude-code-cli/leader.ts`) — if the absolute cwd isn't explicitly spelled out in the
prompt text itself (as opposed to only being passed as the subprocess `cwd` option), add it
explicitly so the model has something concrete to prefix with.

## D66-2: blind retries waste real cost/time on unrecoverable errors (rate limits)

Real evidence: a single `claude-code/cli` planning attempt cost **$1.17** (36 turns, 20535 output
tokens) before hitting a permission denial and being retried; the next attempt immediately hit a
`429` rate limit ("You've hit your limit · resets 11:50pm (America/New_York)"). D64's retry
envelope (`retryArtifact` in `src/orchestrator/machine.ts`, reused for plan/build/review) retries
3 times regardless of whether the failure is worth retrying. A rate limit will not clear by
retrying immediately — every attempt after the first 429 is guaranteed to fail identically until
the reset time, so 2 more attempts are pure waste (in this case, the second and third attempts
after the first 429 added no value).

`retryArtifact` already has precedent for this exact pattern — it special-cases `AbortError` and
re-throws immediately without retrying:
```ts
if (error instanceof Error && error.name === "AbortError") throw error;
```
Extend the same idea for rate limits:
- In `src/agents/claude-code-cli/exec.ts`, in `runClaudeExec`'s `exitCode !== 0` error path
  (~line 145), parse `result.stdout` as JSON (already attempted there for permission denials) and
  check for the rate-limit shape (`api_error_status === 429`, or the `result` field containing
  "hit your limit" - use whichever signal is more reliable, check the real envelope shape). If
  detected, throw a dedicated `RateLimitError` (new exported error class, extend `Error`, set
  `.name = "RateLimitError"`) carrying the reset-time string from the envelope (e.g. a
  `.resetsAt` property) instead of the generic `Error`.
- In `retryArtifact` (machine.ts), add the same early-exit as the existing `AbortError` check:
  `if (error instanceof Error && (error.name === "AbortError" || error.name === "RateLimitError")) throw error;`
  so a rate limit fails fast on attempt 1, not after 3.
- Make the terminal message when this happens clearly surface the reset time (e.g. "Leader
  planning is rate-limited: <resetsAt>. Try again after that time or switch engines.") rather
  than the generic retries-exhausted message, so the user immediately knows it's not a bug and
  when to retry.

Keep this scoped to Claude Code CLI's rate-limit shape for now (that's what's observed) - if
Codex CLI or the AI-SDK path have an analogous rate-limit signal worth handling the same way, note
it in the completion report as a possible follow-up rather than building it speculatively this
round.

## Acceptance
tsc + `npm test` green for both. D66-1: presence test for the new rule text (same style as prior
rounds), no live-behavior requirement (same "can't mechanically verify a model follows a prompt"
limitation as D60/D61 - though if a cheap live check happens to confirm it, include the evidence).
D66-2: unit test simulating a 429-shaped `runClaudeExec` failure and confirming `retryArtifact`
does NOT retry (single attempt, immediate throw with the reset-time message) - this one IS
mechanically testable, don't skip it. Commit `D66-<n>:`, create `D66_done.txt`.
