# Handoff D130 (in-sandbox full `npm test` is unrunnable on Windows - re-route the turn's mandatory verification)

Relay state when you start: `pauseAfterTurn` requested by me (human) while phase=working,
activeRole=A - the W0010 Step 1 turn is interrupted-but-resumable. W0010 Step 1 is FULLY
IMPLEMENTED and passing its 34 focused tests, preserved UNCOMMITTED in
`worktrees/copy-b` (modified: src/session/cost.ts, app/main/tandem-service.ts,
tests/desktop-service.test.ts, epic plan checkbox; new: tests/session-cost.test.ts) with a
recovery checkpoint. Do not lose or redo that work.

## The blocker (confirmed across two independent turns)

PROTOCOL.md requires every turn to run `npm run typecheck`, `npm test`, `git diff --check`
before committing. Typecheck and focused vitest runs work inside the Codex
workspace-write sandbox, but the FULL `npm test` does not, on Windows: the exact mandatory
command is "sandbox-blocked (config loading)" and an alternate full run had "three
unrelated Windows process-cleanup failures" (vitest worker child-process teardown under
the sandbox). This is a different sandbox surface than D129's file-write fix (--add-dir
cannot help; it's process/config behavior, not paths). Two consecutive honest turns have
now ended blocked on exactly this.

## Key architectural fact to exploit (verify, then use)

Tandem already has TWO verification layers that run OUTSIDE the Codex sandbox:
1. The orchestrator's authoritative verification runner (D97,
   `src/orchestrator/verification.ts`) executes the plan's verification commands via
   Tandem's own bashTool in the UNsandboxed Tandem process after the worker returns -
   this is why the earlier takeover's recorded verifications genuinely passed (375 tests)
   even while in-sandbox runs failed.
2. The OPPOSITE executor's VALIDATE phase re-runs typecheck + full `npm test` + diff
   checks before any candidate is accepted as stable - also outside the producing
   sandbox.

So the full suite IS being run - twice, by ground-truth mechanisms - even when the
in-sandbox model cannot run it. Requiring a third, in-sandbox full run adds no integrity
and is the thing that cannot work on Windows.

## D130-1: amend the protocol's per-turn verification requirement

Change PROTOCOL.md (and the TANDEM.md turn instructions if they repeat it): inside a
sandboxed executor turn, the model must run typecheck, `git diff --check`, and FOCUSED
tests for the files it changed (all of which work in-sandbox); the FULL `npm test`
requirement is satisfied by (a) the plan's verification commands executed by the
authoritative runner outside the sandbox, and (b) the peer executor's VALIDATE full run,
which remains unchanged and mandatory before stable advances. Make sure epic plans'
verification lists include the full-suite command so the authoritative runner actually
executes it (W0010's plan already does - `npm --prefix ... test`). The model must still
NEVER weaken/skip tests it can run; this only relocates the full-suite execution to the
layers that can run it. State this rationale in the protocol so future readers know why.

## D130-2: unstick and complete the W0010 Step 1 turn

With D130-1 in place, resume the interrupted turn cleanly: the same role (A) should
RESUME, re-verify the preserved work per the amended requirements (typecheck + focused
tests + diff check in-sandbox), commit the single `relay:` candidate for Step 1
(preserved files above; verify the plan checkbox update is included), and Complete. Then
let/have B validate it (B's VALIDATE full-suite run happens outside the producing sandbox
and should pass - the D129 acceptance already showed 375+ tests passing on this
worktree's lineage). If the preserved changes have a genuine defect that surfaces during
this, report it honestly rather than forcing it through. The relay was left with a
pending pause-after-turn from me - clear/honor it appropriately (the turn completing and
then pausing is FINE; report the end state either way and leave resume-or-not to the
human).

## D130-3: investigate the "three Windows process-cleanup failures" once, briefly

In the alternate full run the model attempted, three failures were "unrelated Windows
process-cleanup" - determine (from the session log
`state/executor-a/sessions/d029c3483314/c9125eac-....jsonl` or by one reproduction
attempt in-sandbox) whether these are purely sandbox-environment artifacts (expected;
document and move on) or a real flake in the suite that could also bite the OUTSIDE
runs (would matter; fix or file). Do not sink hours here - one clear answer either way.

## Acceptance

Protocol/TANDEM.md amendments quoted in the marker. W0010 Step 1 candidate committed and
peer-validated (paste the relay state transitions and B's validation evidence), board
showing completed=1 next=2/2. The D130-3 answer stated plainly with evidence. tsc +
`npm test` green in the admin repo (run OUTSIDE any sandbox as usual). Leave the relay
in whatever safe state the flow lands in (paused or idle) and say which - do NOT
kickstart step 2; the human decides when to continue. Commit `D130-<n>:` for admin-repo
changes. Create `handoffs/D130_done.txt`.
