# Handoff D151 (redesign the reciprocal protocol: one executor does all the work, the second executor is a passive build/launch test subject only)

This is an architecture change to the reciprocal protocol itself, at the same scale as
D143's leader-does-plan-and-validation redesign. Human-directed (not autonomous
wishlist work) - implement it as a normal D-round against master, the same way D143
was done.

## Why (evidence, don't re-derive)

D148, D149, and D150 were three consecutive rounds this session, each fixing a real bug
- and every single one of them was a bug in the cross-executor turn-handoff machinery
(`TANDEM_HOME` resolution at the validate handoff, `Claim`'s RESUME logic at the
accept-to-next-turn handoff, `postBuildReport` at the takeover-to-candidate handoff).
None were bugs in the actual feature work being produced (W0014 progressed correctly
throughout). The two-executor peer-handoff coordination (`Claim`/`Resume`/`Validate`/
`Accept` alternating between Role A and Role B, each running independent scheduled
agentic Tandem sessions) is the concrete, demonstrated source of fragility - not the
work itself.

## The new design (human-specified, don't re-derive or water down)

- **Executor A does the entire lifecycle for every wishlist item alone**: claim, plan,
  implement, its own internal leader-only review (this is normal Tandem leader/worker
  architecture within a single executor - keep it exactly as it is; it is NOT the thing
  being removed), verify, and commit. No handoff to a second executor's agentic session
  at any point in an item's lifecycle.
- **Executor B does zero coding work in the reciprocal process.** It never claims a
  wishlist item, never plans, never implements, never runs its own independent
  scheduled agentic prompt loop against the wishlist board. Its only role is to be "the
  subject of testing" - after A produces a new commit, B's copy gets built and launched
  from that commit and used to confirm the new code actually runs as a real, separate
  process before it's trusted as stable.
- **Preserve the actual self-modification safety property**, which is the entire reason
  a second copy exists at all: Executor A must keep editing/committing on a worktree
  and branch that is NOT the one its own currently-running binary was built from (the
  existing cross-worktree arrangement - A edits `copy-b`/`codex/reciprocal-b`). That
  way a broken commit can never corrupt the live process that just wrote it. What
  changes is what happens to Executor B - previously B's own Tandem agent claimed and
  validated that commit in a full peer session; now B's copy is simply rebuilt and
  relaunched from A's new commit as a mechanical build+launch+smoke-test step (no
  agentic reasoning on B's side at all), and if that succeeds, the commit is accepted
  as the new stable baseline for both branches.
- Keep D143's "mechanical checks with zero model tokens, then exactly one leader-only
  review call" pattern - it's still the right shape for the ONE review that happens
  before A commits its own work. What's being removed is the SECOND, cross-executor
  copy of that same idea (a peer Tandem session claiming VALIDATE) - replace it with
  the passive build/launch check described above.
- Keep D149's genuine-resume-state check (`Test-GenuineResumeState`) - it's still
  useful for Executor A recovering its own interrupted turns, which can still happen
  under the new single-producer design. Keep D150's `postBuildReport`-on-takeover fix
  for the same reason.
