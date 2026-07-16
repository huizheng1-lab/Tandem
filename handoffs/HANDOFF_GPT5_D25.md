# Handoff to GPT-5 — Round D25 (CRITICAL: delete has no confirmation; worker NoOutputGenerated)

## D25-1 (CRITICAL): Session delete executes immediately — no confirmation dialog
Reviewer-proven live: clicking a row's Delete button deletes the session instantly. The D10-4
spec required a confirmation dialog ("deletion is permanent"); none appears. This caused real
data loss during review testing (a user session transcript was irreversibly deleted by a stray
click). Fix: Delete opens a real modal ("Delete session '<title>'? This permanently removes its
transcript. The project files are not affected.") with distinct button labels (Cancel /
"Yes, delete") so it can never be confused with row buttons. No delete without the modal
confirmation. Optional but recommended: soft-delete — move the .jsonl to
`<sessions dir>\trash\` for 7 days instead of rm, prune on startup; state your choice.

## D25-2: Diagnose and surface AI_NoOutputGeneratedError (user's active blocker)
User's runs fail with "CompletionReport failed ... AI_NoOutputGeneratedError: No output
generated. Check the stream for errors." — the worker (MiniMax) stream yields nothing, retries
exhaust, and takeover also failed in at least one session. Tasks:
- Surface the UNDERLYING cause: when the AI SDK throws NoOutputGenerated, capture and log the
  provider response detail (finish reason, HTTP status, error body if any) into the session log
  and the SYSTEM line — "No output generated" alone is undiagnosable.
- Add request-size accounting: log the approximate input token count per agent call (the
  runner already gets usage on success; on failure, log the assembled message sizes). Suspect:
  the worker build context (BuildPlan + ReviewFeedback + FULL previousReport JSON) grows huge
  on big projects; MiniMax may be rejecting over-limit input.
- Mitigate: cap the worker-context `previousReport` to a summary (status, per-task statuses,
  failed verifications, deviations — drop full outputs) and cap feedback text length; the full
  artifacts remain in the session log. Unit-test the context builder stays under a configured
  char budget.

## D25-3: Session action buttons are invisible on real displays (user screenshot-confirmed)
The Rename/Archive/Delete buttons style as `background:#17191e` on a `#1d2027` row with 11px
`#b9c0c9` text — effectively invisible at common DPI/scaling; the user reported "there is no
delete button" while the buttons were present in the DOM. Redesign for visibility: clearly
outlined or filled buttons with adequate contrast (border at least #4a5262, text #e6e9ee, or
use recognizable compact icon+label chips), visible without hover, in both active and archived
rows. While in there: give the Archive action visible feedback (row animates/announces moving
to the Archived section) since silent archiving reads as "nothing happened."

## Acceptance
tsc + `npm test` green; commits `D25-<n>:`. Reviewer will: click Delete and verify the modal
gates it (Cancel leaves the session intact); verify the action buttons are plainly visible in a
screenshot at 125% Windows scaling; trigger a NoOutput-style failure with a mocked generator
and verify the SYSTEM line carries the underlying detail; check the context-budget unit tests.
The user's failing solitaire/dogfight prompts are the live regression test for D25-2.
