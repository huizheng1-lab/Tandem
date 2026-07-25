# Handoff D161 (Telegram streaming never delivers a live-updating message - and the failure is completely silent, with no error trace anywhere)

## The gap (confirmed live, don't re-derive)

D160 wired real `submitPrompt`/`subscribeSessionEvents` into `TandemService`. Live
human testing confirms the *submission* half now genuinely works: a plain message
(no `/prompt` prefix) reaches the real session, the assistant actually processes it,
and a real response appears in the session log
(`state\candidate-preview\sessions\...\<sessionId>.jsonl` shows a genuine
`BuildPlanOrAnswer`/`done` with real AI text). But **the response never appears in
Telegram** - only in the desktop app's own chat view. The human confirmed: "it
receives my prompt now! but i cannot see its response in telegram, only in the desktop
app chat box."

I traced the code path as far as I could from outside the running process:

- `TandemService.emitText`/`emitMachine` call `emitRemoteSessionEvent`, which looks up
  `this.remoteSessionSubscribers.get(this.session?.id)` and notifies subscribers - this
  part is plausible from reading the code.
- `RemoteBridge.handlePrompt` calls `startSessionStream` (which subscribes via
  `subscribeRemoteSessionEvents`) *before* calling `submitRemotePrompt` - the ordering
  is correct per the D160 diff.
- `StreamingSessionGateway.receive()` (`streaming-session.ts:88-128`) accumulates event
  state and throttles a flush via `setTimeout(..., this.throttleMs)` (default 1500ms);
  on `ended`, it flushes immediately (or after the remaining throttle window) and calls
  `onEnd`.
- `TelegramSessionStream`'s `enqueue`/`drain` (`telegram-session-stream.ts:87-126`)
  should call `this.options.telegram.editMessage` for every flushed snapshot.

**The critical problem**: `drain()`'s `catch` block (`telegram-session-stream.ts:118-121`)
is completely silent:

```ts
} catch {
  this.stop();
  return;
}
```

If `editMessage` throws for *any* reason - a Telegram API error (e.g. "message is not
modified", a transient network failure, a malformed request), a bug in
`formatStreamingSnapshot`, anything - the entire stream just quietly dies. No log line,
no audit entry (`RemoteBridge`'s audit trail only logs `send()` calls made through the
bridge itself, not `editMessage` calls made directly by `TelegramSessionStream` - so
`remote-control-audit.jsonl` shows nothing either way, whether editMessage was never
attempted or was attempted and failed). I could not tell from outside the process
whether: (a) the subscription never actually delivered events to the gateway at all, or
(b) events were received and a flush was attempted, but `editMessage` itself failed and
was silently swallowed. This ambiguity is itself a bug that needs fixing regardless of
which of the two is the root cause.

## Fix

1. **Root-cause and fix the actual streaming failure.** With full codebase access and
   the ability to add temporary instrumentation/run locally, determine whether the
   subscription is genuinely not delivering events, or whether `editMessage` is being
   called and failing (and if so, with what actual Telegram API error). Fix whichever
   is true. Two concrete things worth checking specifically: (a) whether
   `this.session?.id` in `emitRemoteSessionEvent` reliably matches the `sessionId` the
   stream subscribed with at every point during the run (a resumed/switched session
   mid-run could change `this.session.id` out from under the subscriber lookup); (b)
   whether Telegram's `editMessageText` is rejecting the very first real edit for a
   reason like "message is not modified" (if the first flushed snapshot's formatted
   text happens to coincide with the placeholder, or some other formatting edge case).
2. **Stop swallowing errors silently in `TelegramSessionStream.drain()`.** At minimum,
   route the caught error through the same `onError`/audit mechanism the rest of the
   remote-control system already uses (`RemoteBridge`'s `audit()` method, or the
   transport's `onError` callback) before stopping the stream, so a future failure of
   this kind is immediately visible in `remote-control-audit.jsonl` instead of requiring
   a full code trace to even locate. This applies whether or not it turns out to be the
   actual root cause of this specific bug - it's a real diagnosability gap either way.
3. Similarly consider whether `StreamingSessionGateway`'s `subscribe()` call
   (`streaming-session.ts:74`) should surface a failure/no-op case audibly if
   `this.options.subscribe` doesn't actually deliver anything within a reasonable time
   (e.g., no snapshot at all before the run's `ended` event arrives) - not required if
   the root cause turns out to be something else, but worth a quick look given how
   opaque this failure mode was to diagnose from outside.

## Constraints

- Do not change the throttle/coalescing behavior itself (`DEFAULT_THROTTLE_MS`,
  the snapshot versioning) unless you find it's actually the cause - this handoff is
  about a delivery failure, not the pacing.
- Do not weaken pairing, authorization, or rate limiting.
- Do not touch Step 3 (approval integration) scope.

## Acceptance

Explain in `handoffs/D161_done.txt` the actual root cause you found (not a guess -
show the real error or the real gap in subscription delivery, however you diagnosed
it), and how error visibility was improved so this class of failure is never silent
again. Live proof, mandatory and real (per the same standard as D160 - no local-script
substitute): rebuild and relaunch the candidate-preview, `/use` a real session, send a
plain message, and show the assistant's real response actually appearing and updating
live inside the Telegram message via `editMessage`, with either the newly-added error
visibility confirming a clean run, or (if you can safely reproduce it) the previously-
silent failure now correctly surfaced. tsc + `npm test` green. Commit `D161-<n>:`.
Create `handoffs/D161_done.txt`.
