# Handoff to GPT-5 — Round D19 (agent hung on its own dev server)

Incident (reviewer-diagnosed live): during the user's dogfight-game build, the LEADER
(review/verification phase) ran `npm run dev` to "verify everything works" — vite never exits,
the bash tool waited indefinitely, and the app appeared stuck. The reviewer killed the process
tree manually and the run resumed. Three gaps:

## D19-1: Extend the no-server rule to all agent personas
D12-1 added "do not start long-running servers or watchers during verification" ONLY to the
worker prompt (`src/agents/worker.ts`). Add the equivalent instruction to the leader reviewer
and takeover prompts (`src/agents/leader.ts`), and to the planner prompt as a plan-authoring
rule: verification commands must terminate on their own (no dev servers, no watch modes; use
builds, tests, or scripts that exit).

## D19-2: Hard cap on bash timeouts
`bash` accepts model-provided `timeoutMs` with no ceiling; a model that omits it gets 120s, but
a model can pass anything. Clamp effective timeout to a hard max (300_000 ms) in
`src/tools/shell.ts` regardless of the requested value, and make sure the on-timeout tree-kill
(D12-1) fires reliably for shell:true commands on Windows (the incident's `npm run dev` tree —
npm→cmd→vite — outlived any timeout; add/extend the unit test to cover a shell:true command
that spawns a grandchild and asserts the tree dies at timeout).

## D19-3: Stop must cancel in-flight commands
The run's AbortController aborts LLM streams but not an executing bash tool call. Pass the
abort signal into the tool context and wire it to execa (kill the child tree on abort), so the
UI Stop button interrupts a hung command immediately. Unit test: start a long sleep-ish command,
abort, assert the child is gone and the tool returned promptly.

## Acceptance
tsc + `npm test` green (including the two new process tests); commits `D19-<n>:`. Reviewer will
live-test: a prompt whose verification tries `npm run dev` should either be planned around
(no server) or time out within the cap; pressing Stop during a long command must return the UI
to idle within ~2s with no orphan processes.
