# Handoff D133 (hourly RESUME loop burned ~12M tokens on W0013's plan turn - verification contradiction + missing circuit breaker)

Relay is PAUSED (pause-after-turn requested by me). Do not resume until D133-1 and
D133-3 are in place. Evidence session:
`state/executor-a/sessions/d029c3483314/d6dfab29-455c-4c18-afb9-c40b9720111a.jsonl`.

## Verified root-cause chain (from the session log - re-verify, don't re-derive)

1. Hourly schedule fired 07:07-14:07 UTC (8 ticks); each RESUMEd the same unfinished
   W0013 plan turn and ran a full fresh agentic cycle (7 `done` events). Token cost so
   far: ~3.29M leader input / ~8.99M worker input (final cost event in that session).
2. Every cycle fails the same way: the turn's internal BuildPlan lists the full
   `npm test` in its verification array (D130's protocol REQUIRES plans to list it, for
   the authoritative outside-sandbox runner) - but Tandem's worker rule (D97 era, in the
   worker system prompt: run every verification command before submit_completion_report)
   makes the sandboxed worker run it IN-sandbox, where it cannot pass: the exact command
   is esbuild/config-denied, and an alternate invocation fails 13 tests in
   tests/desktop-service.test.ts with `git branch --show-current` -> exit 128 "not a git
   repository". Worker reports the deviation honestly; leader review then demands
   revisions; plan gets re-revised (rev1 b0a4ff1 -> rev2 4c23af5 -> third revision
   currently UNCOMMITTED in copy-b); relay never gets Complete; next tick repeats.
3. Why never before: W0010's plan turn predates D130's "list the full suite" rule;
   W0011/W0012 had trivial verification; and before D131's schedule fix, hourly ticks
   silently died after restarts - the old bug was an accidental circuit breaker.

## D133-1: reconcile the verification contradiction (the core fix)

The full-suite command must stay in every plan's verification array (the authoritative
runner and peer VALIDATE depend on it - D130 design, keep it). The SANDBOXED worker must
stop executing it. Implement an explicit mechanism, not prompt vibes: e.g. an
`authoritative-only:` (or similar) prefix convention on verification entries that (a)
the worker prompt instructs to SKIP with a note in verificationResults (command echoed
verbatim, passed=false-with-skipped-marker or a dedicated skipped status - check what
`enforceVerification`/`validateCompletionReport` in src/orchestrator/artifacts.ts
tolerate and extend minimally), and (b) the authoritative runner and peer VALIDATE
still execute for real. Wire the reciprocal leader/plan prompts (TANDEM.md templates +
PROTOCOL.md) to emit the prefix for full-suite commands in reciprocal turns. Tandem's
default (non-reciprocal) behavior must remain unchanged - scope the convention so a
normal project plan without the prefix behaves exactly as today. Regression tests for
the skip path and for authoritative execution of prefixed entries.

## D133-2: investigate the 13 desktop-service failures under sandbox

`git branch --show-current` exit 128 inside tests/desktop-service.test.ts, only under
the Codex sandbox (admin-repo runs pass 391+). D132-1 added app-layer git operations to
app/main/tandem-service.ts that these tests exercise. Determine: real regression
(app-layer git code assumes a repo/cwd it shouldn't) vs pure sandbox environment
artifact. If the service code runs git in non-repo dirs and only survives by luck of
environment, harden it (graceful no-repo handling) regardless. One clear answer with
evidence; fix if real.

## D133-3: relay resume circuit breaker (never again burn overnight)

Add a per-turn resume counter to the relay state: each Claim returning RESUME for the
same turn increments it; at a threshold (suggest 3), the relay auto-pauses with a clear
lastSummary ("turn X resumed N times without completing - human attention required")
instead of handing the turn out again. Counter resets on Complete/Abandon/rollback.
Dashboard should surface the counter. Regression test the threshold + reset behavior.

## D133-4: recover W0013's plan work

After D133-1/-3 land: preserve and use the existing plan work (rev2 committed 4c23af5 +
the uncommitted third revision in copy-b - review whether rev3 adds real value or rev2
suffices; don't redo from scratch). Complete the plan turn under the fixed rules so
W0013 reaches PLAN candidate -> peer validation -> auto-approve normally. Leave the
relay PAUSED after; the human resumes step turns.

## Acceptance

tsc + `npm test` green (with new regressions). Evidence in the marker: the contradiction
fix demonstrated in a real sandboxed turn (worker skips the prefixed full-suite entry,
authoritative runner executes it - paste both sides), the D133-2 answer with evidence,
circuit-breaker regression + a live demonstration (scripted RESUMEs hitting the
threshold -> auto-pause), and W0013 at PLAN_APPROVED (or awaiting validation) without
another multi-cycle burn. Token discipline note: keep your own verification cycles lean
- this round exists because of token burn. Commit `D133-<n>:`. Create
`handoffs/D133_done.txt`. Leave the relay paused.
