# Handoff D152 (dashboard: surface a clear note exactly when a new build is ready for human preview/review, and only then)

This is dashboard-only work (`C:\Users\huizh\Apps\Tandem Reciprocal\dashboard`, outside this repo, same as the D151
dashboard updates) - not reciprocal wishlist work, not gated by the relay protocol.

## What the human is reviewing (human-specified, don't re-derive or water down)

The human reviews the **real functional change** - what the feature actually does when
you click around a running build - never the programming/edit changes. Code
correctness is already fully automated (typecheck, tests, build, diff-check, and the
leader-only review inside Executor A's own turn) and requires no human verification at
all. The entire point of this note and the preview flow it points at is to let a human
verify *behavior*, not read a diff. This shapes two concrete things below: the note's
summary text must describe what changed in user-observable terms (e.g. "session search
now has a UI search box in the sidebar"), never in code terms (e.g. "added typed IPC
channels"), and the note must never show or link to a diff/code view as if that were
the reviewable artifact - it should point straight at the Launch Candidate preview
build.

## The gap (confirmed, don't re-derive)

Today the only signal that a new build might be worth looking at is a small status chip
(`public/app.js:198-210`, `#update-state` element) that reads "Update available" with a
`warn` CSS class when `update.pending` is true. Two real problems:

1. **It's easy to miss.** It's a passive label inside a panel, not something that draws
   attention. There is no proactive notification anywhere in the UI.
2. **It's not tied to the actual review moment.** `update.pending`
   (`server.mjs:getCandidateUpdate`, around line 272-317) only compares whatever
   `BUILD_INFO.json` sourceSha happens to be sitting in the admin repo's own
   `release/win-unpacked` folder against what's currently promoted to executor A/B
   runtimes. That folder is populated manually (`npm run dist:app`), with no automatic
   connection to the relay's actual `a-upgrade-pending` phase or its `stableCommit` -
   the chip can be stale, empty, or pointing at an old ad-hoc build that has nothing to
   do with the currently-accepted candidate.
3. **It never remembers what you've already looked at.** `recordUpdateReview`
   (`server.mjs:591-606`) already logs every review decision (approve/reject, sourceSha,
   comment, timestamp) to a markdown file and via `audit("update.review", ...)`, but
   nothing reads that log back to suppress the chip/note for a SHA already reviewed -
   so today there's no way to tell "new, unreviewed" apart from "already looked at this
   one."

## What to build

A clear, hard-to-miss note that appears **exactly when** there is a build ready for
human preview that has **not yet been reviewed**, and disappears once it has been.

1. **Tie freshness to the relay's real state, not just whatever's in `release/`.** When
   the relay reaches `phase=a-upgrade-pending` (a mechanically-verified `stableCommit`
   is waiting for the human A-runtime-upgrade confirmation - see `reciprocal-relay.ps1`'s
   `PassiveTest`/`PrepareAUpgrade` actions from D151), that `stableCommit` is the
   authoritative "there's something new to review" signal. Decide whether to (a)
   automatically kick off a preview build (`npm run dist:app` into `release/win-unpacked`,
   or a dedicated preview output dir) the moment `a-upgrade-pending` is reached so the
   note always corresponds to something actually launchable, or (b) just detect that no
   matching preview build exists yet and tell the human to build one before offering
   Launch Candidate. Prefer (a) if it's not disruptive to build in the background; fall
   back to (b) with a clear call-to-action if a background build is judged too heavy or
   collision-prone with a running promotion.
2. **Track "already reviewed" per SHA.** Read `recordUpdateReview`'s existing log (or
   add a small structured index alongside it, e.g. a JSON file mapping `sourceSha ->
   {decision, at}`) so the note only fires for a `stableCommit`/candidate SHA that has
   no recorded review decision yet. A SHA that was already approved, rejected, or
   otherwise explicitly dismissed must not re-trigger the note.
3. **Make the note itself impossible to miss** without being obnoxious: a persistent
   banner or badge on the main dashboard view (not buried in a sub-panel), naming the
   short SHA and a one-line summary phrased as **what a user can now do or see** -
   not a technical changelog line. Do not reuse `relay.lastSummary` or the raw commit
   subject verbatim (both are written in implementation/protocol terms, e.g. "Passive
   copy built and verified candidate..." or "typed streaming session-search IPC,
   orchestration, and preload wiring" - exactly the kind of programming-change language
   this note must avoid). The wishlist item's own human-authored evidence/objective
   text (from `SHARED_DIRECTION.md`) is a better source since it originates from the
   human-written feature description, but still needs reducing to one plain,
   user-facing sentence about the visible/functional result - if the underlying step
   is backend-only plumbing with nothing user-visible yet (as in W0014 steps 1-2), the
   note should say so plainly (e.g. "backend work only - nothing new to see yet") rather
   than implying there's a UI change to check. Pair the note with a direct action to
   build/launch the preview (reuse the existing `Launch candidate` mechanism at
   `/api/update/launch-candidate`, `server.mjs:996-1013`) and a way to record a decision
   (reuse or extend the existing `update.review` approve/reject flow at
   `server.mjs:591-606` and whatever calls it in `app.js`).
4. **The note must clear itself** once a decision is recorded for that SHA, and must
   not reappear for the same SHA even after a page reload/dashboard restart (must be
   backed by durable state, not just in-memory).

## Constraints

- Do not weaken or bypass the human A-upgrade gate (`CompleteAUpgrade` still requires
  `-Force` and a human-written summary) - this note is about visibility, not about
  making the gate automatic or skippable.
- Do not touch `reciprocal-relay.ps1`'s state machine itself - only read its state
  (`a-upgrade-pending`, `stableCommit`, `lastSummary`) as a trigger signal.
- Do not build a general notification framework - scope this narrowly to the one
  real case described here (new build ready for review).

## Acceptance

Explain in `handoffs/D152_done.txt` how "new, unreviewed build" is detected and how the
per-SHA reviewed state is persisted. Live proof: trigger a real `a-upgrade-pending`
state (or use the currently-real one if still pending when this lands) and show the
note appearing; record a review decision for that SHA and show the note clearing; then
show that reloading the dashboard does not bring the note back for the same
already-reviewed SHA. tsc/build checks for anything touched in this repo (if any) green;
dashboard files are outside this repo so no `handoffs/D152_done.txt` full-suite
requirement applies to them, but do not break the existing dashboard `npm test` if the
dashboard has its own test suite - check for one before assuming there isn't. Commit
`D152-<n>:` for any changes inside this repo (likely none, or only doc references);
create `handoffs/D152_done.txt` regardless describing the dashboard-side change since
it lives outside git.
