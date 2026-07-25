# Handoff D160 (RemoteBridge is constructed without real `submitPrompt`/`subscribeSessionEvents` implementations - the entire Step 1+2 feature has never actually been connected to a real running session)

## The gap (confirmed live, don't re-derive)

Live human testing (real paired Telegram bot, candidate-preview build with D158+D159's
fixes) sent `/prompt hi` after `/use`-ing a session and got back: **"Prompt submission
is unavailable in this build."** That exact string comes from `bridge.ts`'s
`handlePrompt`:

```ts
if (!this.deps.submitPrompt) {
  await this.send(message.chatId, "Prompt submission is unavailable in this build.", "prompt-unavailable");
  return;
}
```

Confirmed by direct code search: `grep -n "submitPrompt" app/main/tandem-service.ts`
returns zero matches. The real `RemoteBridge` construction
(`app/main/tandem-service.ts:151-166`) passes `auditPath`, `transportFactory`,
`tokenProvider`, `statusProvider`, `sessionsProvider`, and `actions` (pause/resume/
stop/useSession) - but never `submitPrompt` and never `subscribeSessionEvents`
(the dependency Step 1's streaming gateway needs, per `RemoteBridgeDeps` in
`bridge.ts:94-99`). D158 correctly wired the *dispatch* path (bridge.ts recognizes
`/prompt`/`/cancel`, routes to handlers, handles reply-to-live-message) but never wired
the actual *production dependency injection* that connects those handlers to a real
running Tandem session. This means the entire Step 1 (streaming) and Step 2 (prompt
submission) feature set has, as far as can be confirmed right now, **never been
exercised against a real session in the actual app** - every earlier "it worked" signal
this session was either a rate-limit message or a local proof script, not a live
round-trip through `TandemService`.

## Fix

Wire real implementations for both missing dependencies in
`app/main/tandem-service.ts`'s `RemoteBridge` construction:

1. **`submitPrompt: SessionPromptSubmission`** (type defined in
   `src/remote-control/prompt-submission.ts:21-23`, takes
   `{ chatId, sessionId, text }`, returns
   `Promise<SessionPromptSubmissionResult>` - `submitted` /
   `requires-approval` / `rejected`). Find the real, existing internal path
   `TandemService` already uses when a human types a message into the desktop UI's own
   session view and hits send - `resumeSession(id)` (`tandem-service.ts:392`) looks
   like the closest existing entry point but confirm what it actually does and whether
   it alone submits new text or only reopens a session; trace the real desktop
   send-message IPC handler (likely `app/main/index.ts` or wherever the renderer's
   "send" button's IPC channel is handled) to find the actual prompt-injection call and
   reuse that, not reimplement submission logic from scratch.
2. **`subscribeSessionEvents: SessionEventSubscription`** (type defined in
   `src/remote-control/streaming-session.ts` per Step 1's plan) - wire this to
   whatever `TandemService` already uses to emit session events to the desktop
   renderer (there is clearly an existing event-emission path, since the desktop UI
   itself shows live streaming output - reuse that, don't build a parallel one).
3. After wiring both, grep the entire `src/remote-control/` and `app/main/` tree for
   any other `"...unavailable in this build"`-style stub/placeholder strings or
   `if (!this.deps.X)` guards that might reveal further un-wired dependencies - do not
   assume these two are the only ones; this is the second wiring gap found in as many
   rounds (D158, now this), so a thorough sweep is warranted before declaring the
   feature complete.
4. **UX fix, human-requested**: don't require `/prompt` or a reply-to-message for
   every message. Once a session is selected for a chat (`selectedSessionsByChat` in
   `bridge.ts` already tracks this from `/use`), a plain message with no recognized
   verb and no `replyToMessageId` should still route to `handlePrompt` using that
   selected session - not fall through to the "Supported commands: ..." unknown-command
   reply. `handlePrompt` already resolves the session correctly via
   `repliedStream?.sessionId ?? this.selectedSessionsByChat.get(message.chatId)`
   (`bridge.ts`, inside `handlePrompt`) - the only change needed is at the dispatch
   fallback near the end of `handleMessage` (currently
   `if (message.replyToMessageId !== undefined) { await this.handlePrompt(...); return; }`
   followed by the unknown-command reply): also call `handlePrompt` when
   `this.selectedSessionsByChat.has(message.chatId)` is true, even without a reply
   context. Keep the "Supported commands: ..." fallback only for the case where there
   is truly no reply context *and* no selected session - that's the only situation
   where the bot genuinely doesn't know what to do with free text. `/prompt` and
   replying to a specific live message should remain valid alternate ways to submit a
   prompt (useful for targeting a *different* session than the currently selected one),
   this just adds the third, more natural "just type" path as the common case.

## Constraints

- Do not change `prompt-submission.ts`'s or `streaming-session.ts`'s own logic unless
  wiring them up reveals a genuine bug in them - the gap identified here is
  specifically about the missing connection to real `TandemService` session state.
- Do not weaken pairing, sender authorization, or rate limiting to make this easier.
- Do not touch Step 3 (approval integration, not yet started) scope - the
  `requires-approval` result status already has a placeholder message
  ("approval routing is not enabled for this stream yet") and that's expected to stay
  a placeholder until Step 3 actually lands.
- Do not claim this is done based on unit tests or a local script alone - see
  Acceptance below. Two previous rounds (D158, and implicitly the original Step 1/2
  acceptance) passed exactly that kind of verification while shipping something
  completely non-functional end-to-end.

## Acceptance

Explain in `handoffs/D160_done.txt` exactly what real `TandemService` methods
`submitPrompt` and `subscribeSessionEvents` now call into, and paste the actual
wiring diff context (not just a description). Live proof, mandatory this time via an
actual rebuilt-and-relaunched candidate-preview against a real paired Telegram bot (the
same process the human has been using all session) - not a local script: `/use` a real
session, then send a **plain message with no `/prompt` prefix and no reply** (proving
point 4 above), and separately show `/prompt <text>` and a reply-to-live-message still
working too, and show the assistant's real response actually streaming back into the
Telegram message for at least the plain-message case, with the corresponding
`remote-control-audit.jsonl` entries. If you cannot drive a real Telegram round-trip
yourself in this environment, say so explicitly and describe exactly what manual step
a human needs to take to complete the live proof - do not substitute a local dispatch-
path script and call it sufficient, given that exact substitution already let two prior
gaps through. tsc + `npm test` green. Commit `D160-<n>:`. Create
`handoffs/D160_done.txt`.
