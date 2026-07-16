# Handoff to GPT-5 — Round D35 (triage must be structural, not rhetorical)

D34's prompt-based triage FAILED live acceptance (reviewer-verified): "What is 2+2?" produced a
BuildPlan and a worker round that "verified that 2+2 equals 4"; the ZEBRA image question also
ran a full build. The zero-task backstop is evaded because the model invents filler tasks.
Prompt instructions alone cannot suppress the planning compulsion. Implementation requests
(scenario C) work correctly — do not regress them.

## D35-1: Classifier branch before planning
In the plan path (live.ts plan() or a thin wrapper in machine/service):
1. First, a cheap classification call with the leader model — `generateObject` (no tools):
   schema `{ kind: "question" | "implementation" }`, prompt: the user request + (thread-aware)
   one-line context + rule: "implementation ONLY if fulfilling it requires creating/modifying
   files or running state-changing commands; answering, explaining, reading/summarizing files,
   images, or PDFs is question. Mixed requests are implementation. Explicit user 'answer
   directly' is always question."
2. kind === "question" → run the leader with READ-ONLY tools and NO submit_build_plan tool
   (it structurally cannot plan); its text IS the answer (PlanResult kind "answer"). Media
   parts/read_file vision available as today.
3. kind === "implementation" → existing planner flow unchanged (keep the D34 prompt rubric as
   guidance; keep zero-task rejection as a backstop).
- Classification result appears as a dim SYSTEM line: "triage: question" / "triage:
  implementation". Cost of the classifier call goes to the leader ledger.
- Config escape hatch: `triage: "auto" | "always-plan"` (default auto) in case a user needs the
  old behavior.

## D35-2: Unit + live acceptance
Unit: fake-generator classifier tests (question → planner tools absent; implementation →
planner unchanged; 'answer directly' phrase → question).
Reviewer live re-run of the SAME three scenarios, criteria:
- "What is 2+2?" → answer, NO BuildPlan artifact, no worker cost, < 20s.
- ZEBRA image → correct word, NO BuildPlan, leader-only.
- "Create hello35.txt with hi" → plan + worker build + file exists.
tsc + `npm test` green; commits `D35-<n>:`.
