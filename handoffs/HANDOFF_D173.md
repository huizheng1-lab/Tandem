# Handoff D173 (Durably propagate D171/D172 into Reciprocal branches and deployable dashboard source)

## Objective

D171/D172 repaired the live approval controller and proved the repair, but the result is
only partially durable:

- local `master` contains D171/D172 (including relay commit `1bbf244` and D172 evidence);
- both Reciprocal worktrees remain at
  `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1` and do not contain D171;
- both pinned Executor runtime BUILD_INFO files remain at `ead38ad`;
- the operational dashboard lives at
  `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard`, outside Git. D171/D172 changed
  its `server.mjs`, `lib.mjs`, tests, and harness, but only hashes/evidence are tracked.

Make the source and deployment path durable. Do not implement W0027, do not change the
Telegram product behavior, and do not silently promote a new Executor runtime.

## Current state to preserve

- relay: `phase=idle`, `activeRole=null`, `nextRole=A`;
- stable and current executor runtime source SHA:
  `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`;
- W0026: `DONE` at `ead38ad`;
- W0027: `QUEUED` and must remain unclaimed in this round;
- local `master` contains D171/D172 and is ahead of `origin/master`;
- `codex/reciprocal-a` and `codex/reciprocal-b` are both at `ead38ad`.

There is an unrelated modified tracked file in the admin worktree:
`scripts/setup-reciprocal-tandem.ps1`, plus existing untracked user files. Preserve
all of them. Do not reset, stash, delete, or include unrelated changes in a commit.

## Required work

### 1. Put the dashboard controller under version control with a safe deploy path

Create one clearly named, tracked canonical dashboard-source directory in this
repository. It must contain every source-controlled dashboard file required to recreate
the controller, including at minimum:

- `server.mjs`, `lib.mjs`, and their tests/harnesses;
- dashboard `public/` assets;
- supported dashboard launch/watchdog/stop scripts and documentation that are needed to
  operate it.

Do **not** copy logs, PID/state/automation data, tokens, candidate user data, executor
state, or other machine-specific runtime data into Git.

Add a tracked deployment script that:

- deploys only an explicit managed-file manifest from the canonical source into
  `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard`;
- validates managed source files before replacing live files;
- stages/copies in a recoverable manner and does not delete unmanaged runtime data or
  historical logs;
- supports a non-mutating dry-run/verification mode;
- records or verifies a manifest of content hashes so the live dashboard can be proved
  to match the committed canonical source;
- restarts/reloads the dashboard only through its supported controller path, after a
  successful deploy, and verifies the loopback `/api/status` endpoint afterward.

The `TANDEM_DASHBOARD_TEST_HARNESS=1` behavior added for D172 must remain test-only and
must be inert in normal dashboard operation.

### 2. Reconcile D171/D172 into both Reciprocal worktrees safely

After committing only the D173 dashboard-source/deployment files, use the existing
guarded main-update/reconciliation workflow to advance `master`, push normally (never
force-push), fast-forward both `codex/reciprocal-a` and `codex/reciprocal-b`, and
reconcile relay stable state.

Before any state-changing integration action:

- capture `git status`, relay status, both worktree heads, and both runtime BUILD_INFO
  values;
- run the workflow's preflight/dry-run if available;
- confirm the local admin worktree's unrelated dirty files will remain untouched.

If the guarded workflow refuses to proceed because of unrelated user changes, do not
work around it with reset, stash, force, manual branch rewriting, or an untracked-copy
hack. Complete the dashboard-source/deployment portion, then report the exact single
human action needed to clear the integration precondition and leave the relay/worktrees
unchanged.

If the guarded workflow succeeds, prove both worktrees contain D171's
`scripts/reciprocal-relay.ps1` change and D172's tracked evidence/harness commit.

### 3. Runtime boundary: prepare, do not silently promote

Do not rebuild, copy, restart, or promote the pinned Executor A/B runtime as part of
this round merely to claim D171/D172 are incorporated. The human runtime review gate
remains required.

If source reconciliation succeeds, create only the normal reviewable/runtime-update
readiness evidence required by existing workflow (if any), and state clearly whether a
new candidate preview is needed. Leave a runtime upgrade as a human-visible approval
step; do not invoke `promote-reciprocal-runtime.ps1` against the live executors.

### 4. Regression and deployment proof

Run the canonical dashboard source's D172 integration harness after deployment and
prove it still uses only isolated fixtures. Also prove normal dashboard operation does
not enable test doubles:

- no test-harness environment variable in the live dashboard process/configuration;
- live `/api/status` succeeds;
- live manifest verification matches the tracked canonical source;
- relay remains idle during dashboard deployment.

## Required checks

Run and record:

- canonical dashboard `node --check` for server and library;
- canonical D172 `approval-flow.e2e.mjs`;
- canonical dashboard helper tests;
- deployment script dry-run/verification and real deploy verification;
- live `GET http://127.0.0.1:4782/api/status` after supported reload;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

For a successful source reconciliation, additionally record:

- `git log`/ancestor proof that `codex/reciprocal-a` and `codex/reciprocal-b` contain
  D171/D172;
- their exact heads and relay stable SHA;
- confirmation that no runtime promotion command ran;
- W0026 remains DONE and W0027 remains QUEUED.

## Safety constraints

- Never touch or commit the unrelated `scripts/setup-reciprocal-tandem.ps1` change.
- Preserve all unrelated untracked user files.
- No force-push, reset, checkout-discard, stash, or deletion.
- Do not ship logs, secrets, tokens, homes, state, or candidate user data into the new
  tracked dashboard source.
- Do not alter W0026/W0027 or run any wishlist implementation.
- Do not promote/restart live executor runtimes; dashboard reload is allowed only via
  the supported dashboard path after validation.
- If integration is blocked by preconditions, report it rather than masking it.

## Completion

Commit source/deployment changes with `D173-<n>:` subject(s), then commit
`handoffs/D173_done.txt` separately.

The done marker must include:

- canonical dashboard source location and managed-file manifest;
- deploy dry-run and post-deploy hash proof;
- live status and test-harness-disabled proof;
- exact main-update/reconciliation result or exact guarded blocker;
- worktree/relay/runtime SHAs before and after;
- proof no runtime promotion occurred;
- all test results;
- explicit confirmation W0027 was not claimed or implemented.
