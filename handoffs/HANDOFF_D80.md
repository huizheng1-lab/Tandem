# Handoff D80 (second symptom of D79's root cause: raw binary leaks into the chat transcript)

Sequenced alongside/after D79 (`HANDOFF_D79.md`, already submitted separately — do not duplicate
its fix, this handoff assumes D79's sanitization work is either already landed or landing in
parallel; coordinate/dedupe if both are picked up close together).

## What the user observed

Raw binary output visibly appearing in the desktop chat transcript during the same live session
that led to D79 (session id `12e6d163-9766-435c-a95a-8354d5d32729`,
`C:\Users\huizh\.tandem\sessions\48cc7d6d326e\`).

## Root cause (confirmed via code read, not guessed)

This is NOT the tool-activity line. `ToolActivityEvent` (`src/tools/fs.ts`) only carries
`role/tool/target/phase/ok/ms` — no output field. `formatToolLine()` in
`app/renderer/src/main.tsx` only ever renders `target` (the command being run), never its result.
That path is confirmed clean.

The actual path: `bashTool()` in `src/tools/shell.ts` returns the RAW, unsanitized
`result.all` (execa's combined stdout+stderr) as the tool's `output` field
(`src/tools/shell.ts:144` success path, `:154` error path — see D79 for the full detail on this
capture point). That raw `output` is returned to the WORKER MODEL as its tool result. The model
then quotes/echoes some of that raw content back in its own generated natural-language response
(e.g. narrating what a test printed) — and `onWorkerText` correctly and faithfully streams
whatever the model actually generates into the chat bubble. The display code is doing its job
correctly; the bug is entirely upstream — the model should never have had raw binary/null-byte
content available in its context to quote from in the first place.

**This shares the exact same root cause and fix location as D79** (same file, same capture
point). If D79's sanitization fix (stripping null bytes/unsafe control characters from
`bashTool()`'s captured output at the point of capture) has already landed by the time this round
is picked up, this handoff's acceptance criteria should already be satisfied — verify that
directly rather than re-implementing anything, and if confirmed, this round can close as
"already fixed by D79, verified live" with no additional code changes.

## What to do

D80-1: Check whether D79 has landed. If yes: verify its fix actually also resolves this symptom
by reproducing the ORIGINAL failure shape (a worker tool call whose output contains a literal
null byte or other binary content) and confirming the WORKER MODEL never receives that raw
content in its tool-result context anymore — not just that the downstream review-prompt crash is
fixed, but that the sanitized output is what actually reaches the model. If D79 hasn't landed
yet, implement the identical fix (sanitize `bashTool()`'s captured `output` at the point of
capture in `src/tools/shell.ts`, both the success and error paths) — do not implement a second,
divergent sanitization approach; use the same one D79 specifies.

D80-2: Add a test specifically asserting `bashTool()`'s returned `output` value itself is
sanitized (not just that a downstream prompt-construction step happens to strip it later) — this
is the layer that actually prevents the model from ever seeing raw binary content, which is what
stops both the crash AND the chat-leak symptom at the source.

## Acceptance
tsc + `npm test` green. Live verification: reproduce a worker tool call whose raw output would
contain a null byte (e.g. a bash command like `printf 'a\0b'` or a Python one-liner emitting
binary data) through the real `bashTool()` function directly, confirm the returned `output` is
now sanitized (no raw null bytes / control characters unsafe for CLI args or for display).
Commit `D80-<n>:` only if new code changes were needed beyond what D79 already shipped; if this
round confirms D79 already fully covers it, a `D80_done.txt` explaining that (with the live
verification evidence) is a complete, valid outcome — no need to force a separate commit.
