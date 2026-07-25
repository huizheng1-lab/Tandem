# Handoff D159 (Telegram long-polling offset is never persisted - every process restart re-delivers and reprocesses the entire backlog of old updates, burning the rate limit before new messages get through)

## The bug (confirmed live, don't re-derive)

`TelegramLongPollingTransport` (`src/remote-control/telegram.ts:34-141`) tracks its
polling offset as a plain in-memory instance field:

```ts
export class TelegramLongPollingTransport implements RemoteTransport {
  private stopped = true;
  private offset = 0;
  ...
```

It is correctly advanced on every processed update
(`this.offset = Math.max(this.offset, update.update_id + 1)`, line 87) - that part is
right. The bug is that this value is **never persisted anywhere** - it lives only in
that one process's memory. The moment the process restarts (which happens routinely -
a preview relaunch, a crash, a `Stop-Process`, an app update), a brand-new transport
instance starts again at `offset = 0`. Telegram's Bot API retains unacknowledged
updates for a rolling window and will redeliver the *entire backlog* to any
`getUpdates` call whose offset doesn't yet exclude them - so every restart re-delivers
and reprocesses every update since the last time the offset was durably advanced,
which in this system is never.

Live evidence: after multiple candidate-preview restarts during tonight's testing, the
human sent one real `/use` command and one real chat message - the audit log
(`remote-control-audit.jsonl`) instead showed the *same* `/use` command (identical
`argsHash`, identical `sessionId`) landing 5+ times within ~500ms, immediately after a
freshly-restarted, single-process preview - not a duplicate-process issue (verified
only one Tandem process group was running), and not user error (verified via the
`RATE_LIMIT_MAX=10` / `RATE_LIMIT_WINDOW_MS=60000` constants in `bridge.ts` - the
replayed backlog alone consumed the entire window, correctly triggering "Remote control
is cooling down" before any new message could be processed). Restarting the process
again reproduced the identical replay, confirming this is not transient.

## Fix

Persist the offset durably so a process restart does not cause Telegram to redeliver
already-processed updates:

1. Write the offset to a small file after each successful `getUpdates` batch (or after
   each processed update, whichever is simpler and still correct) - a natural location
   is alongside the existing `remote-control-audit.jsonl` / pairing config, in whatever
   directory `RemoteBridge`'s deps already resolve for that instance's durable state
   (do not hardcode a path - thread it through the same way `auditPath` already is).
2. On startup, read the persisted offset (defaulting to 0 only if no file exists yet -
   e.g., true first run) and pass it into `TelegramLongPollingTransport` so the very
   first `getUpdates` call after a restart already excludes previously-processed
   updates.
3. Decide the simplest correct persistence mechanism - a single small JSON/text file
   with just the offset integer is enough; this does not need a database or the
   existing audit-log format.

## Constraints

- Do not change the rate limiter itself (`RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX` in
  `bridge.ts`) - it is working correctly; it was only ever seeing replayed traffic, not
  genuine abuse. Fixing the replay bug is the correct fix, not loosening the limiter.
- Do not change the offset-advancement logic inside the polling loop itself
  (`telegram.ts:86-120`) - it already correctly computes the right in-memory value on
  each update; the only gap is that value never reaching disk.
- Do not add offset persistence in a way that could silently skip real messages if the
  persisted file is corrupted or unreadable - fail safe (treat unreadable/missing as
  "start from 0, accept the one-time backlog replay" rather than crash or silently drop
  legitimate future messages).

## Acceptance

Explain in `handoffs/D159_done.txt` where the offset file lives and exactly when it's
written and read. Add a regression proving: a transport instance processes some
updates, a *new* transport instance constructed with the persisted offset does not
re-receive those same update IDs (mock the Telegram API to assert the `offset` query
parameter on the second instance's first `getUpdates` call is at least
`lastProcessedUpdateId + 1`). Live proof: restart the real candidate-preview process
(or a safe equivalent) after processing a real message, and show via
`remote-control-audit.jsonl` that the restart does not reprocess that same message
again. tsc + `npm test` green. Commit `D159-<n>:`. Create `handoffs/D159_done.txt`.
