# Handoff D98 (batch: run-observability fixes from a real live run + worker nudge)

All five items come from ONE real live run analyzed end-to-end tonight (session
`766b8f97-3e97-4331-9864-dc3f995868a2`, project `tandem_hyperframe_video`, pre-D97 build,
leader=worker=minimax/minimax-m3: plan → worker failed 3 attempts → 20-min leader takeover →
completed). The session log is the evidence for every item; read it with bounded reads (it's
1.3MB).

## D98-1 (investigate FIRST, then fix): leader streaming is invisible in the desktop app

Confirmed from the session log: across the ENTIRE run — leader planning (~3 min), and a
20-minute takeover with 89 leader tool calls, 7.7M leader input / 45.7k output tokens — there
are ZERO `text` or `thinking` events with `role:"leader"`. All 2,643 streamed deltas are
`role:"worker"`. The desktop service wiring EXISTS (`app/main/tandem-service.ts:211-214` passes
`onLeaderText`/`onLeaderThinking` into `createLiveAgents`), and `live.ts`'s plan/takeover calls
pass `onText: options.onLeaderText, onThinking: options.onLeaderThinking` into
`runAgentArtifact`. Yet nothing arrives. Same model, same runner code path as the worker (whose
deltas DO flow), so the difference is somewhere in how the leader calls differ from worker
calls (readOnly toolset? stopToolName? the runner's handling of reasoning-vs-text deltas for
this provider on these call shapes?). Do NOT guess: instrument or reproduce with a real
minimax leader call through `runAgentArtifact` and find where the deltas are dropped, then fix.
Note D95-2's finding (providers can route reasoning through `reasoning-delta` while text-delta
carries only a stray `</think>`) — the runner's reasoning-delta handling is a prime suspect,
but the worker-works/leader-doesn't asymmetry needs explaining before any fix.

## D98-2: activity strip is stale and mislabeled (the user-visible symptom)

Real user confusion tonight: the strip showed `WORKER thinking... (1181s)` when in truth the
worker had been silent for 1181 seconds, the leader had taken over (invisibly, per D98-1), and
the run had just completed. Three renderer fixes in `app/renderer/src/main.tsx`:
- `onDoneEvent` (~line 581) must clear `activityPulse` and `activeTool` (it currently only
  resets `running`/phase).
- The pulse label (~line 1113) is computed as `secondsSince(activityPulse.startedAt, ...)`
  where `markActivity` (~line 361) resets `startedAt` on EVERY delta — so the number displayed
  is really "seconds since last output". Relabel honestly: after a threshold of silence (say
  >10s since last delta), render "no output for Ns" instead of "thinking... (Ns)" — or clear
  the pulse entirely and let the existing no-activity stall warning carry the message. Keep it
  simple; don't build a new activity system.
- When a TOOL event for role X arrives while the pulse belongs to role Y, the pulse is stale by
  definition — clear or reassign it (tonight the strip kept saying WORKER while LEADER tool
  calls were running; `stripRole` falls back to the stale pulse between tool events).

## D98-3: minimax-m3 has no costHints — UI showed $0.0000 for a 16.5M-token run

`src/config/schema.ts` `defaultConfig.customModels`: the `minimax/minimax-m2.7` entry has
`costHints` (0.3/1.2 per million) but `minimax/minimax-m3` has NONE — so tonight's run
displayed `$0.0000` in the header while consuming 16.5M input tokens total. Add real costHints
for m3 (check MiniMax's current published pricing; if it genuinely can't be determined, use
m2.7's as an approximation with a code comment saying so). Also: the header cost display
(`app/renderer/src/main.tsx` `totalCost`) should not present $0.0000 as if free when tokens
are nonzero and the model has no costHints — show token counts in that case (e.g.
"16.5M in / 112k out, price unknown") rather than a false zero.

## D98-4: cost-event spam is 45% of the session log

Tonight's log: 2,659 of 5,924 events are `cost` events, including literal identical triplicates
at the same millisecond (three back-to-back at 00:40:32.993). `emitMachine` appends a cost
event alongside every machine event, and other paths append more. Debounce/dedupe at the
service layer: skip appending a cost event whose payload is identical to the last one appended,
and/or coalesce to at most one per second. UI can keep receiving every update via IPC — this is
about PERSISTED log volume (relates to D91's bounding work; this is the volume dimension, that
was the size-per-event dimension).

## D98-5: worker nudge-before-restart (12 minutes burned tonight)

Worker attempts 1 and 2 (~6 min each) did REAL work (211 tool calls) then ended without calling
`submit_completion_report` — each retry restarted from scratch. For the AI-SDK worker path
(`live.ts` build), before failing the attempt, send ONE follow-up turn on the same conversation:
"You did not call submit_completion_report. Call it now with your report." — only if the turn
ended without the tool call and without exhausting `maxStepsPerAgentTurn` budget... actually
simplest robust shape: after the stream completes with no artifact, if there's budget left,
push the nudge message and continue the same `runAgentArtifact` conversation for a few more
steps rather than throwing immediately. Mirror the pattern D95 used for takeover (step floor)
in spirit: cheap insurance against a formality failure wasting a whole attempt. D97's
retry-with-feedback already tells the NEXT attempt what went wrong — this item avoids burning
the attempt at all. Keep scope to the AI-SDK worker; CLI workers restart by nature.

## Acceptance

tsc + `npm test` green (isolated HOME if a desktop app instance is running — see D97's note).
D98-1: reproduction + root-cause explanation in the completion report, fix verified by a real
minimax-leader run whose session log contains `role:"leader"` text/thinking events. D98-2:
regression tests for the strip-clearing logic where practical (the session-state/pure parts);
manual/live check that a completed run clears the strip. D98-3: config test asserting m3 has
costHints; UI shows tokens when hints are absent (test the formatting function). D98-4: test
that identical consecutive cost payloads are not persisted twice; measure the event-count
reduction on a synthetic burst in the completion report. D98-5: regression test with a mock
stream that ends without the artifact and asserts the nudge turn is attempted before the
attempt fails. Live verification for the batch: one real all-MiniMax run on the current build
confirming (a) leader deltas now visible, (b) strip clears at DONE, (c) header shows a real
dollar figure, (d) cost events in the new session's log are deduped. Commit `D98-<n>:`, create
`handoffs/D98_done.txt`.

## Context notes for the implementer

- D97 (orchestrator-run verification + retry-with-feedback) is implemented and reviewed at the
  code level but NOT yet live-verified in the packaged app (blocked on the app being in use) —
  it exactly addresses tonight's attempt-3 failure ("omitted verification commands"). Don't
  duplicate its scope here.
- The D97 handoff's acceptance live-runs remain owed; if you rebuild the packaged app for this
  round's live checks while no user instance is running, note it so the reviewer can combine
  verification passes.
