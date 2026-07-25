# Handoff D199 (the new orchestrator has no trigger at all — D197 correctly deleted the old per-worktree cron, but nothing replaced it, so the reciprocal loop is permanently idle)

## Live finding (verified — don't re-derive)

`orchestrator-operations.ndjson`'s last entry is `idle.no-work` at
`2026-07-24T02:39:41Z` — over two hours stale. Every orchestrator invocation since
then was a manual/explicit one during D196-D198's own live-proof steps, never an
autonomous trigger. Verified directly:

- `copy-a`/`copy-b`'s `.tandem\schedules.json` are genuinely `[]` (8 bytes each) —
  D197 correctly retired the old per-worktree Executor A/B agentic cron.
- No Windows Scheduled Task, cron, or config anywhere invokes
  `scripts\reciprocal-orchestrator.ps1`. The only live scheduled activity is the
  dashboard watchdog (read-only status polling) and unrelated review-monitoring
  tasks.
- `W0023` sits correctly `QUEUED`/requeued on the wishlist per D197's disposition,
  but with no trigger, the orchestrator will never claim it.

D196's design ("invoked by cron from the admin repo") specified a trigger but no
round actually created one — D197 removed the old trigger as part of retiring
per-worktree scheduling without adding its replacement.

## Fix

1. Add the actual periodic trigger for `scripts\reciprocal-orchestrator.ps1`,
   invoked from the admin repo (never from a worktree), on a reasonable cadence
   (match or improve on the old 30-minute-ish cadence — the new cycle is much
   faster per D196's live proof, ~40 seconds for a clean cycle, so a shorter
   interval is reasonable; justify your choice). Use whichever native mechanism
   this codebase already has for durable scheduling on this host (a Windows
   Scheduled Task, matching the pattern of the existing
   `TandemReciprocalDashboardWatchdog`/`TandemHandoff*` tasks, is one reasonable
   choice — pick the one that fits how `start-reciprocal-tandem.ps1`/the dashboard
   already manage long-lived processes on this machine).
2. Make the absence of a trigger observable going forward: surface "orchestrator
   last ran at X" / "no trigger configured" in the dashboard status output (it
   already reads `orchestrator-state.json`; add a staleness or
   trigger-registered check) so this can't silently regress into another
   multi-hour idle gap without anyone noticing.
3. Regression: a test/check that the configured trigger's command line actually
   resolves to the admin-repo orchestrator script (not a worktree copy), and that
   the dashboard status reflects trigger presence/last-run staleness.

## Live proof required

Show the trigger firing at least once for real (a real `orchestrator-operations.ndjson`
entry with a timestamp after the trigger was installed, not manually invoked by
you), and — since `W0023` is genuinely queued — let that real tick claim it if the
cadence allows; if not within a reasonable wait, that's fine, just show the
trigger mechanism firing on schedule and report what happens with `W0023`
separately when it's claimed.

## Constraints

- Do not manually drive `W0023` through the orchestrator yourself as a substitute
  for a real trigger firing — the point of this handoff is the trigger, not one
  more manual cycle.
- Do not reintroduce per-worktree scheduling; the trigger must live in the admin
  repo / host-level scheduling, consistent with D196's single-orchestrator design.
- Do not touch the W0023 stash/queue state beyond what a real orchestrator claim
  does.

## Acceptance

`handoffs/D199_done.txt`: the chosen trigger mechanism and cadence with
justification, the dashboard staleness/trigger-visibility addition, regression
names, and live proof of at least one real unattended trigger firing. tsc +
`npm test` green. Commit `D199-<n>:`. Create `handoffs/D199_done.txt`.
