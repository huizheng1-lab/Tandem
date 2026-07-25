# Handoff D168 (Reconcile Reciprocal executor worktrees with D167 wishlist split)

## Review verdict

D167 repaired the dashboard/admin copy and moved live wishlist state out of
`control/SHARED_DIRECTION.md`, but it is not complete enough for normal Reciprocal
pickup.

After D167, Executor A picked up the next cycle for `W0022` while both executor
worktrees were still at `1fcc4cc`, and their local `scripts/reciprocal-direction.ps1`
still reads wishlist items from `SHARED_DIRECTION.md`. Because D167 moved the
wishlist to `control/WISHLIST.md`, the active executor could not start `W0022` via
the normal workflow.

Do not implement the Telegram product fix in `W0022` in this round. This handoff is
only for making the D167 storage split usable by the actual Reciprocal executors so
`W0022` can be picked up normally afterward.

## Evidence

- Admin/master is at `05842f2` and includes D167.
- Both executor worktrees were still at `1fcc4cc`:
  - `C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a`
  - `C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-b`
- Admin `scripts/reciprocal-direction.ps1` contains D167 wishlist routing:
  - `Get-WishlistPath` at about line 126.
  - `WISHLIST.md` routing and `wishlistPath` JSON output.
- Executor worktree scripts do not contain `Get-WishlistPath` or the new
  `WISHLIST.md` routing. They still locate wishlist items only inside the control
  file passed as `SHARED_DIRECTION.md`, with the old marker lookup around
  `scripts/reciprocal-direction.ps1:190`.
- Live read-only proof:
  - Running the stale copy-b `reciprocal-direction.ps1 -Action Show -ControlPath
    C:\Users\huizh\Apps\Tandem Reciprocal\control\SHARED_DIRECTION.md` returns only
    durable shared direction, not the wishlist board.
  - Running the D167 admin script with the same control path returns
    `control/WISHLIST.md`, including `W0022` as `QUEUED`.
- Executor A session log reported the concrete failure:
  - Claim succeeded for turn 13 with `phase=working`, `activeRole=A`,
    `baseCommit=1fcc4cc`.
  - Mandatory start failed:
    `scripts/reciprocal-direction.ps1 -Action Start -Id W0022 -Role A` returned
    `Expected exactly one wishlist item W0022; found 0`.
  - The worker correctly concluded that the D167 wishlist split exists on master but
    not in the producing worktree script, then blocked without changing files.

## Required work

### 1. Make D167 infrastructure active in the executor runtime/worktrees

Ensure the Reciprocal executor worktrees and/or runtime scripts used by `Claim`,
`Start`, `Candidate`, `Complete`, rejection follow-up creation, and dashboard status
all use the same D167 wishlist split contract:

- Durable human direction remains in `control/SHARED_DIRECTION.md`.
- Live wishlist/progress state is read and written from `control/WISHLIST.md` or the
  chosen D167 work-state store.
- No active executor path should require `<!-- wishlist-items -->` to exist inside
  `SHARED_DIRECTION.md`.

Use the safest repo-consistent approach. Acceptable approaches include:

- update/reconcile the executor worktrees to a commit containing the D167
  infrastructure before they are allowed to claim work; or
- make the relay/bootstrap scripts copy/synchronize the D167-safe control scripts
  into active executor worktrees before starting a cycle; or
- another bounded protocol-compatible mechanism that proves a worker cannot claim
  `W0022` with stale wishlist tooling.

Do not manually mark `W0022` in progress as a workaround. The normal
`scripts/reciprocal-direction.ps1 -Action Start -Id W0022 -Role <A|B>` path must work.

### 2. Restore the relay to a safe queued state

Because Executor A already claimed a turn and blocked without producing a candidate:

- leave the relay in a safe state where the next cron or Kickstart can try again;
- preserve `W0022` as the first queued item;
- preserve `W0016` queued behind `W0022`;
- do not mark `W0022` done, candidate, or completed;
- do not promote, integrate, push, or build any product fix for `W0022`.

If the active blocked turn needs to be paused, completed as blocked, reset, or
repaired by the relay's supported commands, do so using the existing protocol-safe
commands and document exactly what was done.

### 3. Preserve text encoding in the work-state board

While reviewing D167, `control/WISHLIST.md` displayed mojibake in the `W0022`
rejection text, for example `leaderÃ¢â‚¬â„¢s` and `Ã¢â‚¬Å“HiÃ¢â‚¬Â`.

Fix the storage/read/write path so future rejection comments preserve UTF-8 text
without mojibake. If the original `W0022` text can be recovered from logs, repair the
existing W0022 line to readable text. If exact recovery is not possible, normalize
only the visibly corrupted punctuation/quote sequences in W0022 to readable ASCII or
UTF-8 equivalents without changing the substantive task text.

Keep this encoding repair scoped to the Reciprocal control/wishlist/rejection
workflow. Do not implement the Telegram answer product fix.

## Required checks

Run focused checks proving:

- In both active executor worktrees, `scripts/reciprocal-direction.ps1 -Action Show
  -ControlPath C:\Users\huizh\Apps\Tandem Reciprocal\control\SHARED_DIRECTION.md`
  returns the wishlist board from `control/WISHLIST.md`, not just durable shared
  direction.
- In the active executor worktree that will pick up the next turn,
  `scripts/reciprocal-direction.ps1 -Action Start -Id W0022 -Role <active role>`
  can find `W0022` in the new work-state store. If this check mutates W0022 to
  `IN_PROGRESS`, immediately restore it through the supported reciprocal workflow so
  the final state remains queued for the next real pickup, and document the proof.
- `control/SHARED_DIRECTION.md` still contains no specific issue IDs, no
  `<!-- wishlist-items -->`, no `## Wishlist`, and no `## Removed`.
- `control/WISHLIST.md` contains readable text for `W0022`, with no visible mojibake
  sequences such as `Ã¢`, `â€™`, `â€œ`, or `â€`.
- `/api/status` succeeds within 5 seconds and reports a concrete relay phase, stable
  commit, and `direction.nextQueuedItem.id == "W0022"`.
- A worker cannot claim a turn with stale pre-D167 wishlist tooling. Prove this with
  a focused unit/integration test or an explicit runtime version guard.

Also run:

- relevant dashboard/reciprocal focused tests;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## Completion

Commit implementation changes with `D168-<n>:` subject(s). Commit the done marker
separately as `handoffs/D168_done.txt`.

In `D168_done.txt`, include:

- exact method used to reconcile executor worktrees/runtimes with the D167 wishlist
  split;
- before/after commit or version for copy-a and copy-b;
- proof that stale `SHARED_DIRECTION.md` wishlist parsing is no longer used by active
  executor paths;
- proof that `W0022` remains first queued and `W0016` remains queued behind it;
- proof that `W0022` text is readable and future rejection comments preserve UTF-8;
- `/api/status` response summary after repair;
- test commands and results;
- explicit confirmation that the Telegram product fix itself was not implemented,
  built, promoted, integrated, pushed, or marked done in this infrastructure round.
