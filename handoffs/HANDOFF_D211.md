# Handoff D211 (serialize GitHub-sync state updates and prove polling cannot erase progress)

## Review disposition

D210 commits `6c29268d246396fa134f3c6a13fcfb255a1611eb` and
`f2dc6a9b5ad02b75ef3f5b767e2cbd3964ad19a8` are **not approved**. The focused
tests, node checks, typecheck, full test suite, deployment parity, and live
read-only checks pass. Correct only the durability race below and preserve all
unrelated work.

## Confirmed gap

`writeGithubSyncState()` in
`dashboard-source/reciprocal-control-panel/server.mjs` performs an
unsynchronized read/modify/write of the whole sync-state document. At the same
time, every fresh remote probe calls `rememberRemoteProbe()`, which writes
through that same function. The D210 browser intentionally polls `/api/status`
every 700 ms while a sync is running. A status probe and a lifecycle write can
therefore both read the same prior document and complete out of order; the
probe can replace a newer `requested`, `validating`, `fetching`, `pushing`, or
terminal state/history with stale data. Atomic file replacement does not
prevent this lost-update race.

The D210 concurrent-request regression covers duplicate POST requests, but it
does not poll `/api/status` concurrently with the active operation and does not
prove lifecycle history survives those writes.

## Corrective work

1. Serialize or otherwise make all GitHub-sync state updates lossless within
   the dashboard process. Lifecycle writes and remote-probe/cache writes must
   merge against the latest committed state in a deterministic order.
2. Preserve the existing atomic-file durability behavior, bounded history,
   secret sanitization, duplicate-request locking, and read-only status API.
3. Add a focused regression that deliberately overlaps repeated `/api/status`
   remote-probe updates with an active sync operation. Make the overlap
   deterministic rather than timing-only.
4. Prove the final durable document and API-visible state retain exactly one
   ordered lifecycle path through `requested`, `validating`, `fetching`,
   `pushing`, and the correct terminal state, with the latest remote probe and
   SHA evidence also retained.
5. Add a failure-path overlap case proving concurrent status polling cannot
   erase the terminal `failed` state or its sanitized error.
6. Deploy only through `scripts/deploy-reciprocal-dashboard.ps1`, then verify
   source/deployed hashes and live read-only status. Do not invoke a live sync
   or push GitHub merely for proof.

## Safety constraints

- Never push, force-push, rewrite, or delete any real remote ref during tests
  or live verification. Use isolated local bare remotes for all push tests.
- Do not weaken any D196/D210 stable-boundary, idle, lock, pause/recovery,
  operation-evidence, build-info, runtime-integrity, or fast-forward guard.
- Do not checkout, merge, stash, clean, stage, commit, delete, or alter
  unrelated user worktree/index files.
- Preserve D207-D210 behavior outside this narrow state-update correction.

## Acceptance

Create `handoffs/D211_done.txt` containing:

- corrective commit SHA(s) and exact files changed;
- focused overlap-test names/results and proof all remotes are isolated local
  bare repositories;
- durable success and failure lifecycle/history evidence under concurrent
  status polling;
- `node --test dashboard-source/reciprocal-control-panel/approval-flow.e2e.mjs`;
- `node dashboard-source/reciprocal-control-panel/lib.nodecheck.mjs`;
- `npm run typecheck`, `npm test`, and `git diff --check` results;
- source-vs-deployed SHA-256 equality and live read-only status proof;
- explicit confirmation that no test or verification contacted or pushed real
  GitHub.

Use commit subject prefix `D211-<n>:`.
