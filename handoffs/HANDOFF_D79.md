# Handoff D79 (real crash: null bytes in captured tool output corrupt the review call)

Real, reproducible bug found while diagnosing a live user-reported stall. Root-caused fully from
a real session log before writing this — session id `12e6d163-9766-435c-a95a-8354d5d32729`,
`C:\Users\huizh\.tandem\sessions\48cc7d6d326e\`, if you want to inspect it directly (large file,
use `grep`/offset reads, not a full read).

## What happened (confirmed from the real log)

User asked to fix machine-like voices in a video project. Leader planned fine. Worker began real
implementation (ran real `edge_tts` Python audio-streaming tests, wrote test scripts — all
`ok:true`), but ran out of allotted steps (`maxStepsPerAgentTurn: 60`) before creating the three
required scripts or regenerating any files. So far unremarkable — a normal "worker needs another
round" case.

But the review call that should have processed that incomplete report instead **crashed 3 times
identically**:
```
TypeError: Arguments cannot contain null bytes ("\0"): Review round 1.\nBuildPlan:\n...
```
This is a Node.js core restriction — you cannot pass a string containing a literal NUL byte as a
subprocess argument. `retryArtifact` burned all 3 attempts on this (pointless — it's a
deterministic data-corruption error, not transient, so retrying can never succeed), then the
machine correctly went to a clean DONE-terminal state (`leader review failed; build report
preserved`, `takeover: false` — correct design, don't attempt takeover with a broken review
mechanism). Net result: $0.547 of real leader spend (492K input / 15K output tokens), zero
usable deliverables.

## Root cause (found, not guessed)

`src/tools/shell.ts`'s `bashTool()` captures `result.all` (execa's combined stdout+stderr) and
embeds it RAW into the tool's `output` field with zero sanitization:
```ts
output: tailOutput(`${abortNote}${timeoutNote}${result.all ?? ""}${cleanupNote}`)
```
(`tailOutput()` only truncates by length — `src/tools/shell.ts:19-22` — it does not sanitize
content.) The worker's task involved raw audio-streaming (`edge_tts.Communicate(...).stream()`)
via Python subprocess calls — the most likely source of a literal null byte is binary
audio-chunk data getting printed to stdout by one of the worker's own test scripts and captured
verbatim. That raw text then flows into the `CompletionReport`, which flows into the review
prompt, which corrupts the downstream `execa(claudePath, args, ...)` call in
`claude-code-cli/exec.ts` when Node tries to pass it as a CLI argument.

## What to do

D79-1 (primary fix): Sanitize captured shell/tool output to strip null bytes (and other control
characters unsafe for use as CLI subprocess arguments — check what Node's actual restriction
covers, don't just handle `\0` if the same class of bug could recur for other control chars) at
the point of capture in `src/tools/shell.ts` — either inside `tailOutput()` itself (rename/
extend if that changes its semantics too much) or as a new sanitization step applied before
`tailOutput()`. Apply to BOTH the success path (line ~144) and the error/timeout path (line
~154) — both interpolate raw content the same way.

D79-2: Check whether other tool-output capture points have the same gap — specifically
`read_file`/file-content-embedding tool results (if a worker reads a binary file and its content
gets embedded into a report/prompt the same way) and worker-report `notes`/`output` fields more
generally. Don't assume `shell.ts` is the only path; trace whether this specific session's null
byte actually came from there or confirm via the real log/reproduction, and fix wherever the
actual gap is (this handoff's theory is well-grounded but not 100% certain — verify before
committing to just the one fix).

D79-3 (secondary, defense-in-depth): Extend `retryArtifact`'s existing fast-fail pattern
(`src/orchestrator/machine.ts:83`, currently `error.name === "AbortError" || error.name ===
"RateLimitError"`) to also skip-retry when the underlying error is this exact class of
deterministic Node-level argument-validation failure (verify the real error's `.code`/`.name`
live — Node typically sets a `code` like `ERR_INVALID_ARG_VALUE` for this, don't guess the
property name) — so a future occurrence (from any source D79-1/D79-2 didn't fully close) fails
fast on attempt 1 instead of wasting 3 attempts and burning real leader tokens on a call that can
never succeed. This is a genuine complement to D79-1, not a replacement for actually fixing the
sanitization gap.

## Explicitly out of scope this round
The worker's `maxStepsPerAgentTurn: 60` possibly being too tight for multi-script tasks like this
one is a separate, secondary observation from the same incident — do not address it in this
round; flag it in the completion report as a possible follow-up only if it seems clearly
relevant, but the primary bug here is the null-byte crash, not step-budget tuning.

## Acceptance
tsc + `npm test` green. A real regression test reproducing the exact failure shape: mock/produce
a tool output containing a literal null byte, confirm it's sanitized before being embedded in a
report/prompt (D79-1/D79-2), and confirm `retryArtifact` fast-fails on the specific error class
if D79-3 is implemented. If feasible, a cheap live check re-running something close to the
original failing scenario (a bash command that legitimately prints a null byte, e.g. `printf
'a\0b'` or a Python one-liner) through the real worker/review pipeline is strong evidence but
optional if a clean unit-level reproduction covers it. Commit `D79-<n>:`, create `D79_done.txt`.
