# Handoff D198 (D197's instruction-freshness fix is wired but empty: no TANDEM.md exists at the admin-repo override root, so Executor A still reads copy-b's stale, retired-command instructions)

## Why D197 is not approved

D197's watchdog fix and schedule removal are correct and verified (watchdog tick
now calls read-only `auditOrchestratorStatus`, not the retired supervisor path;
`copy-a`/`copy-b` `schedules.json` are `[]` with dated backups). The W0023 drift
was handled safely (stashed, requeued, `copy-b` left clean).

**But the round's actual purpose — stopping Executor A from reading stale
instructions — does not work.** `TANDEM_PROJECT_INSTRUCTIONS_ROOT` is correctly
plumbed (`start-reciprocal-tandem.ps1` sets it to the admin repo;
`readProjectInstructions` in `src/session/project-memory.ts` checks that root
first), but **no `TANDEM.md`, `AGENTS.md`, or `CLAUDE.md` exists at the admin
repo root** (`C:\Users\huizh\Apps\HZ code`) — verified directly, none of the
three files are present. Since `readProjectInstructions` only prefers a root if
it actually contains one of those files, the override is a no-op today: it falls
straight through to `copy-b`'s `TANDEM.md`, which was verified to still instruct
Executor A to run
`powershell ... reciprocal-relay.ps1 -Action Claim -Role A` and the other retired
actions (Pause/PassiveTest/PrepareAUpgrade) — exactly the commands D196/D197
disabled. A freshly-launched Executor A session today gets the same stale
instructions as before D197. The only improvement is that the disabled action
now fails loudly instead of Executor A working around it — real progress, but not
what this round required.

Secondary, non-blocking: the dashboard's manual "Kickstart" button
(`server.mjs` line ~2241) still calls `runSupervisorController` →
`continue-reciprocal-automation.ps1`, the retired path. It fails closed if
clicked (not unsafe) but should be retired or repointed along with everything
else.

## Fix

1. **Create and maintain real, current instructions at the admin-repo root** —
   this is the missing piece, not a plumbing change. Options (pick one, justify):
   - Author `TANDEM.md` at the admin repo root describing the D196/D197
     orchestrator-driven flow directly (the source of truth), and have
     `process/reciprocal/TANDEM_EXECUTOR_A.md`/`TANDEM_EXECUTOR_B.md` either be
     generated from it or kept trivially in sync (e.g. one is a symlink/copy of
     the other, checked by a regression); or
   - Generate the admin-root `TANDEM.md` at executor-launch time
     (`start-reciprocal-tandem.ps1`) from `process/reciprocal/*.md`, so there is
     exactly one authored source and the served file is always freshly derived,
     never hand-duplicated.
   Whichever you choose, the content must correctly describe the CURRENT
   orchestrator flow (no references to `Claim`/`PassiveTest`/`PrepareAUpgrade`/
   `CompleteAUpgrade` as things Executor A should run — those are retired).
2. **Prove it live, not just via `/status` echoing the env var.** The acceptance
   test is: read what `readProjectInstructions` actually RETURNS for a session
   launched against a worktree deliberately pinned behind admin master, and
   assert its content matches current admin-repo instructions, not the stale
   worktree's. A passing `/status.projectInstructionsRoot` check alone (what
   D197 verified) does not prove this — it only proves the env var was set.
3. **Retire the Kickstart button's call to the legacy path** the same way the
   tick was fixed — either remove the button/action or repoint it at a safe
   orchestrator-status action.
4. **Regression**: a fixture where `cwd` (the worktree) has an intentionally
   stale/wrong `TANDEM.md` and the admin override root has current content;
   assert `readProjectInstructions(cwd)` returns the override content, and that
   its content does not contain any retired command name.

## After the fix

Requeue/resume W0023 (already safely stashed and re-queued by D197) through the
orchestrator's normal claim path, and confirm live that Executor A's actual
working session — not just its `/status` payload — is operating under current
instructions (e.g. it should never attempt `reciprocal-relay.ps1 -Action Claim`
again).

## Constraints

- Do not weaken any LEGACY_DISABLED guard.
- Do not hand-edit copy-a/copy-b's TANDEM.md as the fix — that reintroduces a
  worktree-local file that will drift again. The fix must be structural (admin
  root is authoritative, always current).
- Preserve the W0023 stash exactly as D197 left it unless this round's live proof
  requires resuming it.

## Acceptance

`handoffs/D198_done.txt`: the chosen mechanism for keeping admin-root
instructions authoritative and current; the regression proving content
(not just env var) freshness; Kickstart button disposition; live proof that a
real Executor A session reads current, non-retired instructions from the admin
root despite its own worktree being stale. tsc + `npm test` green. Commit
`D198-<n>:`. Create `handoffs/D198_done.txt`.
