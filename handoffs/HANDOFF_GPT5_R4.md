# Handoff to GPT-5 — Round 4

Context: R3 (commits `cf2208f`..`dc5eb68`) was reviewed and APPROVED — tsc clean, 17/17 tests,
all seven tasks delivered as specified. Read `BUILD_PLAN.md`, `REVIEW_FEEDBACK.md`, and
`HANDOFF_GPT5.md` first if you need history. Same rules as before: tsc + tests green after every
task, one commit per task (`R4-<n>: <summary>`), honest completion-report update at the end.
Do NOT run `tests/live-smoke.test.ts` (it costs real API tokens); the reviewer runs it.

## R4-1: Adopt and test the prose-extraction fallback
The reviewer committed a hotfix ("Leader fix: extract review/takeover artifacts from prose via
generateObject...") in `src/agents/live.ts`: when a model finishes review/takeover without calling
its `submit_*` tool (observed repeatedly with Gemini 2.5 Pro, even with forced tool choice), the
artifact is extracted from the model's own prose via `generateObject`. Your task: own this code.
Review it critically, refactor `extractFromProse` so it is unit-testable without network (inject
the generator function or the model), and add tests covering: successful extraction, extraction
failure → original error thrown, and cost-ledger recording of the extra call. Do not change the
behavior contract.

## R4-2: Repo hygiene — stop tracking demo artifacts
`demo-todo/todo.mjs` and `demo-todo/test.mjs` (live-test output) are committed. Add `demo-todo/`
to `.gitignore` and `git rm -r --cached demo-todo`. Also confirm nothing else generated
(`dist/`, `.tandem/`, `.env`) is tracked.

## R4-3: Clear the dev-only vulnerabilities
Your R3-6 audit correctly identified that the Vitest/Vite/esbuild advisories need `vitest@4`.
Do that upgrade now (dev-dependency only, breaking changes are contained): bump vitest, fix any
config/API changes, keep all tests green, re-run `npm audit` and update the audit section of
`COMPLETION_REPORT.md`. Leave the AI SDK runtime advisories alone (pinned majors, documented).

## R4-4: Worker token usage is never recorded (HIGHEST PRIORITY — confirmed in live run 5)
Live smoke run 5 succeeded end-to-end (plan → build → review → approve), but the cost ledger
showed `worker: 0 in / 0 out / $0` while `leader: 23140 in / 1217 out / $0.0411`. MiniMax (via
`@ai-sdk/openai-compatible`) did many streaming tool-loop steps, so its usage is being lost.
Likely cause: OpenAI-compatible streaming only reports usage when the request includes
`stream_options: { include_usage: true }`, and/or `onFinish.totalUsage` arrives as NaN/undefined
fields that `usageTokens()` in `src/agents/runner.ts` maps to 0. Investigate both: enable usage
reporting on the openai-compatible provider (check `@ai-sdk/openai-compatible` provider options;
`includeUsage` may be a provider/setting flag) and harden `usageTokens()` to handle NaN. Add a
unit test with a mocked usage payload shaped like what the provider actually returns. Acceptance:
a live run (reviewer will execute) shows non-zero worker tokens and dollars in `/cost`.

## Acceptance
R4-1 tests exist and pass without network; R4-2 leaves `git status` clean after a live run;
R4-3 `npm audit` shows only the documented AI SDK runtime advisories; completion report updated.
