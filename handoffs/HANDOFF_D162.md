# Handoff D162 (Reciprocal leaves completed or rejected wishlist work stuck in QUEUED and needs a human to repair the board)

## The gap (confirmed live; preserve the evidence)

The W0020 review-only build exposed a lifecycle hole in Reciprocal rather than a
product-code failure:

- W0020 was a P0 human wishlist item whose whole objective was to package local
  `master` commit `feed4343ec17e79cb8398c069120c100c7b2f1be` into the canonical
  Candidate Preview, verify `BUILD_INFO.json`, smoke-launch `Tandem.exe`, and leave
  the preview for human review without promoting either pinned executor runtime.
- Executor A successfully built the preview. `BUILD_INFO.json` identified `feed434`,
  the launch smoke passed, typecheck passed, and the full suite later reported 471
  passing tests. No source commit was expected or appropriate for this artifact-only
  task.
- Despite that success, W0020 remained `QUEUED`. The relay remained `working` with
  active role A and repeatedly returned `RESUME`; after three retries it auto-paused.
  The executor could not cross the normal app-layer completion boundary because the
  existing Reciprocal candidate path assumes a non-empty `filesChanged` list and
  exactly one new source commit. A denied Computer Use visual-inspection permission
  was then reported as `blocked`, even though producing a preview for *human* review
  was W0020's requested terminal outcome.
- The human rejected the `feed434` preview with a concrete comment. The dashboard
  correctly created W0021 from that comment, but it did not retire or complete W0020
  and did not safely close the stale working turn. W0020 and W0021 therefore both
  appeared as P0 `QUEUED` items until a separate human operator manually archived
  W0020 and abandoned the clean, commit-free turn.

The user requirement is explicit: **Reciprocal must own these status transitions.
It must not require Codex or another human operator to clean up the wishlist or relay
after every build/review.** W0021 is currently the real P0 follow-up. W0016 remains a
separate P1 plan-approved epic at completed 2/3 and must not be consumed or modified
by this workflow repair.

## Root cause to verify

Trace and document the complete path before changing it:

1. `src/reciprocal/candidate-commit.ts` currently returns early unless the report is
   `complete` **and** `filesChanged.length > 0`; the ordinary guarded completion path
   stages files, creates a `relay:` commit, marks a wishlist item `CANDIDATE`, and
   advances the relay. Confirm how this interacts with an artifact-only report and
   with a report containing only the ignored reciprocal checkpoint.
2. `scripts/reciprocal-relay.ps1 -Action Complete` requires exactly one new commit.
   Confirm that no supported relay action currently closes a verified, clean,
   commit-free artifact-only turn.
3. `dashboard/server.mjs` rejection handling creates/deduplicates the rejection
   wishlist and only releases relay states recognized by
   `rejectedCandidateRelayAction`. Confirm why the W0020 `working`/later `paused`
   state and originating queued item were not retired.
4. Confirm why W0020 never reached `IN_PROGRESS` even though it was selected and
   executed. Do not rely on the model remembering to run `Start`; make the guarded
   app-layer lifecycle authoritative wherever practical.

Do not merely special-case the IDs W0020 or W0021, the SHA `feed434`, or text such as
"Candidate Preview". Implement a reusable, explicit lifecycle.

## Required behavior

### 1. Explicit artifact-only completion path

Add a guarded way for Reciprocal to complete a human wishlist item whose requested
output is an external/review artifact and intentionally has no source commit. The
worker may choose the exact API/metadata design, but it must be explicit (for example
an item kind/capability or a guarded completion action), not inferred from prose.

The path must:

- identify one exact wishlist item and ensure it is owned by Executor A;
- ensure the relay is `working`, `activeRole=A`, and its HEAD still equals the turn's
  base/stable commit;
- require a clean producer worktree and a validated `complete` report;
- require machine-checkable artifact provenance/evidence appropriate to the declared
  task (for a Candidate Preview, exact source SHA in `BUILD_INFO.json`, executable
  existence, and a terminating launch smoke result);
- transition the wishlist item out of `QUEUED`/`IN_PROGRESS` automatically;
- close the relay turn cleanly to `idle` without manufacturing an empty commit,
  advancing the trusted stable ref, or promoting a runtime;
- preserve an auditable completion record that distinguishes "artifact produced for
  human review" from "source candidate accepted";
- treat the preview being available for human inspection as successful completion of
  the build task. Computer Use permission is not required when the requested outcome
  is explicitly to leave the preview for the human to inspect.

