# Handoff D158 (W0016 Step 2's `/prompt`/`/cancel`/reply-routing was never actually wired into the Telegram bridge - live human testing found real end-to-end functionality is missing)

## The gap (confirmed live by the human, then by me reading the code, don't re-derive)

The human tested the accepted W0016 step 1+2 build live via a real paired Telegram
bot (candidate preview, commit `4a563d7`). Pairing worked, `/status` worked, but
attempting to actually submit a prompt / interact the way the epic was supposed to
enable produced no response - the audit log (`remote-control-audit.jsonl`) shows the
attempt landing as `"verb":"unknown"`.

I confirmed the root cause by reading `src/remote-control/bridge.ts` directly:

- The verb-recognition whitelist (`bridge.ts:140-142`) only recognizes `pair`, `use`,
  `status`, `sessions`, `pause`, `resume`, `stop`, `revoke` - `prompt` and `cancel` are
  not present anywhere.
- The command dispatch table (`bridge.ts:229-274`) has a branch for every one of those
  same verbs and nothing else - no `command.verb === "prompt"`, no
  `command.verb === "cancel"`.
- There is no `reply_to_message` handling anywhere in `bridge.ts` - the "reply to a
  live message to route a new prompt to that session" behavior from the plan does not
  exist.
- `src/remote-control/prompt-submission.ts` (the new module Step 2 added) is never
  imported or called from `bridge.ts` at all - it is a fully isolated, unreachable
  module. Its own unit tests (`tests/remote-control-prompt-submission.test.ts`) and the
  bridge integration test (`tests/remote-control-bridge-prompt.test.ts`) apparently
  exercised it in a way that didn't catch this - check what those tests actually wire
  up vs. what real `bridge.ts` does; if the integration test constructs its own routing
  instead of exercising the real `bridge.ts` dispatch table, that's the coverage gap to
  close, not just the feature gap.

Everything else Step 2 built (`prompt-submission.ts`'s validation logic,
`telegram-session-stream.ts`'s extensions, `telegram.ts` changes) may well be correct
in isolation - the specific missing piece is the actual connection from an inbound
Telegram message to that logic.

## Fix

Wire `prompt-submission.ts` into `bridge.ts`'s real message handling, matching the
original Step 2 plan (`process/reciprocal/epics/W0016-plan.md`, "Step 2 - Prompt
submission and live reply routing") exactly:

1. Add `prompt` and `cancel` to the verb whitelist and dispatch table in `bridge.ts`,
   calling the existing `prompt-submission.ts` validation/submission logic for `prompt`
   and the appropriate stream-stop logic for `cancel`.
2. Add the reply-to-live-message routing: when an inbound Telegram update's
   `message.reply_to_message.message_id` matches a message ID currently bound to an
   active stream (the registry Step 1's `telegram-session-stream.ts` already
   maintains), treat the reply text as a `/prompt` submission to that session's bound
   `sessionId`, exactly as the plan specifies - do not require the explicit `/prompt`
   verb in that case.
3. Fix or extend `tests/remote-control-bridge-prompt.test.ts` so it genuinely exercises
   the real `bridge.ts` dispatch path end-to-end (a fake Telegram update in, a real
   call through `bridge.ts`'s actual handler, asserting the session receives the
   prompt) rather than testing `prompt-submission.ts` in isolation - this is what
   should have caught the gap before it reached a human tester.

## Constraints

- Do not touch `prompt-submission.ts`'s own validation/result-shape logic unless you
  find it's actually wrong once properly wired up - the live gap identified here is
  specifically about the missing connection, not (yet) about the validation logic's
  correctness.
- Do not weaken pairing, the allowlist, or rate limits to make this wiring easier -
  the prompt path must go through the exact same authorization checks every other
  command already does.
- Do not touch Step 1's streaming gateway or Step 3's (not-yet-started) approval
  integration scope.

## Acceptance

Explain in `handoffs/D158_done.txt` exactly what was missing and how the new
regression proves the real `bridge.ts` dispatch path (not just `prompt-submission.ts`
in isolation) now handles both an explicit `/prompt <text>` command and a reply to a
live streaming message. Live proof: since a real paired Telegram bot and live
candidate-preview build are already available (candidate `4a563d7`, or whatever is
current when this lands), demonstrate an actual `/prompt` message reaching a real
session and producing a real streamed response, and a reply-to-live-message doing the
same - paste real audit-log lines (`remote-control-audit.jsonl`) or session-log
evidence showing the prompt was genuinely received and acted on, not just that a test
assertion passed. tsc + `npm test` green. Commit `D158-<n>:`. Create
`handoffs/D158_done.txt`.
