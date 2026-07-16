# Handoff D55 (verification allowlist falsely rejects real external tools like ffprobe/ffmpeg)

## Bug (confirmed, reproducible)
A real video job's BuildPlan was rejected at planning with:
`verification entry "ffprobe -v error -print_format json -show_format "...tandem-explainer-en.mp4"" does not look like a runnable shell command; move manual checks to acceptanceCriteria...`
(four such entries, all ffprobe).

Root cause traced end to end in `src/orchestrator/artifacts.ts`:
- `validateVerificationEntry` (line ~138) calls `hasCommandShape(normalized)` (line ~128).
- `hasCommandShape` returns true ONLY if the first token is in the hardcoded
  `runnableCommandStarters` set (line ~19), OR the command starts with a path
  (`./`, `C:\`, `/`, `~/`), OR starts with a `*.cmd/.bat/.ps1/.mjs/.js/.ts/.py/.sh/.exe` filename.
- `ffprobe`/`ffmpeg` are not in the set and don't match the path/extension regexes, so
  `hasCommandShape` returns false → the entry is rejected.
- Confirmed the OTHER clause (`wordCount > 6 && !hasPathFlagOrShellChars`) is NOT the cause:
  these commands contain flags/colons/quoted paths, so `hasPathFlagOrShellChars` is true. The
  sole cause is the missing allowlist entry.

The commands are valid, runnable ffprobe invocations. This blocks any media/video job (checking
an output MP4's codec/dimensions/streams is exactly ffprobe's job; there is no npm/node
substitute a plan could use instead).

## D55-1 (minimal, do this): extend the allowlist
Add the common media/binary tools to `runnableCommandStarters`: at least `ffprobe`, `ffmpeg`.
While there, add other real tools a coding/media agent legitimately shells out to and that carry
the same low false-"prose" risk: `ffplay`, `magick`, `convert` (ImageMagick), `sox`, `pandoc`,
`curl`, `wget`, `docker`, `docker-compose`, `dotnet` (already present — keep), `java`, `ruby`,
`php`, `dir`, `where`, `certutil`. Keep the set alphabetized/grouped and add a one-line comment
that this is an allowlist of known-real command starters (not exhaustive).

## D55-2 (the real fix — decide and implement): stop rejecting real commands just because the
## starter isn't on a list
The allowlist's PURPOSE is to reject model-emitted prose masquerading as a verification command
(e.g. "verify the video plays correctly and has audio"), NOT to reject unfamiliar-but-real
binaries. An allowlist of starters is structurally the wrong tool for that — it will keep
false-rejecting real tools forever (every new job type needs a code change). Replace the
"first token must be on the allowlist" gate with a shape-based test that accepts anything that
looks like a command invocation and rejects prose:
- ACCEPT if the first token is a bare executable-looking name: matches `^[A-Za-z][\w.-]*$` (a
  single word, no spaces, letters/digits/dot/dash/underscore) AND the entry as a whole has
  command shape — i.e. the first token is followed by flags (`-x`/`--x`), quoted args, paths,
  subcommands, or operators — rather than a natural-language sentence.
- Keep the existing path-prefix and script-filename ACCEPT branches.
- Keep REJECTING prose: the existing `wordCount > 6 && !hasPathFlagOrShellChars` heuristic already
  catches "verify that the output looks correct and has both audio tracks" (many words, no
  flags/paths/operators). Ensure that clause still fires for genuine prose after this change, and
  that a real multi-flag command (many words, but with flags/paths) still passes.
- Preserve the `runnableCommandStarters` set as a FAST-PATH allow (known starters skip the
  heuristic entirely), but no longer treat absence-from-the-set as a rejection on its own.
- The Windows POSIX-tool guard (cat/grep/ls/... → windowsPosixAlternatives) must stay exactly as
  is — that's a separate, correct check and must keep rejecting POSIX-only tools on win32.

If on inspection you judge D55-2's heuristic too risky to get right without over-accepting prose,
implement D55-1 only and say so in the completion report with your reasoning — D55-1 alone
unblocks the immediate video job. But make the call explicitly; don't silently skip D55-2.

## Acceptance
tsc + `npm test` green. Add unit tests to the existing artifacts/verification test file:
- The four real ffprobe commands from the bug report now VALIDATE (pass).
- A real `ffmpeg -i in.mp4 -vf scale=1280:720 out.mp4` validates.
- Genuine prose ("verify the video plays correctly with both audio tracks") is still REJECTED.
- A POSIX-only tool on win32 (`grep -r foo .`) is still REJECTED with the POSIX-alternative
  message (regression guard for the untouched Windows check).
- If D55-2 is implemented: an arbitrary real-looking binary not on any list (e.g.
  `somebinary --check --input path\to\file`) validates, while a bare prose sentence does not.
Live check (reviewer will re-run): re-submit a plan whose verification uses ffprobe and confirm
it passes planning validation (no "does not look like a runnable shell command" error). Commit
`D55-<n>:`, create `D55_done.txt`.
