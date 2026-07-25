# Handoff D144 (autonomous epics: don't wait a full schedule tick between Accept and starting the next step)

Live observation: after D143's redesign made plan validation/acceptance near-instant,
executor A validated and auto-approved W0014's plan, and the relay correctly recorded
A as owner of the next "working" turn (matches the established pattern - the accepting
executor becomes the next producer) - but A's own invocation stopped there, per an
explicit rule: "No further actions taken in this turn per BuildPlan constraint of one
lifecycle per worker invocation." The result: Step 1 sat unclaimed for up to an hour
until A's next scheduled tick, even though nothing was blocking it - autonomy=full
means no human gate applies, and ownership was already correctly assigned.

## What to change

For a FULLY AUTONOMOUS epic (`autonomy=full`) specifically: after a lifecycle action
that results in Accept (approving a plan candidate, or accepting a step candidate) AND
there is a next step/action immediately available with no human gate blocking it, the
SAME invocation may continue - within that one session, in the same turn - to Claim/
Start and produce the next artifact (implement the next step, or if the epic just
completed its last step, correctly stop since there's nothing left). This chains AT
MOST ONE extra lifecycle action onto the Accept - do not chain further (i.e., accept
step N, then implement step N+1, then STOP normally like any other producer turn -
verification, checkpoint, single commit, same discipline as today. Do not attempt to
blast through multiple remaining steps in one session).

## What must NOT change

- Plan-gated epics (`autonomy != full`, i.e. plan-gated) must still stop after Accept
  and wait for the human's explicit plan approval before any step work begins - this
  round only removes the WAIT for autonomous items where no human gate exists anyway.
- Non-epic items and the plan-writing turn itself are unaffected.
- Turn-size/verification discipline for the chained implementation step is identical
  to a normal producer turn - same checks, same single-commit-per-step rule, same
  circuit-breaker resume counting if it doesn't finish.
- Validation of a candidate still happens as its own separate turn (claimed by the
  OTHER executor) - this round only removes dead time on the ACCEPTING side, not the
  cross-executor validation step itself.

## Where to make the change

Likely in `scripts/reciprocal-relay.ps1`'s `Accept` handling and/or the
`TANDEM_EXECUTOR_A.md`/`TANDEM_EXECUTOR_B.md` turn instructions (whichever currently
enforces "one lifecycle action per invocation" - find and adjust that specific
constraint for the autonomous-epic-continuation case rather than removing the rule
generally). Verify how the relay currently signals "there is a next available action
with no human gate" so the continuation logic can check that condition reliably rather
than guessing.

## Acceptance

tsc + `npm test` green with a regression proving: (a) an autonomous epic's plan
Accept immediately continues into implementing step 1 within the same invocation,
producing two real commits (plan + step 1) from one session; (b) a plan-GATED epic
still stops after Accept and does NOT auto-continue; (c) after the LAST step of an
autonomous epic is accepted, the invocation correctly stops (nothing left to chain to)
rather than erroring or looping. Live evidence: demonstrate this against a real
scratch epic or the next real autonomous item if one is queued - paste the relay
state/session evidence showing the chained continuation actually happened with no
schedule-tick gap in between. Commit `D144-<n>:`. Create `handoffs/D144_done.txt`.
