# Handoff D61 (three more gaps between my own operating principles and Tandem's worker/leader instructions)

## Context
Following D60 (perceptual verification, root-cause discipline), user asked for a broader audit:
what else do I (the reviewer, operating under my own system prompt) do by default that Tandem's
worker/leader are never told to do. Three concrete, generalizable gaps, none specific to the video
incident. This round is worker-facing mostly (`src/agents/worker.ts`'s `workerPrompt`, currently a
single short sentence), plus one leader-facing addition for the caution/reversibility piece since
the leader is the one with unrestricted write access during takeover.

## D61-1: Security consciousness (worker-facing)
`workerPrompt` currently has zero security guidance. Nothing stops a worker from hardcoding a
secret, building a shell/SQL string via unsafe concatenation, or skipping validation at a real
input boundary. Add to `workerPrompt` (or a new shared constant if you'd rather keep it
consistent with the `leader.ts` pattern — your call, but it must apply to the worker):

```
Be careful not to introduce security vulnerabilities such as command injection, path traversal, XSS, SQL injection, or hardcoded secrets/credentials. If you notice you've written insecure code, fix it immediately rather than leaving it for review to catch.
```

## D61-2: Scope discipline / no over-engineering (worker-facing)
`workerPrompt` already has "keep changes scoped" as a short phrase, but it's vague compared to
what's actually needed — it doesn't say what "scoped" means or forbid the specific failure modes
(gold-plating, unrequested refactors, speculative abstraction). Strengthen it:

```
Implement exactly what the plan's tasks specify - no more. Do not add features, refactors, or abstractions the plan didn't ask for, even if they seem like good ideas; a BuildPlan task is not an invitation to redesign adjacent code. Don't add error handling, fallbacks, or validation for scenarios the plan doesn't describe. Three similar lines are better than a premature abstraction. No half-finished extras: either something is in scope and done properly, or it's out of scope and left alone.
```

Also add one line to `leaderReviewerPrompt` (in `src/agents/leader.ts`) so the reviewer actually
checks for this, not just the worker being told not to do it:

```
Flag unrequested scope expansion (features, refactors, or files touched beyond what the plan's tasks describe) as a revise-worthy issue, the same as a missing task.
```

## D61-3: Caution around hard-to-reverse actions (leader-facing, since the leader has
unrestricted write access during takeover)
Tandem's only existing safety net here is `isDestructiveCommand` in `src/tools/permissions.ts` —
a narrow hardcoded pattern list (`rm -rf /`, `format C:`, a fork bomb, `del /fsq`). That's a
blocklist of a few known-bad patterns, not a general principle. Nothing currently stops, say, a
force-push, or a commit that happens to include a file with an API key in it, or blind deletion of
files the worker/leader doesn't recognize as its own without first checking what they are.

This should stay a PROMPT addition, not a new mechanical gate (don't build a git-diff secret
scanner or similar for this round — that's a much bigger, separate piece of work; flag it as a
possible future round instead of building it now). Add to `leaderTakeoverPrompt` (this is where
the leader has the most unrestricted write access) and consider `workerPrompt` too if it fits
without bloating it further - your call on whether one shared constant serves both:

```
Before any hard-to-reverse action (force-push, deleting files or branches, overwriting content you didn't create, discarding uncommitted changes), pause and check: is this reversible, and do you actually understand what's there? Investigate unfamiliar state before deleting or overwriting it rather than assuming it's safe to clobber. Never force-push. If you're about to commit or push, make sure nothing in the change looks like a secret or credential, even in an innocuously-named file.
```

## Acceptance
tsc + `npm test` green. Add presence tests for the three new/strengthened rule strings in whatever
prompt-constant test file already covers `finiteVerificationRule`/`streamPartitioningRule`
(mirroring existing coverage style). No live-behavior test is required for D61-1/D61-2 (they're
best-effort prompt guidance, same category of limitation as D60 - can't be mechanically verified
that the model actually follows them). For D61-3, if practical, a cheap live check is worth doing:
give the worker or leader a task in a scratch git repo where an obvious "should I check this
first" moment arises (e.g. a file already exists with unexpected content) and confirm the
response shows it investigated rather than overwrote blindly - not required to block the round if
it's awkward to construct cheaply, but do it if a natural scenario is easy to set up. Commit
`D61-<n>:`, create `D61_done.txt`.
