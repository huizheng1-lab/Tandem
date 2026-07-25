# Handoff D127 (autonomy policy: let epics run without per-plan human approval)

Builds directly on D126 (epic support - implement after it lands, on top of its result).
User request: "be able to let it work autonomously on bigger projects without asking me
approval all the time." D126's human plan gate should become policy-controlled rather
than mandatory.

## Design

1. **Per-item autonomy at Add time.** `reciprocal-direction.ps1 -Action Add` gains an
   autonomy option (e.g. `-Autonomy full`), also exposed as a checkbox in the dashboard's
   add-item form ("Fully autonomous - skip plan approval"). Adding an item IS the human
   approval in this mode.
2. **Board-level default.** A human-editable policy line in SHARED_DIRECTION.md (e.g.
   `AutonomyDefault: plan-gated` | `autonomous`) that applies when an item doesn't say.
   Ship with `plan-gated` as the default; the user flips it when they're comfortable.
3. **Autonomous epics still plan first** - the plan-first turn and committed plan file
   stay (decomposition is what makes multi-turn work coherent, and the plan is the
   audit/visibility artifact) - but the plan is AUTO-approved: recorded in the audit log
   as "plan auto-approved (item autonomy: full)", dashboard shows the plan prominently
   with a "review anytime" affordance, and the human can intervene at ANY point with the
   existing controls (relay Pause; Requeue-with-note acts as a retroactive plan
   rejection, sending the epic back to planning with the note).
4. **What does NOT get autonomous:** Tandem runtime promotion (D120 gate) and master
   integration (D121 button) stay human-only - those change the running tool itself and
   the trunk, and were explicitly requested as human-in-the-loop. The protocol's safety
   boundaries (no protocol/script/credential/dependency edits, no test-weakening, etc.)
   are not relaxed by any autonomy mode - say so explicitly in the docs. W0003-class
   security-surface work also remains excluded from autonomous mode (an epic touching
   auth/credentials/remote-control surface must be plan-gated regardless of the policy
   default - a keyword/human-note guardrail plus a documented rule is enough; don't
   over-engineer detection, the human curates the board).
5. Docs: PROTOCOL.md epics section + README + template guardrails updated to describe
   both modes and the intervention paths.

## Acceptance

tsc + `npm test` green. Live evidence: add a scratch epic with `-Autonomy full` -> plan
turn lands -> NO approval needed -> next claim starts step 1 directly; audit shows the
auto-approval record; dashboard displays the plan with the epic marked autonomous; a
Requeue-with-note on the in-progress epic returns it to planning (retroactive rejection
path works). Also confirm a plan-gated epic still blocks on approval (D126 behavior
unregressed). Script/doc changes committed `D127-<n>:`; dashboard changes described in
the marker. Create `handoffs/D127_done.txt`.
