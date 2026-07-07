# Handoff to GPT-5 — Round D37 (CRITICAL: every Codex-CLI schema is rejected by OpenAI's API)

D36 code review passed (self-protection guard reuse, path discovery, mixed leader/worker
dispatch, temp-file cleanup, and test coverage were all verified correct by reading the code).
But LIVE testing — the reviewer ran real `codex exec` calls, not just unit tests — found that
**every single Codex-backed call currently fails** with the same root cause. This is a complete,
reproducible break of the whole D36 feature; nothing about it works end-to-end right now.

## Root cause (reviewer-diagnosed with the exact OpenAI error text)

`src/agents/codex-cli/schema-json.ts` hand-rolls JSON Schemas from Tandem's zod shapes, and for
every zod-`.optional()` field, the converter puts the key in `properties` but leaves it OUT of
`required`. OpenAI's Structured Outputs (which `codex exec --output-schema` uses under the hood
via the Responses API — Codex CLI's `provider: openai`) requires the opposite: **every key in
`properties` must also appear in `required`**; true optionality must be expressed as a nullable
type, never as an absent `required` entry. Live reproduction (isolated down from the real
`completionReportJsonSchema`, run directly against `codex exec`):

```
{"type":"error","message":"{\n  \"type\": \"error\",\n  \"error\": {\n    \"type\": \"invalid_request_error\",\n
  \"code\": \"invalid_json_schema\",\n    \"message\": \"Invalid schema for response_format
  'codex_output_schema': In context=('properties', 'taskResults', 'items'), 'required' is
  required to be supplied and to be an array including every key in properties. Missing
  'notes'.\",\n    \"param\": \"text.format.schema\"\n  },\n  \"status\": 400\n}"}
```

Every schema kind has at least one instance of this pattern, so every Codex-backed role/phase is
affected:
- `buildPlanJsonSchema.tasks.items` — `files` optional, missing from `required` (line ~22-26).
- `completionReportJsonSchema.taskResults.items` — `notes` optional, missing from `required`
  (line ~47-51). **This is the exact instance reproduced above.**
- `reviewVerdictJsonSchema.feedback.items` — `location` optional, missing from `required`
  (line ~94-97).
- `planOrAnswerJsonSchema` (top level) — `answer`/`plan` optional, missing from `required`
  (line ~119-123). This affects EVERY leader call (plan/question triage), since it's the first
  schema used.
- `takeoverJsonSchema` embeds `completionReportJsonSchema` as `report`, so it inherits the same
  defect transitively even though its own top-level `required` is correct.

Symptom on the Tandem side was misleading and cost real debugging time: `runCodexExec` throws
`"Codex CLI exited with code 1: Reading additional input from stdin..."` — that stderr line is
harmless boilerplate Codex always prints; the REAL rejection reason is only visible in the
`--json` stdout stream as a `{"type":"error", ...}` event, which `handleCodexJsonLine` currently
does not surface into the thrown error message at all (only `stderr` is used to build the error).

## D37-1: Fix every hand-rolled schema to satisfy OpenAI Structured Outputs
For each optional zod field represented in these schemas, make it required-but-nullable instead
of absent-from-required:
- String/enum optionals (`notes`, `location`, `answer`): `{"type": ["string", "null"]}` (or
  equivalent `anyOf` form — use whichever the `--output-schema` file format Codex accepted in
  the reviewer's working test; a plain `"type": ["string", "null"]` is standard JSON Schema and
  is the simplest to implement consistently).
- Array optional (`files` on a BuildPlan task): `{"type": ["array", "null"], "items": stringSchema}`.
- Object optional (`plan` in `plan-or-answer`, when `kind === "question"`): make `plan` a nullable
  reference to `buildPlanJsonSchema` (wrap the type union at that property, keep the referenced
  object schema itself unchanged internally — do NOT recursively make ITS OWN required fields
  nullable, only the property that holds it).
- Add every property key to that object's `required` array (do this for every level, not just
  the four instances found — add a generic self-check, see D37-3).

## D37-2: Normalize `null` → absent before validating against Tandem's existing zod schemas
Tandem's zod schemas use `.optional()` (accepts `undefined`, not `null`) for these same fields —
do not change the zod schemas. Instead, right where `runCodexExec` reads and parses the
`--output-last-message` file (before returning it to the caller / before
`validateBuildPlan`/`validateCompletionReport`/`ReviewVerdictSchema.parse`/the takeover
`z.object(...).parse` run), recursively strip any object key whose value is exactly `null`,
treating it as absent. A small shared helper (e.g. `stripNulls(value: unknown): unknown`) reused
by all four schema kinds is sufficient — keep it generic, not hand-tuned per field name.

## D37-3: Prevent this class of bug from recurring
Add a unit test in `tests/codex-cli.test.ts` that walks each exported schema
(`buildPlanJsonSchema`, `completionReportJsonSchema`, `reviewVerdictJsonSchema`,
`takeoverJsonSchema`, `planOrAnswerJsonSchema`) recursively and asserts: for every object node
with `additionalProperties: false`, `required` contains every key present in `properties`. This
must fail against the CURRENT (broken) schemas and pass after D37-1's fix — write it to fail
first, confirm it catches the real bug, then fix and confirm green (do not skip the
fails-first step).

## D37-4: Surface the real Codex-side error, not just stderr
In `handleCodexJsonLine` / `runCodexExec`, when a `{"type":"error", ...}` or `{"type":
"turn.failed", "error": {...}}` event appears in the `--json` stream, capture its `message` and
include it in the thrown error (in addition to or instead of raw `stderr`) so future failures are
diagnosable from Tandem's own error text alone, without needing a reviewer to bisect it by hand
the way this round required. This is the single highest-value change for future debuggability of
this whole subsystem.

## D37-5 (minor, non-blocking, note only): transient ENOENT
Once, on a fresh process, a leader call failed with `spawn ... ENOENT` on the correct, existing
`codex.exe` path (re-running immediately succeeded in resolving the same path with no code
changes). Could not reproduce a second time; likely a one-off OS/AV-scan timing artifact on first
touch of the file, not a `locateCodexCli` logic bug (the path resolution itself was independently
verified correct and stable across many subsequent calls). No action required unless it recurs.

## Acceptance
tsc + `npm test` green, including the new fails-then-passes schema-shape test (D37-3). Reviewer
will personally re-run real `codex exec` calls (not just unit tests) covering: worker build via
Codex CLI producing a real file + valid CompletionReport with a `taskResults[].notes` value
present; leader direct-question triage (no plan, real answer); leader planning a real
BuildPlan (including a task with `files` populated); review-verdict with a `feedback[].location`
value present. All four must succeed against the live API, not just pass mocked unit tests.
