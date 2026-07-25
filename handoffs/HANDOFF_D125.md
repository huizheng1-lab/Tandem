# Handoff D125 (wishlist Remove action: script verb + dashboard button)

User request: removing a wishlist item currently requires hand-editing
`control\SHARED_DIRECTION.md` (no remove verb exists in `scripts/reciprocal-direction.ps1`
- ValidateSet is Show/UpdateDirection/Add/Start/Candidate/Complete/Block/Requeue - and the
dashboard only wires up Add). Today W0004 had to be deleted manually.

## D125-1: `Remove` action in scripts/reciprocal-direction.ps1

- `-Action Remove -Id <id> -Note <reason>` (note required - a removal with no recorded
  reason is as useless as an unexplained reject).
- Uses the existing mutex, matches items by ID in the wishlist block.
- Guard: refuse to remove an item currently `IN_PROGRESS` (an executor owns it
  mid-turn) - require it to finish, be requeued, or the turn to end first. Removing
  QUEUED/BLOCKED/CANDIDATE/DONE entries is fine (DONE removal is just board tidying).
- Don't silently drop history: append the removed item (with its full original line,
  removal timestamp, and note) to a `## Removed` section at the bottom of the file, or a
  sidecar `REMOVED_ITEMS.md` next to it - pick one, keep it simple. The board stays
  clean; the record survives.

## D125-2: dashboard support

- Token-gated endpoint calling the script verb (same pattern as the existing wishlist
  add), audited in CONTROL_PANEL_AUDIT.jsonl with id + note.
- A small Remove control per wishlist row in the UI with a required reason prompt, and a
  confirm step. Disabled for IN_PROGRESS items with a tooltip saying why.

## Acceptance

tsc + `npm test` green as sanity. Live evidence in marker: add a scratch item, remove it
from the dashboard with a note, show the board no longer lists it, the removed-record
retains it, the audit entry exists, and an attempt to remove an IN_PROGRESS item (simulate
by setting the status directly or via `-Action Start`) is refused. Script changes
committed `D125-<n>:`; dashboard changes described in the marker. Create
`handoffs/D125_done.txt`.
