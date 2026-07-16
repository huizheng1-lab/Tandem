# Handoff to GPT-5 — Round D20 (planner quality: prose verification + goal hijacking)

> STATUS: DEFERRED by user decision (2026-07-05). Round D20 was skipped; D21 shipped first.
> An empty `D20: deferred` commit exists in the log to keep round numbering contiguous.
> If picked up later, implement as specified below and commit as `D20-<n>:` normally.

Two recurring behaviors observed live during D19 acceptance (both Gemini-leader):

## D20-1: Plans still contain unrunnable prose verification
Observed plan verification entry: "Play game and verify all effects are working" — not a
command; the worker's CompletionReport was then rejected by enforcement for omitting it,
wasting a full round. The planner prompt instruction exists but is being ignored.
Fix mechanically, not just via prompt: validate `BuildPlan.verification` at submission —
reject entries that look like prose (heuristic: no shell-command shape, e.g. does not start
with a known runnable token (npm|npx|node|python|pytest|go|cargo|make|powershell|cmd|./|a
path) OR contains > 6 words with no path/flag characters). On validation failure, feed the
error back to the planner (existing retryArtifact path) telling it to move manual checks to
acceptanceCriteria. Unit-test accept/reject examples including the observed string.

## D20-2: Standing goals hijack unrelated prompts
A prompt explicitly asking to run one shell command was planned as a continuation of the
standing dogfight-game goal. Goals are context, not orders. Strengthen the planner prompt:
standing goals may inform planning ONLY when the user's request relates to them; for unrelated
requests, plan exactly what was asked. Add one line to the goals block header, e.g.
"Standing goals (context only — do not redirect unrelated requests toward these):".
No mechanical enforcement needed this round; prompt-only is acceptable here.

## Acceptance
tsc + `npm test` green; commits `D20-<n>:`. Reviewer will check the validation unit tests and
review the prompt diffs; live behavior will be observed over subsequent normal use rather than
a dedicated paid run.
