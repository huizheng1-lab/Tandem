# Handoff to GPT-5 — Round D39 (Codex CLI leaks raw structured-output JSON into the chat transcript)

User-reported and reviewer-confirmed via screenshot: LEADER chat bubbles show raw JSON like
`{"kind":"question","answer":"...","plan":null}` instead of clean prose.

## Root cause
Every `codex exec` call in Tandem uses `--output-schema`, which forces the model's entire final
response TEXT to literally BE the schema-conformant JSON (this is OpenAI Structured Outputs
behavior, not a Codex quirk — confirmed in D36/D37 live testing). `handleCodexJsonLine` in
`src/agents/codex-cli/exec.ts` unconditionally forwards every `item.completed` `agent_message`
event's text to the `onText` callback:
```ts
if (event.item.type === "agent_message" && event.item.text) {
  options.onText?.(event.item.text);
  return;
}
```
`codex-cli/leader.ts` and `codex-cli/worker.ts` both wire `onText: options.onLeaderText` /
`onText: options.onWorkerText` straight into this, so the raw schema JSON streams live into the
chat transcript exactly like normal AI-SDK conversational prose would — but it isn't prose, it's
the artifact. This affects every Codex-backed call: leader plan/question, leader review, leader
takeover, and worker build all use `--output-schema`, so all four are equally affected (the
screenshot only shows the question/triage case because that's what the user happened to run).

Note the correct, already-working parity: for the AI-SDK path, a question-kind answer is shown
via the existing `onDoneEvent` handler in `app/renderer/src/main.tsx` (`appendMessage("system",
event.summary...)`), NOT as a live LEADER bubble — the live LEADER bubble during AI-SDK planning
shows the model's genuine free-form commentary before it calls `submit_build_plan` as a separate
tool call. `codexLeaderPlan` already returns `{ kind: "answer", answer: result.answer }` which
already flows correctly into `runOrchestration`'s `summary` → the DONE event → that same SYSTEM
line. **No new display mechanism is needed — the fix is purely to stop the erroneous live
forwarding of raw JSON; the clean answer already reaches the user correctly once that stops.**

## D39-1: Stop forwarding schema-constrained agent_message text as live chat text
In `handleCodexJsonLine` (`exec.ts`), do not call `options.onText?.(...)` for `agent_message`
items — every codex-cli invocation in this codebase is schema-constrained via `--output-schema`,
so this text is always the structured artifact, never conversational prose worth streaming live.
(If you find evidence in testing that Codex ever emits a genuine free-text `agent_message`
BEFORE its final structured one in a multi-turn exchange, distinguishing that from the final
artifact is out of scope for this round — removing all `agent_message`→`onText` forwarding is
the correct, safe default given the architecture, and the activity strip already shows live tool
activity via `item.started`/`item.completed` `command_execution` events, so the UI does not go
silent during a run.)
Keep `onToolEvent` forwarding for `command_execution` (and other non-agent_message item types)
exactly as-is — only the `agent_message`→`onText` line changes.

## D39-2: Verify the clean result still surfaces correctly for every call kind
- Leader question: unchanged, already correct (see above) — verify no LEADER bubble with raw
  JSON appears, and the SYSTEM/DONE line shows the clean answer text.
- Leader plan (implementation): verify the BuildPlan artifact card still renders correctly
  (it's driven by the `emit({type:"artifact", name:"BuildPlan", ...})` machine event, not by
  `onText`, so should be unaffected — confirm this in testing, don't just assume).
- Worker build: verify the CompletionReport artifact card renders correctly (same
  artifact-event mechanism, should be unaffected) and no raw JSON appears in a WORKER bubble.
- Leader review / takeover: same check for ReviewVerdict / takeover report.

## Acceptance
tsc + `npm test` green (add/adjust a test on `handleCodexJsonLine` asserting `onText` is never
called for `agent_message` events); commit `D39-1:`. Reviewer will drive the real desktop app
(not just function calls) for at least: one Codex-leader direct question (expect a clean SYSTEM
answer line, no raw-JSON LEADER bubble), and one Codex-backed build (expect the BuildPlan and
CompletionReport artifact cards to render normally, no raw-JSON bubbles anywhere in the
transcript).
