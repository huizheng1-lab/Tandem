# Handoff to GPT-5 — Round D24 (session list desyncs from active folder; ops become silent no-ops)

Reviewer-reproduced via CDP: sidebar showed 4 session rows while `listSessions` (service, current
projectDir) returned 2. Sessions are folder-scoped, but the sidebar list is not refreshed on
every projectDir change, so after switching folders the user sees rows the service cannot act
on. Worse: rename/archive on a foreign id "succeeds" silently because `updateSessionIndex` does
`index[id] ??= {...}` — creating a phantom entry in the WRONG folder's index — and delete of a
missing file with `force: true` also reports ok. User experience: rename/delete/archive appear
completely broken; resume fails with "No session <id>. Run /sessions to list sessions." (a
CLI-era message shown in the GUI).

## D24-1: Sidebar is always scoped to the service's current projectDir
Refresh the session list from the service on EVERY path that changes projectDir (startSession
via pick, Continue, New session, resume). Add a small header above the list naming the scope,
e.g. "Sessions — dogfight-game", so cross-folder confusion is visible. The pre-pick state shows
the last-used folder's sessions (D16 behavior) with that folder named in the header.

## D24-2: Session ops must fail loudly on unknown ids
In `src/session/store.ts`: `renameSession` / `archiveSession` must NOT create entries for ids
absent from the index AND absent on disk — throw "No session <id> in <folder>". `deleteSession`
on a missing file: same error. `updateSessionIndex`'s `??=` default-entry behavior stays ONLY
for the append path (active session). Renderer surfaces these errors as SYSTEM lines (the
existing catch already does). Unit tests: rename/archive/delete of a nonexistent id throw; the
phantom-entry regression (rename unknown id then listSessions) shows no new row.

## D24-3: Message hygiene
Replace CLI-flavored errors surfaced in the GUI ("Run /sessions to list sessions") with
GUI-appropriate text ("This session belongs to a different project folder — pick that folder to
open it.") — keep the CLI text for the TUI path.

## Acceptance
tsc + `npm test` green; commits `D24-<n>:`. Reviewer will CDP-drive: switch between two folders
with distinct sessions and verify the list swaps and is headed correctly; UI rename/archive/
delete work in each; an op on a stale row (simulated) produces a visible SYSTEM error, not a
silent no-op.
