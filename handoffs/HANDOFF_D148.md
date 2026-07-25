# Handoff D148 (D143's leader-only review call resolves the wrong leader model - falls back to Anthropic instead of the executor's configured codex/cli)

Live blocker: candidate `3992fdf` (the D146 rollback) failed the new D143 leader-only
review step with `missing ANTHROPIC_API_KEY`. Mechanical checks (typecheck, test,
diff) all passed - only the review call itself failed. The relay behaved safely
(refused to auto-revert-of-revert, surfaced the blocker clearly, did not loop) - this
is a real, previously-undiscovered bug in D143's new path, not a stall.

## The mismatch (confirmed, don't re-derive)

Executor A's actual configured leader (`state/executor-a/config.json`) is
`"leader": "codex/cli"` - this is a deliberate D124 decision; the executors have
never needed `ANTHROPIC_API_KEY` for anything before. `scripts/reciprocal-relay.ps1`'s
`Validate` action does have a `-TandemHome`/`$TandemHome` parameter that's supposed to
be threaded through to `scripts/reciprocal-validate-review.ts` (which sets
`env.TANDEM_HOME` before calling `loadConfig()` and `createLiveAgents()`), but the
review call resolved to a leader requiring `ANTHROPIC_API_KEY` - meaning `TANDEM_HOME`
either wasn't correctly populated with the executor's real isolated home at the point
`Validate` was invoked, or the sandboxed Codex child process that ultimately runs
`Validate` doesn't actually pass/inherit that env var through to the `tsx` subprocess
running `reciprocal-validate-review.ts`.

## Investigation

Trace the actual value of `$TandemHome`/`env.TANDEM_HOME` at each hop, for a REAL
`Validate` invocation (not a scratch/synthetic test) run from inside the executor's
real sandboxed environment: (1) what does the Codex leader/worker actually pass as
`-TandemHome` when it runs the `Validate` command (check the exact command line in a
real session log, e.g. the session for `3ce04983...`/`7c232aea...` around the review
failure), (2) does `reciprocal-relay.ps1` correctly forward that into
`env:TANDEM_HOME` before spawning the `tsx` review process (confirmed present in code
at line ~429, but confirm it actually received a non-empty value this time), (3) does
`loadConfig()` in `src/config/load.ts` correctly resolve the executor's
`state/executor-a/config.json` when given that `TANDEM_HOME`, or does something about
running inside `npx tsx` from a Codex sandbox context break that resolution.

## Fix

Once the actual break point is found, fix it there - do not paper over this by adding
`ANTHROPIC_API_KEY` to the executors' `.env` files as a workaround. The review call
must use the SAME leader the executor is already configured and pinned to
(`codex/cli`/`gpt-5.6-sol`), not silently fall back to Tandem's shipped default
leader. If TANDEM.md/PROTOCOL.md's `Validate` command example doesn't correctly
document passing `-TandemHome` with the real value, fix that documentation too so a
future invocation can't omit it.

## Constraints

- Do not add ANTHROPIC_API_KEY as the fix - that treats the symptom, not the cause,
  and would mean every future validation silently uses a different (and differently-
  priced) model than the one this project deliberately configured.
- Do not touch the "refuse auto-revert-of-revert" safety behavior - that part worked
  correctly and should be preserved exactly as-is.

## Acceptance

Root cause traced with real evidence (the actual TANDEM_HOME value at each hop, not a
guess). Fix demonstrated live: successfully complete review for the currently-pending
rollback candidate `3992fdf` (or whatever is pending by the time this lands) using the
executor's real configured `codex/cli` leader - paste the real ReviewVerdict output
showing which model/provider actually served it. Add a regression that would have
caught this (e.g. asserting the review helper resolves the executor's own config
leader, not the shipped default, given a real isolated TANDEM_HOME). tsc + `npm test`
green. Commit `D148-<n>:`. Create `handoffs/D148_done.txt`. Leave the relay in
whatever state naturally results from successfully completing the pending validation
(do not force-advance anything beyond that one candidate).
