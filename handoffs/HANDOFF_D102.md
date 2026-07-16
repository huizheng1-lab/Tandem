# Handoff D102 (default `maxStepsPerAgentTurn` is too low for real projects)

Found by analyzing the user's real "Age of Empire test build" session log
(`C:\Users\huizh\.tandem\sessions\c6202ddbf499\3edefa00-6402-4d07-aaac-5ae1f8ac89b2.jsonl`)
after the user reported "the worker often cannot complete the build plan in this project."

## D102-1: raise the shipped default from 60 to 150

Quantified, not a guess. Of the session's 12 user turns, 5 produced a real BuildPlan
(implementation work); 4 of those 5 hit at least one "Worker finished without
submit_completion_report" failure, and 3 of those 4 escalated all the way to leader
takeover — an 80% first-attempt failure rate on real implementation turns.

I counted actual worker-only tool calls (`tool` events with `phase:"end"`) inside each
failing turn's time window:

| Turn | Worker tool calls used | Configured `maxStepsPerAgentTurn` |
|---|---|---|
| Initial game build | 79 | 60 |
| Launcher backend+frontend | 125 | 60 |
| Quit button / visuals | 236 | 60 |
| Mouse control fix | 74 | 60 |

Every failure exceeded the budget, several by a large margin. This is not the worker
"forgetting" to call the completion tool — it is running out of step budget mid-task on
real, multi-file work before it has the chance. It also explains why D98-5's
nudge-before-restart mechanism (`runAgentArtifact` in `src/agents/runner.ts`) often can't
even fire: that nudge needs `remainingSteps > 0`, and if the budget is already exhausted
when the worker "finishes" without calling `submit_completion_report`, there's nothing
left to nudge with.

`maxStepsPerAgentTurn` is defined at `src/config/schema.ts` — `ConfigSchema` field (line
~72, `z.number().int().positive()`) and `defaultConfig` value (line ~102, currently `60`).
It gates every `maxSteps` passed into a live agent call in `src/agents/live.ts` (lines
~464, 553, 594, 680, 754, 843, 917) and `src/session/compaction.ts` (line ~151).

**Fix**: raise `defaultConfig.maxStepsPerAgentTurn` from `60` to `150`. This covers 3 of
the 4 observed real failures outright and gets much closer on the fourth (236) — pick 150
specifically unless you find a concrete reason (e.g. real per-step token/cost math) to land
somewhere else; don't just copy 236, since that was this project's worst case, not a
typical one. Leave the schema's `.positive()` constraint as-is — no floor/ceiling needed,
this is a plain default bump, not a validation change. No user-facing config migration is
needed since existing configs that already hand-set a value are unaffected; only fresh
configs (or config keys never set) pick up the new default.

## D102-2 (optional, only if it falls out naturally — do not force this)

Consider whether the artifact-producing call in `src/agents/live.ts` could reserve a small
tail of its step budget to nudge the model to wrap up (call `submit_completion_report`
honestly, even with `status: "blocked"`) once it's close to running out, rather than
silently hitting the hard cutoff with zero steps left for D98-5's existing nudge to use.
Skip this entirely if it requires nontrivial new plumbing — D102-1 alone is the real fix;
this is a stretch goal, not a requirement.

## Acceptance

tsc + `npm test` green. A regression confirming `defaultConfig.maxStepsPerAgentTurn` is
`150` (or whatever value you land on with documented reasoning) is sufficient for D102-1 —
no live model call is required for a plain numeric-default change. If D102-2 is attempted,
it needs its own regression plus a note on why it was safe to skip if not attempted.
Commit `D102-<n>:`, create `handoffs/D102_done.txt`.
