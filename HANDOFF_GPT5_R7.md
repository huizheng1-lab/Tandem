# Handoff to GPT-5 — Round 7 (snapshot diff misses bash-created files)

Context: R6 APPROVED offline (29 tests) and live run 9 completed end-to-end, exercising the live
takeover path for the first time. But the takeover happened for the wrong reason: the reviewer
received an EMPTY diff, scored the (actually good) work 1/1/1, and voted takeover with feedback
"Missing Files. The diff is empty." The worker had created `todo.mjs`/`test.mjs` via the `bash`
tool, and the R3-2 diff tracker in `src/orchestrator/diff.ts` only records paths passed through
`write_file`/`edit_file` (`recordTouchedPath`), so bash-created files are invisible to it.

## R7-1: Make the snapshot diff tracker see all file changes under cwd
Change the tracker's approach from touched-path recording to a directory scan:
- `beforeBuild()`: walk cwd (respecting a sane cap, e.g. 500 files / 256KB per file; skip
  `node_modules`, `.git`) and snapshot file contents.
- `diff()`: walk again, unified-diff changed/new/deleted files against the snapshot (the `diff`
  package is already a dependency). Keep `recordTouchedPath` as a supplemental hint if useful,
  but the scan must be the source of truth.
- Keep the git fast-path for git repos as-is.
Update `tests/diff.test.ts`: add a case where a file is created OUTSIDE the tracker's knowledge
(plain `fs.writeFile`, simulating bash) and assert it appears in the diff.

## R7-2: Reviewer should verify before condemning (prompt hardening)
Run 9's reviewer scored 1/1/1 on an empty diff without reading the files, while earlier runs'
reviewers read the files when the diff looked wrong. Harden `leaderReviewerPrompt`
(`src/agents/leader.ts`): if the diff appears empty or inconsistent with the CompletionReport,
the reviewer MUST inspect the workspace with its read-only tools before choosing a verdict, and
must base takeover/revise decisions on file contents, not diff presence alone.

## Acceptance
tsc + `npm test` green; one commit per task (`R7-<n>:`); honest completion-report update. The
reviewer will re-run the live smoke test and expects the review phase to receive a non-empty diff
and (barring model flakiness) an approve verdict without takeover.
