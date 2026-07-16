# Handoff D82 (URGENT: the D79 null-byte crash still happens via the diff-snapshot path)

Not a batched item — this is actively blocking the user's real live task right now (same
project as D79/D80's original incident). Live-reproduced twice in a row tonight: the D79 fix
(landed, confirmed present in the running build via asar timestamp) stopped the ORIGINAL crash
source, but the user retried the same task and hit the IDENTICAL crash again from a DIFFERENT,
previously-unaudited source.

## Root cause (confirmed via code read, live-reproduced, not guessed)

This project (`tandem_hyperframe_video`) is not a git repository (`git rev-parse
--is-inside-work-tree` fails). Tandem's diff mechanism falls back to the snapshot-based path:
`DiffTracker` in `src/orchestrator/diff.ts`. `readSnapshotFile()` (line ~121-134) does:
```ts
return await readFile(fullPath, "utf8");
```
on every changed/touched file, with a byte-size cap but NO binary-content check. This build
created `audio/voice.en.wav` and `audio/voice.zh-CN.wav` (real binary WAV audio, synthesized via
edge_tts). Node's `readFile(path, "utf8")` does **not** throw on binary content — a literal NUL
byte (0x00) is technically valid UTF-8, so it decodes silently into a JS string containing raw
null bytes and other binary garbage. That string flows into `createTwoFilesPatch()`, into the
final diff text, into the review prompt, and crashes identically to the original D79 incident:
```
TypeError: Arguments cannot contain null bytes ("\0")
```
This is a SEPARATE code path from what D79 fixed (D79 sanitized `bashTool()` output,
`read_file`/`list_dir` tool results, and the parsed `BuildPlan`/`CompletionReport` artifacts —
none of those cover the diff-snapshot mechanism, which builds its own text independently and was
never audited).

**A second, related latent instance exists in the git-backed path too** (not what triggered
tonight, since this project has no `.git`, but the same bug class): `gitDiff()`'s untracked-file
handling (`src/orchestrator/diff.ts` line ~26) does the same `readFile(fullPath, "utf8")` for
untracked files, with only a try/catch that falls back to "(binary or unreadable)" — which only
fires if `readFile` THROWS, and it won't for most binary content, so this has the identical
silent-garbage-through risk for git-backed projects with untracked binary files.

## What to do

D82-1: Fix `DiffTracker.readSnapshotFile()` in `src/orchestrator/diff.ts` — detect binary
content before treating a file as diffable text. Check for a real, reliable binary-detection
approach (e.g. check for a NUL byte in the raw buffer before UTF-8 decoding, or read as a
`Buffer` first and inspect it — don't just re-sanitize AFTER decoding, since UTF-8 decoding of
arbitrary binary can also produce other corrupted/invalid-looking text even without a literal
NUL). When a file is detected as binary, store a clear placeholder value instead (e.g. `[binary
file, N bytes]`) rather than attempting a text diff on it — this is also a more useful diff
output than garbled text would be. Apply the same fix to `gitDiff()`'s untracked-file reading
(the same file, ~line 26) for consistency — both paths have the identical risk.

D82-2: As defense-in-depth (belt-and-suspenders, matching this project's now-established pattern
from D79 of sanitizing at multiple layers): also run the final assembled diff string through
`sanitizePromptText` (from `src/tools/sanitize.ts`, already built in D79) right before it's
returned from `workingTreeDiff()`/`DiffTracker.diff()`/`gitDiff()`. This doesn't replace D82-1's
proper binary detection (a sanitized-but-still-garbled binary diff is still useless output) but
ensures that ANY future unaudited path feeding into the review/build prompts can't reintroduce
this exact crash class again — the same reasoning that led to sanitizing multiple layers in D79.

D82-3: Audit whether any OTHER prompt-construction inputs bypass D79's sanitization the same way
diff.ts did — specifically check `projectInstructions`/`readProjectInstructions` (reads
TANDEM.md/CLAUDE.md, could theoretically be binary if misnamed) and anything else that does a
raw `readFile(..., "utf8")` on user/project-controlled file paths without going through the tool
layer D79 already covered. Don't fix speculatively — just report what you find; only fix
confirmed real gaps in this round, flag anything uncertain for a future round.

## Acceptance
tsc + `npm test` green. Regression test: create a real binary file (e.g. write a `Buffer`
containing null bytes to a temp file) inside a `DiffTracker`-tracked directory, touch it, and
confirm the resulting diff text contains NO raw null bytes (either the binary-placeholder from
D82-1, or at minimum sanitized text from D82-2 — but D82-1's proper detection is the real fix,
D82-2 is the safety net, don't ship D82-2 alone as if it were sufficient). Live verification
required given this is blocking the user's real project right now: after the fix, re-run
something close to the actual failing scenario — a build that creates/touches a real WAV/binary
file in a non-git project directory, then triggers a review — and confirm the review call no
longer crashes. If feasible, use the user's actual project state (ask first / coordinate timing
if a live Tandem session might be active) or a clean reproduction with a synthesized binary file
in a temp non-git directory — either is acceptable evidence. Commit `D82-<n>:`, create
`D82_done.txt`.
