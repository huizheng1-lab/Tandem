# Handoff D197 (D196's orchestrator is solid, but two old actors are still live at the edges: the dashboard watchdog's continuation-supervisor tick, and Executor A's own injected instructions still come from a stale worktree checkout)

## Live finding (verified — don't re-derive)

Right after D196 landed, two retired actors are still executing:

1. **Dashboard watchdog still runs the old continuation supervisor every 60s.**
   `control/CONTROL_PANEL_AUDIT.jsonl` shows continuous
   `dashboard-watchdog-tick / supervisor.tick, ok:false` entries from 03:29Z
   through 03:47Z (still running as of this writing). D196's
   `TANDEM_ALLOW_LEGACY_RECIPROCAL` guard correctly makes it fail closed, but the
   process itself was never stopped or repointed — it's orphaned, noisy, and a
   leftover moving part D196 was meant to delete.

2. **Executor A is doing real, uncommitted work for W0023 step 3/3 completely
   outside the new orchestrator.** Verified in `copy-b`: modified
   `src/remote-control/bridge.ts`, `telegram-session-stream.ts`, and their tests
   (uncommitted), plus stray `claim-output.json`/`passive-output.json` files at
   the worktree root — the exact artifact signature of the OLD Claim/PassiveTest
   prompt template (redirecting JSON results to files), not anything the new
   orchestrator emits. The wishlist board shows
   `W0023 IN_PROGRESS role=A started=2026-07-24T03:36:50Z` with **no matching
   entry anywhere in `control/orchestrator-operations.ndjson`** (whose last entry
   is `idle.no-work` at 02:39:41Z) and no orchestrator process running. Executor A
   claimed and started this work through the OLD board-mutation path, not the
   orchestrator.

Root cause: `copy-b` (Executor A's actual worktree) is checked out at `efb3b06`,
which predates D196. Whatever mechanism injects Executor A's live TANDEM.md/
instructions is still reading content from that stale checkout — D196's
`TANDEM_EXECUTOR_A.md` rewrite landed only on admin master. This is the same
"instructions lag the checkout" defect class as D190/D192, now hitting the
orchestrator redesign on its very first cycle. No commit has landed and nothing
unsafe has shipped — A's old-path `Complete`/`PassiveTest` calls will simply fail
closed (`LEGACY_DISABLED`) if it gets that far — but real work is happening with
zero test/build/promotion gate around it.

## Fix

1. **Stop the orphaned dashboard-watchdog supervisor tick.** Either have the
   dashboard watchdog stop invoking `continue-reciprocal-automation.ps1`
   altogether (D196 retired it), or repoint its tick at the new orchestrator's
   read-only status only — no mutation calls. Confirm no process keeps calling
   the disabled entrypoint in a loop after the fix.
2. **Make Executor A's live instruction source unable to lag the gate
   infrastructure again**, for real this time — not another one-off path fix.
   Pick one and implement it fully:
   - Inject TANDEM.md/executor prompts from the admin repo at session-start time
     (fetched/copied fresh, not read from whatever the worktree happens to have
     checked out), so a worktree pinned to an old commit can never serve stale
     orchestration instructions; or
   - Have the orchestrator (not a human-typed cron prompt) be the only thing that
     ever starts an Executor A working session, passing the current instructions
     directly rather than relying on the executor to read a file from its own
     checkout.
   Whichever is chosen, add a regression that proves an Executor A session
   spawned while its worktree HEAD is deliberately behind admin master still
   receives current-generation instructions/commands.
3. **Resolve the in-flight W0023 work safely.** Do not silently discard a working
   session's progress. Determine whether the current uncommitted `bridge.ts`/
   `telegram-session-stream.ts` changes are complete and correct on their own
   merits; if so, land them as a normal orchestrator-claimed cycle for W0023 (stash
   the diff, let the orchestrator properly claim W0023, reapply, then let A finish
   and commit through the sanctioned path so it gets real tests/build/promotion).
   If incomplete, stash/preserve it and let the orchestrator's normal claim +
   two-strike retry handle W0023 from a clean base. Do not let uncommitted
   drifted-checkout work reach `git commit` outside the orchestrator's mediation.
4. **Sweep for any other actor still reading from worktree checkouts instead of
   admin master** (schedules.json-equivalent configs, other injected docs) and
   fix or explicitly document why each is safe to leave as-is.

## Constraints

- Do not weaken the LEGACY_DISABLED guards — they're exactly why this incident
  produced no unsafe commit.
- The fix must survive future D-rounds without repeating this exact failure mode;
  a documentation note alone ("remember to update the worktree") is not
  acceptable given this is the fourth occurrence of this class today (D190,
  D192, and now this).
- Do not touch W0023's actual feature logic beyond what's needed to safely land
  or reset the in-flight diff.

## Acceptance

`handoffs/D197_done.txt`: confirmation the watchdog no longer calls retired
entrypoints; the chosen instruction-freshness mechanism with its regression;
disposition of the in-flight W0023 diff and how it was safely preserved/landed;
live proof that a fresh Executor A session with a deliberately-stale worktree HEAD
receives current instructions and correctly routes through the orchestrator. tsc
+ `npm test` green. Commit `D197-<n>:`. Create `handoffs/D197_done.txt`.
