# Handoff D121 (backup push after approval; dashboard-driven master update with round tagging)

User requests, building on D120's human-approval gate: (1) after each human review/approval,
offer a git push for backup - never to master; (2) a dashboard button to fully update the
main branch; (3) version control must make it unambiguous which round of update master
currently corresponds to.

Background for whoever implements: copy A/B never merge - the relay keeps one linear chain
leapfrogging between the two branch names via fast-forward-only sync (divergence halts the
relay). The only true integration event is stable -> master, so that's where round identity
must be recorded.

## D121-1: post-approval backup push (branches only, never master)

After a D120 Approve completes (and also available any time as a standalone "Backup to
GitHub" button): token-gated endpoint that pushes `codex/reciprocal-a` and
`codex/reciprocal-b` (and the `refs/tandem-relay/stable` ref if practical as a remote ref,
e.g. `refs/tandem-relay/stable:refs/tandem-relay/stable` - check origin accepts
non-branch ref pushes; skip gracefully if not) to origin. Constraints:
- MUST NOT push master. MUST NOT use force. Fast-forward pushes only; if the remote
  rejects (non-ff), report the error for human attention - do not retry with force.
- Keep it fully decoupled from the relay turn token (existing design rule: remote
  availability must never affect turn sequencing). A failed push is a reported
  inconvenience, not a state change.
- In the D120 approve flow, after a successful promotion, surface a "Push backup now?"
  affordance (or auto-offer inline) rather than silently pushing - the user said "give
  user option," so it's opt-in per event, plus the standalone button.
- Audit every push (attempted refs, result) in CONTROL_PANEL_AUDIT.jsonl.

## D121-2: "Update main branch" button (the stable -> master integration event)

Token-gated endpoint + prominently-confirmed dashboard button implementing the D116-5
reconciliation policy end to end:
1. Preconditions (hard-fail with clear errors if unmet): relay phase is `idle` or `paused`
   (pause it if `working` is not active - if a turn is actively in progress, refuse and say
   to wait); admin repo working tree clean of feature-file modifications (ignore the known
   unrelated dirty files); `refs/tandem-relay/stable` exists and both reciprocal branches
   point at it (i.e. no unvalidated candidate dangling).
2. Run the full check suite on the stable commit in the admin repo context (`npm run
   typecheck`, `npm test`) - do not merge an unverified stable into master even though the
   peer executor validated it earlier; this is the human-facing integration gate.
3. Merge stable into master: fast-forward if possible; otherwise a regular merge commit
   (allowed on master per D116-5 - ff-only governs the relay branches, not master).
4. Tag it (see D121-3), push master AND the tag to origin (this is the one place master
   push is allowed; still no force ever).
5. Fast-forward both reciprocal branches to the new master and update
   `refs/tandem-relay/stable` accordingly (same as D116-1's flow), then resume the relay if
   this flow paused it.
6. Record the whole event (like D120's reviews): human comment required, entry in
   UPDATE_REVIEWS.md (or a sibling MAIN_UPDATES.md if cleaner) + audit log.
Failure at any step must leave a coherent state and say exactly what was and wasn't done -
especially between steps 3-5 (e.g. master updated but branches not yet re-synced) the
message must tell the human what remains.

## D121-3: unambiguous round identity on master

Every master update from this flow gets an annotated git tag, sequential and
self-describing: suggested scheme `main-update-<NNN>` (zero-padded sequence, discover next
from existing tags) with the tag message containing the stable SHA merged, the relay turn
number, the wishlist item IDs included since the last main-update tag, timestamp, and the
human's comment. Additionally:
- Dashboard: show "master is at: main-update-NNN (<shortsha>, <date>)" plus how many
  stable commits exist since that tag (i.e. pending-for-next-update count). This is the
  user-visible answer to "which round of update is currently the main branch."
- The D120 candidate/update panel should display the same tag identity for what's promoted
  to the runtimes, so runtime version vs master version vs stable tip are all visible in
  one place.

## Constraints

- Existing rules hold: no force pushes anywhere, no relay-token coupling to remote
  operations, token-gated + audited mutations, `.env` never tracked (re-verify before the
  first push per the repo's standing rule).
- Reuse existing pieces (promote script pattern, D116-1 ff logic, D120 review-logging
  shape) rather than duplicating.
- PROTOCOL.md/README.md updates to document both new flows.

## Acceptance

Live evidence in the marker: (1) backup push from the dashboard pushes both branches (and
stable ref if supported) to origin - paste the push output and the audit entry; confirm
master's remote SHA did NOT change; (2) full "Update main branch" run: preconditions
enforced (show at least one precondition rejection, e.g. attempted while a turn is
active/tree dirty), then a successful run - master advanced, tag created with the described
message content (paste `git show <tag>`), branches re-synced, relay resumed, review entry
recorded; (3) dashboard shows the main-update tag identity and pending-count as described.
tsc + `npm test` green. Admin-repo changes committed `D121-<n>:`; dashboard changes
described in the marker. Create `handoffs/D121_done.txt`.
