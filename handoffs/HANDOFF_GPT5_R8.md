# Handoff to GPT-5 — Round 8 (one bug: git fast-path shadows the snapshot diff)

Context: Live run 10 PASSED (approve 5/5/5, no takeover, costs recorded) and R7-2's reviewer
hardening demonstrably worked. But the reviewer still received an empty diff and had to inspect
files manually. Root cause: in `src/orchestrator/diff.ts`, the tracker prefers the git fast-path
whenever cwd is inside a git work tree. The live test's `demo-todo/` is inside the Tandem repo
AND gitignored, so `git diff` + untracked both come back empty, and the R7-1 snapshot scan —
which would have shown everything — is never consulted. Your R7-1 unit test used a temp dir
outside any git repo, which is why it passes while the live path fails.

## R8-1: Snapshot scan must win when it has data
Change the precedence in the diff tracker: if a before-snapshot exists for this round, produce
the scan-based diff; use the git fast-path only when no snapshot was taken (e.g. plain
`workingTreeDiff` calls from non-tracker callers). Alternative acceptable design: compute both
and return the git diff only when non-empty, falling back to the scan diff. Either way, add a
unit test that reproduces the live failure exactly: temp dir → `git init` → create subdir → add
it to `.gitignore` → tracker beforeBuild → write a file in the subdir (plain fs) → assert
`diff()` output contains the new file's content.

## Acceptance
tsc + `npm test` green; commit `R8-1: <summary>`; honest completion-report update. The reviewer
will run the live smoke test and expects the review-phase diff to be NON-empty (the reviewer's
summary should no longer mention an empty diff).
