# Handoff D120 (human-approval gate before promoting a new Tandem build to the reciprocal runtimes)

User request: human-in-the-loop before "updating Tandem" - before each major update, the
human must be able to manually review and approve; make it easy to launch the candidate
desktop app standalone, and leave review comments before it becomes the official update.

## Scope decision (stated to the user, confirm/redirect if wrong)

"Updating Tandem" = promoting a new packaged build into the pinned executor runtimes
(`runtimes/executor-a|b`, via `scripts/promote-reciprocal-runtime.ps1` - the mechanism
D118 fixed). This is the point where a build actually becomes what a human or the relay
runs day to day - the "official update." This is NOT about gating every individual
relay candidate-commit the peer executor validates internally (those stay autonomous,
governed by the existing VALIDATE step); it's specifically the runtime-promotion step.

## Current gap

`scripts/promote-reciprocal-runtime.ps1` (D118) applies a build directly with no review
checkpoint: no way to try the candidate build before it overwrites the pinned runtimes, no
recorded human sign-off, no comment trail. A human currently has to remember to run it at
all, and there's no visibility into "a new build is ready to promote" versus "nothing has
changed."

## D120-0 (prerequisite): stamp the candidate build with its source SHA at build time

Verified gap: `release/win-unpacked` currently records NOTHING about which commit it was
built from - no BUILD_INFO.json exists there, and `package.json`'s `dist:app` script
(`npm run build && electron-vite build && electron-builder`) does no stamping. Without
this, D120-1's detection has no reliable input: current git HEAD at inspection time is
wrong whenever HEAD moves after a build, and file mtimes are fragile. Fix: add a small
stamping step to the `dist:app` flow (a tiny node script appended to the npm script, or an
electron-builder afterPack hook - pick the simplest) that writes
`release/win-unpacked/BUILD_INFO.json` with at least `{ sourceSha, builtAt }` captured AT
BUILD TIME. Also update `scripts/promote-reciprocal-runtime.ps1` to prefer reading the
source SHA from that stamped file over its `-SourceSha` param/HEAD default (keep the param
as an override). This piece IS admin-repo code - commit it.

## D120-1: surface pending updates

The dashboard already computes `runtime.lagsMaster` (D116-6, comparing each runtime's
promoted `BUILD_INFO.json` sourceSha against current master). Extend this: when
`release/win-unpacked`'s stamped BUILD_INFO (from D120-0) has a different source SHA than
what's currently promoted to the runtimes, surface it as a distinct "Update Available"
state in `/api/status` - include the candidate's source SHA, its `builtAt`, and how many
commits it is ahead of what's currently promoted (`git rev-list --count`). If the release
folder predates D120-0 and has no stamp, show "unknown candidate provenance - rebuild to
enable update detection" rather than guessing from HEAD or mtimes. Do not auto-promote
under any circumstance; this is visibility only.

## D120-2: "Launch Candidate" - try the build before approving

Add a dashboard button/endpoint that launches `release/win-unpacked/Tandem.exe` STANDALONE
for manual trial - completely isolated from the pinned executors' state (own
`TANDEM_HOME`/user-data, e.g. a dedicated `state/candidate-preview` and
`user-data/candidate-preview` under the relay root, reused across launches rather than a
fresh temp dir each time) and NOT pointed at either reciprocal worktree by default (open it
against the admin repo or a neutral scratch project dir, since the point is trying the
app itself, not re-running a reciprocal turn). Refuse to launch if a candidate-preview
instance is already running (same pattern as the existing executor start/stop guards).
Provide a corresponding stop action. This must not touch or interfere with the pinned
`executor-a`/`executor-b` runtimes or their running state.

## D120-3: review comments

Before approval, let the human attach a free-text comment (e.g. "tried it, model picker
looks right, approving" or "found X, rejecting, needs Y"). Record every review decision
(approve or reject) with its comment, timestamp, and the candidate's source SHA in a
durable, human-readable log - e.g. append to a new
`C:\Users\huizh\Apps\Tandem Reciprocal\control\UPDATE_REVIEWS.md` (readable without parsing
JSON) in addition to the existing `CONTROL_PANEL_AUDIT.jsonl` entry. A comment is optional
on reject only if a reason is otherwise required; require a comment on reject at minimum
(a rejected update with no reason recorded is not useful for the next round).

## D120-4: explicit Approve / Reject actions

- **Approve**: token-gated endpoint that runs the existing `promote-reciprocal-runtime.ps1`
  (reuse it, don't duplicate its logic) against both runtimes, requires the executors be
  stopped first (existing script guard already covers this - surface that requirement
  clearly in the UI rather than letting the call fail confusingly), and records the review
  per D120-3 before promoting.
- **Reject**: does not touch the runtimes at all; just records the decision and comment so
  the next relay batch or human knows this candidate was reviewed and declined, and why.
- Both actions must be blocked (return a clear error, not silently no-op) if there is no
  pending update to act on.

## Constraints

- Keep the dashboard's existing control boundary: everything token-gated, localhost-only,
  audited (reuse `CONTROL_PANEL_AUDIT.jsonl`, add `UPDATE_REVIEWS.md` as described).
- Do not weaken or bypass `promote-reciprocal-runtime.ps1`'s existing safety checks
  (path-containment assertions, refusal while an executor is running, post-copy
  verification) - call it, don't reimplement or loosen it.
- Do not make this block or interfere with the routine internal relay loop (Claim/Accept/
  Rollback on individual candidates) - that stays autonomous as designed; this gate sits
  only in front of runtime promotion.

## Acceptance

Demonstrate live with real evidence in the marker: (0) a fresh `npm run dist:app` produces
`release/win-unpacked/BUILD_INFO.json` with the correct source SHA (paste it); (1) with
`release/win-unpacked` ahead of the currently-promoted runtimes, `/api/status` shows the
pending-update state with correct SHA/ahead-count; (2) Launch Candidate starts a real, isolated Tandem instance (paste
process/window evidence), then stop it cleanly; (3) Reject with a comment - runtimes
untouched, `UPDATE_REVIEWS.md` and the audit log show the entry; (4) Approve with a comment
- runtimes actually promoted (real directory listing showing the new `Tandem.exe`, as D118
required), and the review recorded. tsc + `npm test` in the admin repo unaffected - run as
sanity. Commit any admin-repo-side script/doc changes with `D120-<n>:`; dashboard-side
changes live outside the repo - describe them fully in the marker. Create
`handoffs/D120_done.txt`.
