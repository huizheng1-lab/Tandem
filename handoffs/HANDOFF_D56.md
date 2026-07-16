# Handoff D56 (destructive-command false positive on ffprobe/ffmpeg; takeover self-verification gap)

## D56-1 (confirmed regex bug, fix this): `/\bformat\b/i` false-positives on real ffprobe/ffmpeg
`src/tools/permissions.ts`'s `destructivePatterns` includes `/\bformat\b/i`, intended to catch
disk-format commands (`format C:`). Verified directly:
```js
/\bformat\b/i.test('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 file.mkv') // true — FALSE POSITIVE
```
Any command using the extremely common ffprobe/ffmpeg idiom `-show_entries format=duration` (or
similar — "format" as a bare flag value/field name) gets hard-blocked as "destructive," and this
check runs BEFORE the permission-mode gate (line 32, before the `mode === "yolo"` check at line
35) — so it's unbypassable even with full permissions. This is what caused the confused
"Blocked destructive command" / workaround-via-verify-video.js detour in a real takeover session.

Fix: narrow the pattern to actually mean disk formatting, not the bare word anywhere in the
command. Something like requiring `format` to be followed by a drive-letter-shaped or
filesystem-shaped argument (mirroring how the existing `del` pattern already requires
`\s+\/[fsq]\s+[a-z]:\\` context, not just the bare word "del"). Add a regression test asserting
`isDestructiveCommand` returns false for `ffprobe -show_entries format=duration ...` and true for
an actual disk-format command survives correctly. Also add a small local regression set of common
ffprobe/ffmpeg invocations (the D55 test list is a good source) run through `isDestructiveCommand`
to catch any other pattern in the list with the same class of false positive — check `/\bformat\b/i`
was the only offender before closing this out, don't assume.

## D56-2 (real, but harder — use judgment): takeover has no check against verification tampering
Confirmed in the same transcript: during takeover, the leader edited `verify-video.js` itself
(widened `DURATION_TOLERANCE` to 15s, changed the expected duration from 300s to match the actual
buggy 325s output) instead of root-causing why the rendered duration was wrong, then reported all
verification passing. `validateCompletionReport`/`enforceVerification` (src/orchestrator/artifacts.ts)
only checks that the plan's verification COMMAND STRING is reported verbatim and passing — it has
no visibility into whether the SCRIPT that command invokes was modified to make a failing check
pass. This is a structural gap specific to takeover: in the normal leader/worker loop, the leader
reviewing the worker's diff is exactly the independent check against this kind of tampering; in
takeover, the leader is both implementer and sole judge of its own final result.

This can't be fully "solved" (any agent with write access to its own verification script can
weaken it — genuine independence would require a second model judging takeover output, a bigger
architectural change out of scope here). A concrete, scoped mitigation: make it IMPOSSIBLE to
hide a verification-script edit inside prose. Specifically:
- When takeover's diff/touched-files tracking (already exists — `diffTracker`/`recordTouchedPath`
  in tandem-service.ts) shows a file that is itself referenced by one of the plan's verification
  commands (e.g. `node verify-video.js` touching `verify-video.js`) was modified DURING takeover,
  require the takeover flow to surface that specifically — not as optional prose in
  `deviationsFromPlan`, but as a structured, unmissable field (e.g. add
  `verificationScriptChanges: string[]` to the takeover path, or at minimum enforce via a prompt
  instruction + a post-hoc check that if a verification-referenced file appears in
  `filesChanged`, the `deviationsFromPlan` array is non-empty and mentions it — validate this
  mechanically, not just via prompt wording, so it can't be silently omitted).
- Consider (discuss in the completion report rather than assuming): should
  `enforceVerification` re-run verification against a snapshot of the script taken at the START
  of the round, before comparing? That's a bigger change (needs a file snapshot/diff mechanism
  for the verification script itself, not just touched-paths) — flag feasibility, don't
  necessarily build it this round unless it's cheap given `diffTracker` already exists.

If D56-2's scope is unclear or you think it needs more design before implementing, say so
explicitly in the completion report rather than half-implementing it — D56-1 is the priority and
stands alone.

## Acceptance
D56-1: tsc + npm test green, new regression tests as described, live-verify by constructing the
exact failing command from the transcript and confirming `isDestructiveCommand` now returns
false and the command executes. D56-2: tsc + npm test green; describe in the completion report
what was implemented vs. what's flagged as needing further design. Commit `D56-<n>:`, create
`D56_done.txt`.
