# Handoff D83 (URGENT, investigation-first: new "reading 'trim' of undefined" crash in review)

Actively blocking the user's real task tonight, same project as D79/D80/D82. D82's fix HELD —
the original null-byte crash did NOT recur — but this retry hit a DIFFERENT crash in the same
review-verdict step:
```
leader review could not produce a valid ReviewVerdict: TypeError: Cannot read properties of undefined (reading 'trim')
```
Real, live-reproduced tonight. Genuinely good news buried in this: the task made substantial
real progress this attempt — both MP4s actually rendered correctly (324.97s, h264/aac, correct
dimensions, `verify-video.js` passed exit 0 for both languages), and only 2 minor quality issues
remained (English narration pace 124.63 WPM vs. 130-170 target; one subtitle line-clip at a
single cue). The crash is purely in Tandem's own review-processing, not a sign the underlying
task is broken.

## What's known (don't re-derive)

Session: `912fa9dc-7d6b-4cb9-9828-1bb817dc4181`,
`C:\Users\huizh\.tandem\sessions\48cc7d6d326e\`. The crashing error is at line 63854; the
CompletionReport artifact that triggered it is at line 63838 (use offset reads on this file —
it's several MB, don't load it whole).

**No stack trace is captured** — Tandem's error logging only stores `error.message` as a flat
string (`src/orchestrator/machine.ts`'s error-wrapping), so this is `String(error)`-only, no
`.stack`. That's a real, separate gap worth fixing (see D83-3) but don't let it block finding the
actual crash site this round.

**Ruled out already** (checked directly, don't re-check): the CompletionReport itself validates
cleanly against `CompletionReportSchema` — `status: "blocked"`, `summary` is a populated string,
`taskResults[].notes` populated, `verificationResults[].output` populated strings (both entries),
`deviationsFromPlan` is a populated string array. None of the schema's own fields are `undefined`
in this report. Grepped every `.trim()` call site in the claude-code-cli review chain
(`buildClaudeLeaderReviewPrompts`, `claudeLeaderExec`, `runClaudeExec`, `parseClaudeEnvelope`,
`detectRateLimit`) — all either guarded with `typeof x === "string"` / optional chaining, or
operate on values structurally guaranteed to be strings (regex match groups, template literals).
None of them look capable of throwing this specific error as written. This means either: the
crash is in a call site not yet checked (zod validation internals, execa, a dependency), or it's
triggered by some interaction between fields not obvious from static reading alone.

**Note this is the SECOND time this exact review round hit a crash** (first: D79's null-byte bug,
now: this). Both happened specifically when the report's `status` was NOT a clean
`"complete"`/simple case — the D79 incident involved multi-stream partial failures, this one is
`status: "blocked"` with real `deviationsFromPlan` content. Worth considering whether there's a
pattern in how "blocked" or deviation-heavy reports get special-cased somewhere in the review
prompt construction or feedback formatting that the "complete, no deviations" happy path doesn't
exercise — that's a plausible lead, not a confirmed one.

## What to do

D83-1: Reproduce this LIVE using the real report data from session line 63838 (extract it, feed
it through the real `buildClaudeLeaderReviewPrompts`/`claudeLeaderReview` call chain directly, or
add temporary instrumentation to capture a real stack trace) rather than guessing at a fix
blind. Get the actual stack trace — that's the fastest path to the real answer here, and this
project's own history (the D41-D47 saga) shows guessing at root causes without live reproduction
repeatedly wastes rounds.

D83-2: Once found, fix it — almost certainly a missing `?.` or a missing null/undefined guard
before a `.trim()` call, but confirm via the real stack trace rather than assuming.

D83-3 (secondary, worth doing while you're in this code): `machine.ts`'s error wrapping only
captures `error.message` as a string, discarding the real stack trace entirely. This makes any
future crash in this class much harder to diagnose than it needs to be — consider whether the
session log should also capture `error.stack` (even truncated) for `error`-type events, so a
future incident doesn't require this same live-reproduction effort just to find the crash site.
Don't over-build this — a simple additional field on the existing error event shape is enough,
not a new logging subsystem.

## Acceptance
tsc + `npm test` green. A real regression test reproducing the exact crash (use the real report
shape from session line 63838, or a minimal report with the same "missing" characteristics once
you've identified them) that currently throws, confirming it no longer does after the fix. Live
verification: after the fix, re-run the review step against the actual real report data from this
incident (or as close a reproduction as practical) and confirm a valid `ReviewVerdict` comes back
instead of a crash. Commit `D83-<n>:`, create `D83_done.txt`.
