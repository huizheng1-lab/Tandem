# Handoff D131 (sandbox denies git commit from linked worktrees - extend writable roots to the common git dir needs)

Third and hopefully final member of the sandbox-gap family (D129: relay-state writes;
D130: full-suite verification; now: git itself). Found during the FIRST fully-unattended
turn - which otherwise worked: executor B's schedule claimed W0010 Step 2 at :37 with no
injection, Start succeeded, the implementation was completed and verified in-sandbox, and
then: `"sandbox denied git index.lock write needed to stage and commit"`. I requested
pause-after-turn; relay has a pending pause. Step 2's work should be preserved in
`worktrees/copy-a` (verify - if the turn's changes are uncommitted there, do not lose
them; there should also be a recovery checkpoint per protocol).

## Why this happens (git architecture, not a mystery)

For a LINKED worktree, `git add/commit` writes almost nothing inside the worktree: the
index and its lock live in the admin repo's common git dir
(`C:\Users\huizh\Apps\HZ code\.git\worktrees\copy-a\index[.lock]`), commit objects go to
`.git\objects\...`, and branch updates touch `.git\refs\heads\...`/`packed-refs`. D129
deliberately granted only `control\`, `.git\tandem-relay`, and `.git\refs\tandem-relay` -
none of the paths `git commit` needs. Step 1's commit never hit this because the D130
recovery was conducted from OUTSIDE the sandbox; this unattended turn is the first fully
sandboxed commit attempt.

## D131-1: extend TANDEM_CODEX_WRITABLE_ROOTS appropriately

Pick the least-privilege set that actually covers git's real write surface - but don't
fragment it into a brittle list of five subpaths if git's behavior (packed-refs
rewrites, gc, reflogs) makes that unreliable. Pragmatic recommendation: grant the whole
common git dir `C:\Users\huizh\Apps\HZ code\.git` to the reciprocal executors (it is
still FAR narrower than the admin repo working tree - source files remain unwritable,
and `protection.ts` continues to block Tandem-tool-level writes independently; the relay
protocol's own rules still forbid ref rewriting outside the prescribed commands, and
ff-only sync + peer validation remain the integrity gates). If you instead find a
reliable narrower set (e.g. `.git\worktrees\<own-target>`, `.git\objects`,
`.git\refs\heads`, packed-refs), justify it and prove it against ALL the git operations
a turn performs (add, commit, the relay scripts' update-ref/ff merges, direction-board
mutations). Update `start-reciprocal-tandem.ps1`'s root list; keep the env-var opt-in
design unchanged (normal Codex runs unaffected). Update the D129 notes in
PROTOCOL.md/README if they enumerate the roots.

## D131-2: complete W0010 Step 2 and prove the WHOLE turn unattended

After the fix: restart executors with the new roots (stop/start via the existing safe
paths - respect the pending pause state), resume the relay, and this time let the
schedule do EVERYTHING: B resumes/claims, commits Step 2, Completes; A validates on its
own :07 tick; stable advances; board shows completed=2/2 and the epic completing
(CANDIDATE->DONE per the D126 final-step flow). NO automation-endpoint injection, NO
manual conducting - if any manual nudge proves necessary, that's a finding to report,
not to hide. This is the acceptance test the whole reciprocal system has been building
toward: one complete step implemented, committed, validated, and accepted end-to-end
with zero human/conductor involvement after the resume.

## D131-3: sweep for remaining sandbox write surfaces (once, briefly)

We've now paid three separate rounds for the same class of bug. Do one deliberate audit
pass: enumerate everything a full turn lifecycle writes OUTSIDE the target worktree
(relay scripts, direction board, git plumbing, checkpoint files, epic plan file - that
one IS in the worktree, npm/vitest caches, TANDEM_HOME session logs - those are written
by the Tandem app process, not the sandboxed codex child, confirm) and check each
against the writable-roots set. State the enumeration in the marker so the next gap - if
any - is caught on paper instead of by another burned turn.

## Acceptance

Marker includes: the chosen roots and why; the git-surface enumeration from D131-3;
evidence Step 2's preserved work was used (not redone from scratch, unless genuinely
necessary - say which); and the full unattended sequence evidence - relay state
transitions with timestamps showing schedule-driven claim -> commit -> Complete ->
peer VALIDATE -> Accept/AcceptStep -> epic completion, with no injection (the
automation audit log's absence of /prompt calls during the window is good negative
evidence). tsc + `npm test` green in the admin repo. Leave the relay paused or idle at
the end and say which; do not start new wishlist work. Commit `D131-<n>:`. Create
`handoffs/D131_done.txt`.
