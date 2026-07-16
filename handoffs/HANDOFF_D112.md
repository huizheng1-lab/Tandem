# Handoff D112 (commit the uncommitted D109-D111 work; run the skipped manual desktop check)

REVISED 2026-07-15 19:56: the original D112 draft had three items. Two of them were fixed by
D111's completion (which landed minutes after the original draft): the `main.tsx` duplicate
truncated `return (...)` compile break is gone (I re-verified `npx tsc --noEmit` is now
clean myself), and the D111 regression tests now exist and pass (I re-ran `npm test`:
359 passed / 1 skipped). Those items are closed - do not redo them. What remains:

## D112-1 (the actual point of this round): COMMIT the work

Three rounds of real, reviewed functionality - D109 (global cross-project session listing),
D110 (empty-session pruning + `project.json` ownership sidecar), D111 (legacy-directory
pruning fallback + unresolved-session UI safety) - are all still sitting as UNCOMMITTED
working-tree edits on top of HEAD (61a555e, D108-2). All three completion markers say some
variant of "Changes applied as working-tree edits (no new commit)". This has already caused
real damage once: an interrupted edit corrupted `main.tsx` into a non-compiling state with
no committed checkpoint to diff against or roll back to.

Commit the combined D109+D110+D111 work now. One commit or a few sensible ones - the
priority is that it stops being uncommitted, not perfect after-the-fact history separation.
Scope the commit(s) to the actual feature files:

- `src/session/store.ts`
- `app/main/tandem-service.ts`
- `app/renderer/src/main.tsx`
- `app/renderer/src/session-state.ts`
- `tests/session-store.test.ts`
- `tests/desktop-service.test.ts`
- `tests/renderer-session-state.test.ts`
- the `handoffs/D109_done.txt` / `D110_done.txt` / `D111_done.txt` markers

Do NOT sweep in unrelated dirty state sitting in the same worktree (e.g.
`scripts/reciprocal-direction.ps1`, `IMPROVEMENT_SUGGESTIONS.md`, `.reviewer-*.mjs` scratch
files, or the large old root-level `D*_done.txt`/`HANDOFF_*.md` deletions from the earlier
handoffs-folder migration) - review `git status` before committing and stage deliberately,
not with a blanket `git add -A`.

Standing rule from this round onward, non-negotiable: every round ends with a real
`git commit` of its own work, and no `_done.txt` completion marker is ever created for
uncommitted work. This was the discipline for 100+ prior rounds; D109-D111 broke it.

## D112-2: run the manual desktop check that D109, D110, AND D111 each skipped

Every one of the three handoffs requested a manual desktop verification; every one of the
three markers either says "not run in this session" or is silent about it. Run it now:

1. Launch Tandem desktop (`npm run dev:app`, or rebuild the package if that's the workflow).
2. Confirm sessions from a different project folder (e.g.
   `C:\Users\huizh\tmp_test_data\three kingdoms`) appear in the global sidebar list
   alongside the current project's sessions, each labeled with its owning project path.
3. Click a session from a different project; confirm Tandem switches to that project folder
   and resumes the session.
4. Confirm old empty sessions do not clutter the list.
5. If any session lacks a recoverable projectDir, confirm it shows the
   "unresolved project - cannot resume from global list" label with all four actions
   (resume/rename/archive/delete) disabled - not silently clickable-but-broken.

Report what you actually observed for each numbered step - real observations, not "passed."

## Acceptance

`npm run typecheck` clean (paste real output), `npm test` green, `git diff --check` clean.
`git log` shows the new commit(s) containing the D109-D111 work with the feature files
listed above. `git status` afterwards shows those files no longer modified. Manual desktop
check observations written out per step. Commit `D112-<n>:`, create
`handoffs/D112_done.txt` including the real commit hash(es).