- **Closing the loop: Executor B also rebuilds Executor A once a version is verified.**
  Executor A can never safely rebuild or redeploy its own live running binary - that's
  the same self-modification bootstrap hazard that justifies the two-copy arrangement
  in the first place. So the full cycle is: A produces a commit -> B is rebuilt and
  relaunched from that commit as the mechanical build/launch/smoke-test step described
  above -> if that build passes its automated checks AND passes a human manual-test
  confirmation (this last gate is human-required, not autonomous - it matches the
  existing `SHARED_DIRECTION.md` guardrail that "runtime promotion... remain[s]
  human-gated") -> only then is that same verified commit used to rebuild Executor A's
  own installation, so A starts running the new version too. B is not just a test
  subject that gets thrown away after checking a commit - it is the only one of the two
  that is ever actually rebuilt/relaunched mid-cycle, and it is the mechanism that
  safely delivers a verified new version to A, since A must never do that to itself.
  Look at the existing `scripts/promote-reciprocal-runtime.ps1` (idempotent runtime
  promotion, built for a related purpose earlier this project) and reuse or extend it
  for this A-upgrade step rather than building new promotion tooling from scratch,
  unless you find a concrete reason it doesn't fit.

## What needs to change

1. **Protocol and role documents** - rewrite these to describe the new model precisely,
   not just prose-summarize it (the actual state machine and scheduling below must
   match what these documents say, or this repeats the exact D145/D146 class of
   docs-vs-code desync this project has already been burned by twice):
   - `process/reciprocal/PROTOCOL.md`
   - `process/reciprocal/TANDEM_EXECUTOR_A.md`
   - `process/reciprocal/TANDEM_EXECUTOR_B.md`
   - `process/reciprocal/README.md` if it describes the old two-producer model
2. **`scripts/reciprocal-relay.ps1`** - the state machine currently exists to coordinate
   two independently-scheduled agentic roles trading turns (`nextRole` alternation,
   `WAIT` when the peer owns the turn, `Claim`/`Validate`/`Accept`/`Reject`/`Complete`
   as a cross-role handoff). Redesign it around a single producing role with a
   mechanical build/launch acceptance gate instead of a peer `Validate` claim. Decide
   the concrete state-machine shape yourselves, but the acceptance criteria below
   require the end result to have no path where Executor B's own Tandem agent claims,
   plans, implements, or independently reviews a wishlist item. Also add whatever new
   state/action is needed for the A-upgrade step described above (B rebuilt and
   verified -> human confirms -> A is rebuilt from the same commit) - this is a new
   explicit phase in the cycle, not an afterthought bolted onto the existing actions.
3. **Automation/scheduling** - Executor B's Tandem installation should no longer run
   its own independent scheduled agentic prompt loop against the reciprocal wishlist
   (check `scripts/start-reciprocal-tandem.ps1`, the dashboard's scheduling in
   `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs`, and whatever cron/
   Scheduled Task currently fires B's automation `/prompt` on its own cadence). B's
   process should only be invoked reactively - build and launch from A's latest commit
   - not polled on a timer for its own wishlist work.
4. **Dashboard** - update the "Reciprocal overview" UI (`server.mjs` / `public/app.js`)
   to reflect the new model: it currently shows two symmetric lanes ("Executor A -
   Improves Copy B" / "Executor B - Improves Copy A") implying parallel peer work. Make
   it accurately show A as the sole producer and B as the passive test target, however
   you judge is clearest - don't leave the UI implying a symmetry that no longer exists.
5. **Tests** - `tests/reciprocal-relay.test.ts` and any other tests written against the
   two-role alternation model will need substantial rewriting, not patching.

## Constraints

- Do not touch Tandem's core leader/worker architecture (`src/orchestrator/machine.ts`,
  `AgentFns`) - that's Executor A's own internal plan/implement/review cycle and is
  correct as-is. This handoff is only about the cross-executor reciprocal coordination
  layer.
- Do not weaken the self-modification safety property described above - a commit must
  never be built and launched by the same live process that authored it.
- Do not begin live-promoting this redesign to the actual running executors while any
  candidate is in-flight (relay phase `validating`/`rollback-verification`/`working`
  with an active owner). As of this handoff the pending candidate this constraint
  originally referred to (`72f3ce26`, W0014 step 2/3) already resolved - it failed
  leader-only review on an environment issue unrelated to its own correctness, was
  correctly rolled back via `CompleteRollback` (relay is now `idle`, turn 6, stable
  still `3992fdf`), and the real completed diff remains recoverable from git history
  at commit `72f3ce26` for whoever picks up W0014 next. Check current relay state
  before promoting regardless, in case a new turn started in the meantime - implement
  and test the new design fully, but only promote once the relay is genuinely idle
  with no in-flight candidate, then update `SHARED_DIRECTION.md`/state as needed to
  reflect the new model going forward.
- Do not lose or weaken the mechanical typecheck/test/diff-check gates - they remain
  required before any commit is trusted, same as today.

## Acceptance

Explain in `handoffs/D151_done.txt` the concrete new state-machine shape you chose and
why, referencing this handoff's constraints rather than re-deriving the reasoning.
Updated protocol/role/README docs read consistently with the actual script behavior -
if a reviewer opens `PROTOCOL.md` next to `reciprocal-relay.ps1`, they should not find
elements of the old two-producer model described in one and not the other. Live proof:
after the currently-pending candidate resolves and this redesign is promoted, run one
real end-to-end cycle - Executor A claims a real queued wishlist item, completes it
alone (plan, implement, its own leader review, verify, commit) with no second-executor
agentic session involved anywhere in that cycle, and Executor B's copy is mechanically
built and launched from that new commit and confirmed healthy before it becomes stable
- paste the real evidence (session log excerpts, relay state transitions, build/launch
confirmation output), not a description of what should have happened. For the
A-upgrade step: since it ends in a human manual-test gate, you don't need a full
human-confirmed A rebuild to close this handoff - it's enough to show the mechanism
exists and reaches that gate cleanly (B verified and rebuilt from a real commit, the
promotion tooling for rebuilding A from that same commit ready and demonstrated in a
dry run or against a safe test target), leaving the actual human confirmation and A
rebuild as the next real action for a human to take. tsc + `npm test` green. Commit
`D151-<n>:`. Create `handoffs/D151_done.txt`.
