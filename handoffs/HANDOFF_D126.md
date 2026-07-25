# Handoff D126 (epic support: large wishlist items spanning many validated turns)

User need: the things they want built are mostly larger than the protocol's ~6-file/400-
line turn norm, and not always partitionable into user-visible increments. The turn cap
must stay per-COMMIT (it's what keeps peer validation meaningful), but a feature must be
able to span many turns.

## Design (implement this shape)

1. **Epic items.** A wishlist item can be marked as an epic (e.g. `Add -Epic` flag or a
   `[EPIC]` marker the script understands). Epics are not implemented directly in one
   turn.
2. **Plan-first turn.** The first turn that claims an epic produces NO code - it writes a
   plan file (e.g. `.tandem/epics/W00NN-plan.md` in the target worktree, committed like
   any candidate) breaking the epic into ordered, individually-stable steps: each step
   small enough for a normal turn, each leaving the suite green (feature-flagged or
   scaffolding-only steps are explicitly fine - relax the current guardrail's "useful
   increments" wording to "stable increments" in SHARED_DIRECTION_TEMPLATE.md and the
   live control file's guardrail section).
3. **Human plan gate.** The epic's plan lands as a normal candidate (peer-validated), but
   implementation steps may not begin until a human approves the plan - a dashboard
   action (token-gated, audited, comment optional) that flips the epic to
   `PLAN_APPROVED`. Until then the epic is not claimable for step turns; executors take
   other work or pause. Rejecting sends it back with a note (Requeue-style).
4. **Step turns.** After approval, each subsequent turn claiming that epic implements the
   NEXT unfinished plan step - one commit, normal size norm, normal peer validation, step
   checked off in the plan file within the same commit. The wishlist item stays
   `IN_PROGRESS` across turns with a `step k/n` annotation the board/dashboard shows.
   Executors must not skip ahead, reorder, or bundle steps; if a step turns out wrong-
   sized or the plan needs restructuring, the turn updates the PLAN (a new plan revision
   requiring re-approval of the remaining steps), not the code.
5. **Completion.** When the last step's candidate is accepted, the epic goes
   `CANDIDATE`->`DONE` as today (opposite-executor acceptance of the final step; the
   dashboard should show the whole epic's step history).
6. **Turn-size norm stays** for step turns and non-epic items; PROTOCOL.md gains an
   "Epics" section documenting all of the above. The existing "pause and propose a
   human-reviewed handoff if larger/architectural/security-sensitive" escape hatch
   remains for work that even an epic plan can't safely decompose (e.g. W0003's
   auth/pairing core) - epics don't replace human-designed D-rounds for security surface.

## Implementation notes

- `scripts/reciprocal-direction.ps1`: epic flag, PLAN_APPROVED status, step annotation
  support (keep the line format machine-parseable; extend the existing status set).
- `process/reciprocal/PROTOCOL.md` + `SHARED_DIRECTION_TEMPLATE.md` + live control file
  guardrail: as above.
- Dashboard: plan-approval action + epic step display; reuse existing token/audit/mutex
  patterns throughout.
- Relay script: likely NO changes needed (turns/candidates/validation are unchanged) -
  confirm and say so rather than touching it unnecessarily.
- Keep it lean: no new state stores; the plan file in the worktree + the board line carry
  all epic state.

## Acceptance

tsc + `npm test` green. Live evidence: add a scratch epic via script or dashboard ->
first claim produces a plan candidate (no production code) -> dashboard approve ->
next claim implements step 1 only (one commit, plan checkbox updated) -> board shows
IN_PROGRESS step 1/n -> demonstrate the not-yet-approved guard (step turn refused before
approval). A full multi-step run to DONE is NOT required for acceptance (that's hours of
real turns) - the guards and the first step cycle are the proof; say plainly what was and
wasn't exercised. Script/doc changes committed `D126-<n>:`; dashboard changes described in
the marker. Create `handoffs/D126_done.txt`.
