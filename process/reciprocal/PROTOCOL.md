# Reciprocal Tandem Protocol

D196 replaces the multi-actor relay with one admin-repo orchestrator. The
orchestrator is the only writer of reciprocal state and the only invoker of
mechanical steps. Executor A remains the only agentic producer. Executor B is
only a temporary mechanical runtime during the swap window and never receives
wishlist prompts, `/prompt` calls, claims, planning work, or review authority.

## Single Entry Point

Cron invokes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<admin-repo>\scripts\reciprocal-orchestrator.ps1"
```

Status-only inspection is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<admin-repo>\scripts\reciprocal-orchestrator.ps1" -Status
```

Legacy relay actions, continuation-supervisor dispatch, dashboard mutation
paths, promotion-operation journals, runtime-recovery journals,
schema-version migration boundaries, stable-baseline classification, and the old
multi-phase gate taxonomy are not part of the normal system. A compatibility
caller must stop and route to the orchestrator instead of continuing the old
baton pass.

## State

The new durable state is one small strict UTF-8 JSON file:

```text
<relay-root>\state\orchestrator-state.json
```

Allowed phases:

- `idle`: no active item, or no queued wishlist item exists.
- `improving`: A owns the current item and may retry after machine-visible
  failure output.
- `swapping`: the accepted version is being packaged, B is started, B
  mechanically rebuilds A, A is restarted and verified, then B is stopped.
- `failed-paused`: the loop is paused by a human pause file or by two
  consecutive failed A rounds.

The sequential operation log is:

```text
<relay-root>\control\orchestrator-operations.ndjson
```

It replaces promotion-operation and runtime-recovery journals. A reboot or
process kill resumes from the state file on the next cron tick. The recovery
rule is deliberately simple: re-run the current sequential step or the current
A round through the single orchestrator. There is no second recovery actor.

## Cycle

1. Claim the highest-priority `QUEUED` wishlist item. If none exists, write an
   idle state and exit.
2. A implements in copy B. B is dormant.
3. A runs the required tests. If tests fail, the full failure output is recorded
   as feedback for the next A round.
4. After one failed round, retry the same wishlist item with the recorded
   feedback visible in the operation log. After two consecutive failed rounds,
   write a human-readable failure report under
   `<relay-root>\control\failure-reports\` and set `failed-paused`.
5. On success, build/package the accepted runtime for B and start B.
6. B runs only the mechanical rebuild-A step: stop/replace A with the accepted
   version, start A, and verify runtime integrity.
7. A stops B. The completed wishlist item is marked `DONE`; the orchestrator
   checks for more work on the next tick.

The human touchpoints are only: adding wishlist items, creating a pause control
file, reading failure reports, and the existing post-hoc feature
review-rejection loop that re-queues wishlist work with feedback.

## Kept Boundaries

- Keep git stable/candidate refs for provenance and review.
- Keep the wishlist file and rejection requeue flow.
- Keep one runtime integrity/package check immediately before swap.
- Keep cron scheduling, now aimed at the orchestrator rather than an executor
  prompt.
- Keep strict UTF-8 JSON I/O and size caps for durable state.

## Deleted Moving Parts

The following are replaced, not layered underneath the new loop:

- Continuation supervisor.
- Stable-baseline discrimination and classification.
- Promotion-operation journals.
- Runtime-recovery journals.
- Relay `schemaVersion` migration boundary.
- Agentic B behavior.
- Dashboard mutation paths for approval/promotion/relay actions.
- Legacy phases such as `working`, `passive-testing`, `validating`,
  `a-upgrade-pending`, and `paused` as normal control-flow states.

## Executor Rules

Executor A may act only when invoked by the orchestrator. It implements the
current claimed wishlist item in copy B, records concise evidence, and returns
control to the orchestrator. It does not write relay state directly.

Executor B has no instructions for agentic work. If B is opened directly, it
must report that it is a mechanical swap runtime only and stop.

No actor may bypass the orchestrator by running old relay/promotion/dashboard
mutation actions as a state machine. Any compatibility surface must point to the
single entry point above.
