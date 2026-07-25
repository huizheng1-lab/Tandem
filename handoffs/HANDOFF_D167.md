# Handoff D167 (Repair Reciprocal state/status storage boundaries before W0022)

## Review verdict

The human rejected candidate `1fcc4cc`, and the rejection correctly created `W0022`.
However, Reciprocal is now showing `Unknown` relay phase and `Missing` stable version.
This is an infrastructure defect that must be fixed before relying on the next
Reciprocal build cycle.

Do not implement the Telegram product fix in `W0022` in this round. This handoff is
only for repairing Reciprocal's storage/status workflow so `W0022` can be picked up
normally afterward.

## Observed state and evidence

At handoff creation:

- `control/SHARED_DIRECTION.md` contains live wishlist/progress items, including
  `W0022`. That file must not carry specific issues or per-item progress.
- `W0022` is queued and must be preserved exactly as a queued work item.
- Dashboard overview shows Relay Phase `Unknown` and Stable Version `Missing`.
- `GET http://127.0.0.1:4782/api/status` times out.
- `control/dashboard-server.log` repeats
  `RangeError: Invalid string length` at `dashboard/server.mjs:93:52`.
- `C:\Users\huizh\Apps\HZ code\.git\tandem-relay\state.json` is about
  `1,481,039,955` bytes and `Get-Content -Raw` throws `OutOfMemoryException`.
- Executor automation endpoints are alive and idle:
  Executor A `127.0.0.1:4783`, Executor B `127.0.0.1:4784`.

## Required work

### 1. Separate durable human direction from live work state

Make `control/SHARED_DIRECTION.md` contain only stable human-owned direction and
guardrails. It must not include:

- individual wishlist IDs;
- queued/completed item text;
- candidate rejection comments;
- per-item status, commit, phase, or progress metadata;
- removed-item archives.

Move the live wishlist/progress board to a dedicated Reciprocal work-state store.
Choose a repo-consistent design, but it must be explicit and bounded, for example:

- structured JSON for machine state plus a readable markdown projection; or
- a dedicated `control/WISHLIST.md` file plus bounded parser/writer helpers.

Preserve all existing live board content, especially `W0022`, `W0016`, and DONE item
history, without losing IDs, statuses, priorities, review-rejection source SHAs, or
timestamps. If older removed-item history is retained, keep it out of
`SHARED_DIRECTION.md` and do not let it grow unbounded in the status response.

Update every dashboard/relay/rejection/wishlist path that currently reads or writes
wishlist content in `SHARED_DIRECTION.md` so it uses the new work-state store.

### 2. Repair oversized relay state safely

Diagnose why `.git/tandem-relay/state.json` grew to about 1.48 GB. Compact or repair
it without losing the current real relay state.

Safety constraints:

- Before modifying the oversized state file, create a timestamped backup outside the
  live relay path.
- Do not delete the only copy of any state.
- Preserve the current relay facts if recoverable: schema version, turn, next role,
  active role, phase, stable commit, last completed commit, candidate fields, and any
  other small scalar fields needed by the relay.
- Remove or externalize any accidentally embedded huge/log-like payloads.
- The repaired live `state.json` must be small enough for normal bounded reads. Target
  under 256 KB unless there is a clear reason documented in the done marker.

### 3. Make dashboard status bounded and resilient

The dashboard must never try to concatenate or stringify unbounded command output,
state files, session logs, or history into memory.

Fix `dashboard/server.mjs` and any helpers so:

- `/api/status` returns within 5 seconds with healthy state after repair;
- if relay state is corrupt or oversized in the future, status reports a bounded,
  actionable error instead of timing out or throwing `RangeError`;
- dashboard log entries are capped or summarized so repeated failures cannot create
  another runaway file/string;
- stable version and relay phase display from the repaired state.

### 4. Preserve W0022 and resume normal pickup

After the infrastructure repair:

- `W0022` must remain the next queued human work item.
- `W0016` must remain queued behind it with its existing constraint to preserve the
  accepted W0021 baseline.
- Do not mark `W0022` done.
- Do not build, launch, approve, promote, integrate, push, or otherwise implement the
  Telegram product fix in this round.
- If the relay is safe to continue, leave it in the normal state where the next cron
  or explicit kickstart can pick up `W0022`.

## Required checks

Run focused checks proving:

- `SHARED_DIRECTION.md` no longer contains `W0022`, `W0021`, `W0016`, or any
  wishlist/progress table, but still contains the human general direction and
  guardrails.
- The new work-state store contains `W0022` as `QUEUED` and preserves existing item
  IDs/statuses.
- Rejecting a candidate appends a follow-up wishlist item to the new work-state store
  and does not modify `SHARED_DIRECTION.md`.
- `/api/status` succeeds and returns concrete relay phase, stable commit, and next
  queued item.
- A deliberately oversized/corrupt relay state fixture produces a bounded dashboard
  warning instead of an uncaught exception or timeout.
- The repaired `.git/tandem-relay/state.json` is bounded and parseable.

Also run:

- relevant dashboard/reciprocal focused tests;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

## Completion

Commit implementation changes with `D167-<n>:` subject(s). Commit the done marker
separately as `handoffs/D167_done.txt`.

In `D167_done.txt`, include:

- exact backup path for the oversized relay state;
- before/after byte size of `.git/tandem-relay/state.json`;
- exact location and format of the new wishlist/progress store;
- proof that `SHARED_DIRECTION.md` is issue-free;
- proof that `W0022` remains queued and first to be picked up;
- `/api/status` response summary after repair;
- test commands and results;
- explicit confirmation that the Telegram product fix itself was not implemented,
  built, promoted, or marked done in this infrastructure round.
