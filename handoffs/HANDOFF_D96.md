# Handoff D96 (false positive: verification-script-tampering check flags legitimate deliverables)

Found while re-running a full end-to-end check after D94/D95 landed (leader=worker=minimax/minimax-m3,
default `triage: auto`, a simple "compute stats from a CSV" task through the real desktop app).
The run substantively SUCCEEDED — verified the actual output was fully correct — but ended in a
degraded state ("takeover report validation failed; build preserved") rather than a clean
approval, purely because of a false positive in an unrelated safety check.

## What's confirmed (don't re-derive)

The task: create a script that computes mean/median/stddev from `data.csv` and writes
`stats.md`. Both the worker (3/3 attempts) and, after worker failure triggered takeover, the
leader (3/3 attempts) hit the identical rejection:
`"Verification script edited without disclosure: compute_stats.js. Add an entry to
deviationsFromPlan for each edited script before resubmitting."` — 6 failed attempts total, then
the run terminated in the degraded fallback path.

**The actual deliverable was completely correct** — read directly off disk after the run:
`compute_stats.js` correctly reads `data.csv`, computes mean/median/sample-stddev, writes
`stats.md`; `stats.md` contains Mean: 13.0800, Median: 13.1000, Sample standard deviation:
2.0996 — verified independently and it's exactly right. So this is NOT a MiniMax quality problem
and NOT a repeat of D94/D95 — it's a false-positive safety check punishing correct work.

**Root cause**: `detectVerificationScriptTampering()` in `src/orchestrator/artifacts.ts`
(~line 393-406, wired into `enforceVerification` ~line 428-434) flags ANY file that (a) is
referenced by one of `plan.verification`'s commands AND (b) appears in the report's
`filesChanged`, UNLESS `deviationsFromPlan` mentions it by name — with zero distinction between
"this script was a NEW file the plan's own tasks explicitly asked to create" (this exact case:
the plan's task described creating `compute_stats.js`, and its own verification command runs
that same script — a completely ordinary "self-verifying script" pattern) vs. the actual threat
this check was built for (D56-2: an EXISTING verification script being altered post-hoc to mask
a real failure — i.e., genuine tampering). The check as written can't tell these apart, and 6/6
real attempts (across two different agent roles) never thought to add a "deviation" entry for
creating a file they were explicitly asked to create, because it isn't actually a deviation.

`BuildPlan`'s schema already has what's needed to fix this precisely:
`plan.tasks[].files` (optional `string[]`, confirmed at artifacts.ts ~line 13) — the plan's own
declared list of files each task is expected to touch.

## What to do

D96-1: change `detectVerificationScriptTampering()` to only flag a verification-referenced
changed file if it is NOT already listed in any `plan.tasks[].files` entry. Collect the union of
all `files` arrays across `plan.tasks` (basename-normalized the same way `changedBasenames`
already is, case-insensitive, matching the existing style in this function) and skip flagging any
referenced script whose basename is in that expected set. This preserves the real security intent
(a verification script NOT declared anywhere in the plan's own task files, but touched anyway, is
still exactly the kind of undisclosed change D56-2 was built to catch) while fixing the false
positive for the extremely common "the deliverable is also what verification runs" pattern.

D96-2 (small, only if trivial while in this area): a task's `files` field is optional
(`z.array(z.string()).optional()`) — if a plan legitimately omits it (doesn't declare which files
a task touches), D96-1's exemption can't apply and the false positive would still fire. Don't
force `files` to be required as part of this round (that's a bigger prompt/schema change with
its own blast radius) — just confirm this edge case is handled gracefully (i.e., missing `files`
on some/all tasks doesn't crash, just means those tasks contribute nothing to the expected-file
set, matching current behavior for anything not listed).

## Acceptance

tsc + `npm test` green. A regression test reproducing the exact real-world shape: a plan with one
task whose `files` includes a script also referenced by `plan.verification`, and a report that
changed exactly that file without a `deviationsFromPlan` entry — must now pass validation (no
longer flagged). A second test confirming the ORIGINAL D56-2 protection still works: a
verification-referenced script NOT listed in any task's `files` that gets changed without
disclosure must still be flagged. Live verification: rebuild, re-run the exact scenario from this
handoff (leader=worker=minimax/minimax-m3, default triage, a simple self-verifying-script stats
task) through the real desktop app, and confirm it now reaches a clean "leader review approved" /
DONE instead of the degraded takeover-fallback path. Commit `D96-<n>:`, create
`handoffs/D96_done.txt`.
