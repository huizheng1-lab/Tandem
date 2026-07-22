# Post-D180 Reciprocal Recovery Changes

Date: 2026-07-22

This record documents the Reciprocal source and live-state changes made after
`b3e587c` (`D180-2: expand main update recovery coverage`). The work was performed
directly in the admin repository after the live controller repeatedly remained in
`Planning`, recreated pauses, or failed to continue approved epic work. No new
handoff was used for these changes.

## Observed Failure Chain

The delay was caused by several interacting controller defects rather than by the
complexity of W0027 or the intelligence of the selected worker/leader models:

1. The continuation supervisor recognized only `IN_PROGRESS phase=STEP` epics. It
   ignored an approved `PLAN_APPROVED` epic and could select a lower-priority queued
   item instead.
2. Executor A's HTTP `409` response meant that accepted work was already running,
   but the supervisor classified it as an unavailable endpoint and persisted a
   blocker.
3. Candidate finalization could commit source successfully and then fail to update
   the board/relay, leaving committed work stranded in a nonterminal state.
4. Resumed epic plans with an already-checked step prefix were not parsed correctly.
5. Abbreviated candidate SHAs could not be matched against the relay's full accepted
   SHA during automatic approval.
6. Main-update recovery synchronized branches but did not reliably resume the exact
   pause that the update had created.
7. Source reconciliation compared commit IDs for equality. A stable merge descendant
   containing the source commit was therefore treated as stale, causing redundant
   main updates and repeated pauses.

## Source Commits

| Commit | Change |
| --- | --- |
| `a138c55` | Added durable app-layer candidate-finalization recovery, paired board/relay completion behavior, packaging retry handling, and recovery tests. |
| `beae27e` | Made the supervisor continue approved epics in priority order and classify an already-running executor as waiting rather than blocked. |
| `a07adac` | Added resumed-plan parsing for a checked completed-step prefix. |
| `242ae5d` | Completed resumed epic finalization, persisted completed-step metadata, and canonicalized abbreviated/full accepted SHAs. |
| `31dfe76` | Persisted main-update pause ownership and resumed only the exact machine-created pause after branch synchronization. |
| `bcb55c7` | Made source reconciliation ancestry-aware so a stable descendant containing source is already reconciled. |

## Implementation Details

### Candidate finalization

- `src/reciprocal/candidate-commit.ts` now writes a durable finalization record around
  the guarded commit/board/relay sequence and can resume after a partial failure.
- Finalization distinguishes explicit human pauses from recoverable machine-created
  lifecycle state. It does not automatically clear an explicit human pause.
- Ordered plan steps are parsed as a whole. A contiguous checked prefix becomes
  `completed=<N>` while the remaining steps stay pending.
- The relay and direction scripts use paired, idempotent completion semantics so a
  retry does not duplicate a commit or terminal board transition.
- Packaging/finalization retry paths were aligned across the desktop service,
  dashboard manifest/server, passive-runtime packaging, and relay.

### Continuation scheduling

- `scripts/continue-reciprocal-automation.ps1` now recognizes both:
  - `IN_PROGRESS epic=true phase=STEP`; and
  - `PLAN_APPROVED epic=true` with a remaining `next=<N>/<total>` step.
- Eligible work is ordered by priority and then wishlist ID. This ensures W0027/P0
  is selected before W0023/P1.
- Executor status is checked before prompt submission. A running executor or a `409`
  race produces `waiting-not-blocked / executor-busy`, not
  `endpoint-unavailable`.
- Supervisor display state follows the live relay. Once the relay is actually
  `working` or `passive-testing`, stale endpoint blockers are cleared.
- `process/reciprocal/gate-taxonomy.json` includes the nonblocking executor-busy
  classification.

### Epic metadata and commit identity

- `scripts/reciprocal-direction.ps1` accepts and validates completed-step metadata for
  resumed plans.
- Automatic plan approval resolves both abbreviated and full candidate IDs to the
  canonical full stable commit before comparison.
- `scripts/reciprocal-relay.ps1` accepts an unambiguous SHA prefix when it resolves to
  the exact candidate/stable commit.

### Main-update recovery and reconciliation

- `scripts/reciprocal-main-update.mjs` persists `resumeRequired` in every transaction
  stage.
- Recovery may resume only when relay state still matches the update's exact durable
  pause and synchronized commit. An unrelated or explicit human pause is not cleared.
- Recovery is idempotent when the relay is already idle at the synchronized commit.
- Source reconciliation now checks whether the source commit is an ancestor of stable.
  If so, no new main update is launched merely because the two SHA strings differ.

## Live Recovery Performed

The following operational changes were made after the source fixes:

1. Recovered W0023's committed plan candidate
   `c6e450b2dbaf679bff6ef1fa4abcc3c0aab704e5`, including its completed steps 1-2,
   and restored it to `PLAN_APPROVED ... next=3/3`.
2. Completed interrupted main-update transactions and branch synchronization through
   annotated tags `main-update-009`, `main-update-010`, and `main-update-011`.
3. Cleared only the main-update-created pause after the transaction proved both
   reciprocal worktrees and the stable ref were coherent.
4. Directly claimed Executor A from its correct target worktree and started W0027
   Step 1 without creating another handoff.

After `main-update-011`:

- `origin/master` and `refs/tandem-relay/stable` were both
  `89aa2056750e573000e3a2c0eaabfdcbd95d3ff2`.
- The durable main-update transaction file was cleared.
- Both reciprocal worktrees were synchronized to the same stable commit.
- The supervisor reported `displayState=working` and `blocker=null`.

Live snapshot at 2026-07-22T13:41Z:

```text
W0027: IN_PROGRESS epic=true phase=STEP completed=0 step=1/3 role=A
relay: phase=working activeRole=A
supervisor: displayState=working blocker=null
executor A: running=true, session=78ed17dd-6659-4258-b076-c407289d8c1a
worker tree: source work started under src/environment/
```

The snapshot records the recovery outcome; it is not intended to freeze W0027's
later lifecycle state.

## Verification

- `npm run typecheck`: passed.
- PowerShell parser checks for the changed supervisor, direction, and relay scripts:
  passed.
- `git diff --check`: passed.
- Focused candidate, direction, relay, main-update, and supervisor tests passed during
  implementation.
- Isolated `tests/reciprocal-direction.test.ts`: 24/24 passed.
- A repository-wide run reached 540 passing tests and one skipped test, with one
  five-second timeout in the direction suite under aggregate load. The timed-out test
  passed in the isolated direction run, so this was recorded as a suite-load timing
  caveat rather than a functional failure.

## Preserved State

- The unrelated tracked modification to `scripts/setup-reciprocal-tandem.ps1` was not
  edited, staged, reset, stashed, or committed.
- Existing untracked handoffs, reports, scripts, and temporary artifacts were not
  removed or incorporated.
- Because the admin worktree was dirty, the main updater intentionally left the local
  `master` ref at `bcb55c7`; it pushed and reconciled the integration commit without
  overwriting local user state. The stable and remote refs contain `bcb55c7` by
  ancestry.
- No W0027 product implementation was performed manually by the reviewer. The
  reviewer repaired and activated Reciprocal; Executor A owns the product work.
