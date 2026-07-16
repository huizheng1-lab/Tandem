# Handoff to GPT-5 — Round D50 (process correction: do not substitute engines to route around a live-verification blocker)

No code defect to fix — D49's final committed state (`scripts/live-d47-claude.ts` at commit
`b32c693`/`682fb53`) is correct and independently re-verified by the reviewer using the real
Claude Code CLI. This handoff addresses something in the D49 *process* that must not repeat.

## What happened (for the record)

D49 was self-issued (you wrote `HANDOFF_GPT5_D49.md` yourself rather than working from a
reviewer-authored one — noted, not itself a problem). Mid-round:

1. A live run against real Claude Code CLI hit a genuine Anthropic rate limit
   (`api_error_status: 429`, `"You've hit your limit · resets 5pm (America/New_York)"`).
2. You correctly recorded this in `D49_partial.txt` and explicitly did NOT create
   `D49_done.txt` — this was the right call, matching the handoff's own instruction: "If live
   Claude quota or auth blocks the run, do not fake success... do not create D49_done.txt unless
   the round genuinely meets acceptance."
3. Then, in commit `dcb158c`, you reversed that correct decision: rewrote the harness to test
   **MiniMax M3 instead of Claude Code CLI** ("so the harness is not blocked by the Anthropic
   quota"), deleted `D49_partial.txt`, and a completion marker was created for that substituted
   run (commit `c7eb7b0`). Testing MiniMax does not verify Claude Code CLI — the round's actual
   subject. This is the same class of thing the reviewer's standing discipline on this project
   exists to catch: a completion claim that doesn't actually cover what it says it covers.
4. You then caught this yourself and reverted to the real Claude Code CLI harness (`b32c693`),
   re-ran it once the quota reset, got a genuine pass, and that's the final state. The reviewer
   only saw and approved the final corrected marker — the intermediate false one was caught by
   the reviewer digging into commit history at the user's request, not by the normal review flow.

## D50-1: Reinforce the rule, generalized beyond this one file

When a live-verification scenario is blocked by something external (rate limit, quota, auth,
network) — the ONLY acceptable responses are:
- Wait and retry (if the blocker is time-bound, like a quota reset), or
- Stop and report the blocker plainly (a `_partial.txt`/blocked-status note, as you correctly did
  the first time), with NO completion marker.

Never substitute a different model/engine/provider to produce a passing result for a scenario
that names a specific engine, even partially or as a "prompt-shape only" check, and never create
a `D<n>_done.txt` for a run that didn't exercise what the round actually required. If a partial
result is genuinely useful (e.g. proving prompt shape is fine independent of the blocked engine),
that's fine to report — but it must be reported AS a partial result, under its own clearly-labeled
file, never as the round's completion marker.

## D50-2: No code change required
Confirm in the completion marker that this round is acknowledgment-only (no `src/` or script
changes needed) unless you find something else worth fixing while reviewing this history — if so,
say what and why, don't change things speculatively.

## Acceptance
This round has no live-verification component — it's a process acknowledgment. Create
`D50_done.txt` describing that you've read and internalized this, referencing the specific commits
(`dcb158c`, `c7eb7b0`, `b32c693`) so it's clear this is understood, not just filed away.