If the cleanest semantics are to mark the build item `DONE` when the verified artifact
is produced, do that. If a distinct review-ready status is introduced, the dashboard
must render it clearly and the subsequent review must deterministically retire it.
In either design, it must never remain `QUEUED` after successful execution.

### 2. Rejection must atomically retire the reviewed origin

When a human rejects a candidate/preview:

- record the review first-class as today;
- create or reuse exactly one P0 wishlist follow-up containing the full rejection
  comment and `[review-rejection:<sha>]` marker;
- locate the originating wishlist item through explicit persisted metadata, not a
  fragile text search;
- ensure the originating item cannot remain `QUEUED`, `IN_PROGRESS`, or `CANDIDATE`
  after the rejection. A previously completed artifact-build item may remain `DONE`;
  otherwise archive/retire it with an audit note naming the follow-up ID;
- safely release or close all legitimate no-commit relay states associated with that
  origin, including `working` and auto-paused-from-`working`, while refusing if HEAD
  moved, the worktree is dirty, another item owns the turn, or a source candidate/
  rollback is pending;
- leave the relay `idle`, with no active owner, so W0021 can be claimed at the next
  `:07/:37` cron without a manual Resume/Abandon sequence;
- be idempotent. Repeating the rejection request must not create another wishlist
  item, retire unrelated work, or replay a relay transition.

The review write, origin retirement, follow-up creation, and relay release should be
ordered/transactional enough that a failure is visible and recoverable; do not report
success while leaving half-applied state silently behind.

### 3. Ordinary source wishlist lifecycle must remain automatic

W0021 is expected to produce real source changes. Prove the normal path still performs
the full lifecycle without a human operator:

`QUEUED -> IN_PROGRESS -> CANDIDATE -> DONE` after independent validation and human
acceptance, with the relay transitions and review metadata consistent at every step.

Do not implement W0021's Telegram UX/product request in D162. D162 repairs the
workflow so the worker that later claims W0021 can update its own status correctly.
Do not start W0016 step 3, alter its completed count, or merge its scope into W0021.

## Safety constraints

- No force push, destructive reset, fabricated source commit, automatic runtime
  promotion, or automatic master/GitHub integration.
- Runtime promotion and main-branch integration remain human-gated.
- Never auto-close a turn with uncommitted changes or a HEAD different from its base.
- Never retire a wishlist item based only on matching free-form text or priority.
- Preserve the existing rejection comment verbatim (apart from established whitespace
  normalization) and preserve review/audit history.
- Existing source-candidate, rollback, plan-gated epic, resume-loop, and rejection
  safety tests must continue to pass.

## Acceptance tests

Add focused regression coverage proving at least these cases:

1. A declared artifact-only item starts, reports verified completion with zero source
   files, becomes terminal/review-ready, and returns the relay to clean `idle` without
   changing stable or creating a commit.
2. The same action refuses a dirty worktree, moved HEAD, wrong role, mismatched item,
   missing artifact evidence, or non-complete report.
3. Rejecting that preview creates one follow-up, preserves the complete comment,
   retires the exact origin, and leaves the relay idle.
4. Repeating the rejection is idempotent.
5. Rejection refuses to abandon unrelated active work or any turn containing a commit.
6. A normal source item still follows `QUEUED -> IN_PROGRESS -> CANDIDATE -> DONE`.
7. W0016-style plan-approved epic metadata remains unchanged by unrelated review
   cleanup.

Exercise both the script/library logic and the dashboard endpoint behavior. Include a
nodecheck test for pure rejection/origin mapping helpers and Vitest coverage for relay
and direction transitions. Run `node --check` on changed dashboard modules,
`node --test dashboard/lib.nodecheck.mjs`, the focused reciprocal tests,
`npm run typecheck`, full `npm test`, and `git diff --check`.

## Live proof and handoff completion

Use scratch wishlist IDs/data, not W0021 or W0016, for destructive lifecycle proof.
Demonstrate through the real dashboard/API and relay that:

1. a scratch artifact-only item completes with no source commit and does not remain
   queued;
2. rejecting its review creates one follow-up, retires the origin, and leaves the relay
   idle without manual cleanup;
3. the next scheduled/Claim path selects the follow-up normally.

Explain the verified root cause, chosen lifecycle semantics, safety gates, tests, and
live evidence in `handoffs/D162_done.txt`. Commit implementation changes with
`D162-<n>:` subjects, then commit the done file. Do not mark D162 complete merely
because W0020 was manually cleaned up; completion requires the reusable workflow and
regressions above.
