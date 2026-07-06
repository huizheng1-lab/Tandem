# Handoff to GPT-5 — Round D22 (verification deadlock: POSIX commands on Windows)

Reviewer-diagnosed from session logs (solitaire session, 2026-07-05 16:10–16:24). The build
itself succeeded; every follow-up run then died identically:
1. Leader plans verification commands like `cat launch.bat` and
   `cat index.html | grep -E 'src=|title='` — POSIX, on a Windows host.
2. Worker adapts (runs `type` etc.) and reports the command it actually ran.
3. `enforceVerification` string-matches, sees the plan's `cat ...` missing → rejects the report
   ×3 → takeover.
4. The TAKEOVER report is validated against the same plan verification → also fails ×3 → the
   entire run ends in error. Deterministic deadlock; the user cannot complete any task whose
   plan contains platform-alien commands. ~$0.59 wasted in retry loops in one session.

Fix all four; this round also absorbs the deferred D20-1.

## D22-1: Platform awareness in every agent prompt
Inject the host platform into the planner, worker, reviewer, and takeover system prompts (from
`process.platform` + shell, e.g. "Host: Windows; commands run via cmd/PowerShell semantics —
`cat`, `grep`, `ls`, `touch`, `rm` are NOT available; prefer `node -e`, npm scripts, `type`,
`findstr`, PowerShell equivalents"). Planner rule: verification commands MUST be runnable
verbatim on the host platform.

## D22-2: Mechanical validation of verification entries at plan submission (absorbs D20-1)
Validate `BuildPlan.verification` in `submit_build_plan` handling (retryArtifact path feeds
errors back to the planner):
- Reject prose entries (no command shape — see deferred HANDOFF_GPT5_D20.md D20-1 heuristic).
- On win32, reject entries starting with or piping through POSIX-only tools
  (cat|grep|ls|touch|rm|sed|awk|head|tail|chmod) with an error naming the Windows-safe
  alternative. Unit tests: the two observed commands from this incident must be rejected with
  helpful messages; `npm test`, `node test.mjs`, `type launch.bat` accepted.

## D22-3: Verification echo contract (defense in depth)
Worker/takeover prompt: verificationResults[].command must repeat the plan's command string
VERBATIM; if the command had to be adapted for the platform, still key the result by the plan's
original string and describe the adaptation + real output in `output`. This makes honest
adaptation legible to the strict matcher instead of looking like an omission.

## D22-4: Takeover must not die on report validation
`runTakeover` currently validates the takeover report with `validateCompletionReport` and a
failure propagates as a run error (observed). After takeover-report validation retries are
exhausted, end the run GRACEFULLY: phase DONE, summary explaining the build finished but
verification bookkeeping failed, attaching the takeover report unvalidated (mirror the R6-3
graceful-review pattern). The user must never lose a completed build to receipt-checking.
Unit test: takeover agent returning a report that fails enforcement → run resolves DONE with
warning summary, not a throw.

## Acceptance
tsc + `npm test` green; commits `D22-<n>:`. Reviewer will replay the failing scenario shape:
a plan whose verification contains `cat x.txt` must be rejected at planning time with a
corrective message (observed via unit test + one live run in a scratch folder if needed).
