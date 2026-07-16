# Handoff to GPT-5 — Round D34 (leader triage: only involve the worker when work is needed)

User-stated principle (this round's centerpiece): THE LEADER DECIDES WHETHER THE WORKER IS
NEEDED. Simple tasks — questions, explanations, looking at a file or image — are answered by
the leader directly: no build plan, no worker, no memory-file writes. A build plan exists ONLY
when implementation work (file changes, commands) is required.

Reviewer-observed violations driving this: a "what word is in this image?" question triggered
plan → blind-worker confabulation ("HELLO" for a ZEBRA image) → takeover — 3 agent calls and a
TANDEM.md write for a one-glance answer; an explicit "answer directly, no build plan" prompt
was still planned into a build.

## D34-1: Explicit triage as the planner's FIRST decision
Restructure the planner prompt around a mandatory triage step:
"FIRST, classify the request:
 (a) QUESTION/INSPECTION — answering, explaining, reading/summarizing files, images, or PDFs,
     status queries. → Do the inspection yourself with read-only tools and ANSWER DIRECTLY.
     Do NOT call submit_build_plan. Do NOT write notes.
 (b) IMPLEMENTATION — requires creating/modifying files or running state-changing commands.
     → submit_build_plan.
When the user explicitly asks for a direct answer, it is ALWAYS (a)."
Mechanical backstop: reject submitted BuildPlans with zero tasks (validateBuildPlan) with the
error "no implementation tasks — answer directly instead"; the retry loop then produces an
answer. Unit test: zero-task plan rejected with that message.

## D34-2: Perception routing (unchanged from prior draft)
When a request references media AND the worker lacks the capability (D33-4 flags), inject a
conditional planner block: worker cannot see media; inspect yourself during planning; plans may
only contain tasks executable without seeing media, with the leader's visual FINDINGS included
in the plan.

## D34-3: Blind workers must not guess (unchanged from prior draft)
read_file media stub for non-capable callers: "You CANNOT view this file's visual content.
Never guess, infer, or claim to know what it shows; if the task depends on it, submit a blocked
report." Same rule in the worker system prompt. Unit tests for stub text.

## D34-4: Memory-write restraint
`remember` guidance in the memory instruction: only durable project facts (conventions,
constraints, decisions); NEVER for Q&A trivia or one-off answers. Triage path (a) runs with the
remember tool available but the instruction states plainly: direct answers rarely warrant notes.

## Acceptance
tsc + `npm test` green; commits `D34-<n>:`. Reviewer will run:
1. "What is 2+2?" → direct answer, NO BuildPlan artifact, no worker cost, no TANDEM.md change.
2. ZEBRA image probe → correct word, answered directly by the leader, no BUILDING phase, <60s.
3. "Create hello.txt with hi" → normal plan → worker build (triage must not over-rotate to
   answering; implementation still plans).
4. Forced blind-worker media task → blocked report, not an invented answer.
