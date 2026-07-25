# Handoff D156 (eliminate unnecessary scheduled-tick latency between fully-automatic phase transitions - Executor A should keep going, not wait for the next tick, when nothing requires a human)

## The gap (confirmed live, don't re-derive)

D155 correctly removed the *human* gate between intermediate epic steps - accepting a
non-final step now returns the relay to `idle` instead of `a-upgrade-pending`. But
`idle` still means "wait for the next scheduled `Claim`," and today that only happens
on Executor A's cron tick (every 30 minutes, per the schedule set up earlier this
session). Watching W0016 live exposed two separate scheduling gaps, neither of which
needs a human or even a fresh model decision:

1. After a producing turn calls `Complete`, the relay enters `passive-testing` with a
   pending candidate - but nothing runs `PassiveTest` until *another* invocation's
   `Claim` happens to see that phase and gets told (via the `PASSIVE_TEST` outcome) to
   run it. `PassiveTest` itself is a purely mechanical script (typecheck/test/build/
   diff-check/package, D153) - it needs no model call and no human judgment. There is
   no real reason it has to wait for a separate scheduled tick.
2. After `PassiveTest` accepts an intermediate step (post-D155: relay returns to
   `idle` with `autonomousContinuation.available=true`), nothing claims the next step
   until the *next* scheduled tick's `Claim` happens to fire. Since
   `requiresHumanGate=false` for this case (D155), there's no reason a human or even a
   separate invocation needs to be involved - the executor already knows exactly what
   the next step is (`autonomousContinuation.nextStep`, `startCommand`).

The net effect: a 3-step epic like W0016, with zero human input required after the
plan is approved, can still take hours of pure scheduling latency (up to 6 gaps of
~30 minutes each) to finish, because each no-human-required transition still waits for
a fresh cron tick.

## Fix

Let a single invocation keep driving forward through every transition that does not
require a human or a fresh planning decision, stopping only at a genuine boundary:

1. **After `Complete` registers a candidate**, have the same invocation (or an
   automated follow-up triggered immediately, not on the next cron tick) run
   `PassiveTest` right away - it's mechanical, already scriptable, and already being
   invoked programmatically elsewhere (see D153's `TANDEM_PASSIVE_PACKAGE_PREPARED_WIN_UNPACKED`
   pattern for how mechanical steps get chained without a model in the loop). Decide
   whether this belongs inside `reciprocal-relay.ps1`'s `Complete` action itself
   (call `PassiveTest`'s logic directly as a follow-on step) or as a thin wrapper
   script/automation hook that fires immediately after `Complete` succeeds - either is
   fine as long as it does not require waiting for the executor's own cron schedule.
2. **After `PassiveTest` accepts an intermediate step** (`autonomousContinuation.available=true`,
   `requiresHumanGate=false`), automatically trigger the next step's `Claim`/`Start`/
   implementation immediately rather than waiting for the next scheduled tick - e.g. by
   having the automation layer (the dashboard's automation server, or a small follow-up
   script) issue the equivalent of a fresh `/prompt` to Executor A's automation endpoint
   right after acceptance, using `autonomousContinuation.startCommand`, instead of
   relying solely on the cron schedule to eventually pick it up.
3. **Add a sane per-chain bound.** Do not let this become an unbounded loop that
   silently burns arbitrary time/cost/context across an entire large epic in one
   uninterrupted rush - cap how many consecutive no-human-gate transitions can chain
   automatically before the system pauses and reports status (a reasonable default:
   the remaining steps of the epic currently in flight, not an unlimited chain across
   unrelated future wishlist items). Make the cap and its rationale explicit in your
   `D156_done.txt`, and pick a number rather than leaving it unbounded.
4. Keep the scheduled cron tick as the *fallback* - if the immediate chaining fails for
   any reason (crash, timeout, unexpected error), the relay must still be in a state
   the next normal scheduled tick can pick up and continue correctly, exactly as it
   does today. This is additive - a fast path when nothing is blocking, not a
   replacement for the existing resilient tick-driven recovery.

## Constraints

- Do not weaken or skip the mechanical `PassiveTest` checks themselves - every commit,
  intermediate or final, still needs to pass typecheck/test/build/diff-check/package
  exactly as today. This handoff only removes *scheduling* latency between already-
  automatic steps, never removes a verification step.
- Do not touch the final-step human gate (`a-upgrade-pending`/`CompleteAUpgrade`) - it
  remains exactly as D151/D154/D155 left it. This handoff only speeds up the path
  *before* that gate is reached, never bypasses or automates the gate itself.
- Do not let same-invocation/immediate chaining apply to genuinely human-gated
  situations (plan-gated epic plan approval, the final A-upgrade confirmation,
  security-surface work) - those must still wait for real human action, unaffected by
  this change.
- Preserve the existing D133 resume circuit breaker and D149's genuine-resume-state
  check - immediate chaining must not be able to spin in a tight failure loop faster
  than a human could notice; if a chained step fails to complete, it should surface the
  same way a normal failed/incomplete turn does today, not retry silently forever.

## Acceptance

Explain in `handoffs/D156_done.txt` exactly what triggers the immediate continuation at
each of the two gaps identified above, what the chosen per-chain bound is and why, and
how the existing cron-tick fallback still works if immediate chaining is unavailable or
fails. Live proof: use the real, currently in-flight W0016 epic (3 steps, already plan-
approved) - show at least one full "step accepted -> next step claimed" transition
happening without waiting for the next scheduled cron tick, with real timestamps
demonstrating the gap was seconds/minutes, not ~30 minutes. If W0016 reaches its final
step and the human A-upgrade gate correctly still applies there, show that boundary
holding exactly as before. tsc + `npm test` green. Commit `D156-<n>:`. Create
`handoffs/D156_done.txt`.
