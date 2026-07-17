# W0013 Run-Health and Stall Visibility

Objective: surface an honest run-health state in the desktop UI so users can
tell whether a long-running turn is healthy (worker mid-build), silently
finished, or genuinely stuck, and so post-hoc analysis of the session JSONL
sees the same health transitions. Track the last meaningful event
(model delta, tool call, phase transition, artifact, or notice) per run
and emit a `heartbeat` machine event whenever the derived health state
crosses one of three thresholds: `healthy` (recent activity),
`quiet Ns` (silent longer than a short threshold), or `likely stalled`
(silent longer than the stall threshold, default 3 minutes). UI-only
signaling; no automatic run cancellation.

This epic is `autonomy=full`, so once the plan candidate is independently
accepted, the relay auto-approves it and step turns may begin immediately.

## Background

`src/orchestrator/machine.ts` already emits `transition`, `artifact`,
`notice`, `error`, and `checkpoint` machine events and surfaces them
through `options.emit`; `app/main/tandem-service.ts` already forwards
those events to the renderer via `ipcChannels.machineEvent` and persists
them to the session JSONL through `session.append("machine", event)`.
`app/renderer/src/activity-strip.ts` currently infers a stalled model
state from `secondsSince(activityPulse.startedAt, activityTick)`, where
`activityPulse` is updated only when `appendStream`/`appendThinking`
sees a non-empty text delta from the model. That signal misses three
honest cases: (1) the model is between deltas but the orchestrator is
otherwise healthy (phase transition, tool call, checkpoint), so the
renderer paints "thinking..." while the run is silently waiting on a
tool or compaction; (2) the model call is genuinely stalled, but no
delta has arrived so the renderer cannot tell "stalled" from "still
streaming silently"; (3) a takeover or rate-limit error path produces
no model deltas at all, so the renderer can stay frozen on
"thinking..." long after the run ended.

## Ordered Steps

- [ ] Step 1: add the orchestration-level `RunHealthTracker`, emit `heartbeat` machine events on state transitions, persist them in the session JSONL, and surface them through a new IPC channel.
- [ ] Step 2: replace the renderer's silent-stall inference with the orchestrator's run-health state, so the activity strip and session log show a single honest "healthy / quiet Ns / likely stalled" indicator instead of a stale "thinking..." pulse.

## Invariants for every step

- Perform exactly one step per relay candidate and check only the implemented step box in the same commit.
- Keep `npm run typecheck`, `npm test`, and `git diff --check` green after every step.
- No automatic run cancellation, no new abort signal, no change to the existing `tandem.abortPipeline` path. The stall indicator is purely UI signaling plus JSONL logging.
- The thresholds are configuration constants (defaults: `quietSeconds = 30`, `stalledSeconds = 180`) so users / future config can tune them. The defaults match the wishlist example (3 minutes).
- The "last meaningful event" set is exactly `{ transition, artifact, notice, checkpoint }` plus model text deltas and tool events surfaced through the existing `textEvent`/`toolEvent` paths. Heartbeat self-emissions are excluded so a heartbeat cannot mark the run as healthy.
- `RunHealthTracker` is a pure module with no `Date.now()` calls; it accepts `now()` injection so tests can use `vi.useFakeTimers()` for deterministic transitions.
- Do not modify `app/renderer/src/activity-strip.ts`'s existing public signature in a breaking way; the optional `runHealth` override is additive.
- Do not weaken any existing orchestrator, cost, renderer-cost-display, or activity-strip tests; this epic builds on them.

## Step 1 — Orchestration-level run-health tracker, heartbeat events, and JSONL persistence

Files expected (≤ 6 production files):

- `src/orchestrator/run-health.ts` (new, ≤ 120 lines): export `RunHealthState = "healthy" | "quiet" | "stalled"` and `RunHealthSnapshot` (`{ state, lastEventAt, lastEventKind, lastEventRole?, phase, elapsedMs, quietSeconds, stalledSeconds }`). Export `RunHealthTracker` with constructor `(opts: { quietSeconds: number; stalledSeconds: number; now?: () => number; role?: "leader" | "worker" })`. Methods: `recordMeaningful(input: { kind: "modelDelta" | "toolCall" | "transition" | "artifact" | "notice" | "checkpoint"; role?: "leader" | "worker"; phase?: MachinePhase; at?: number })` (returns `RunHealthSnapshot | undefined` when state changed) and `snapshot(input: { phase: MachinePhase; at?: number })` (returns current `RunHealthSnapshot` without recording). Excluded event kinds (`"heartbeat"`) must not count as meaningful.
- `src/orchestrator/machine.ts`:
  - Extend `MachineEvent` with `{ type: "heartbeat"; state: RunHealthState; lastEventAt: number; lastEventKind: string; lastEventRole?: "leader" | "worker"; phase: MachinePhase; elapsedMs: number; quietSeconds: number; stalledSeconds: number; }`.
  - In `runOrchestration`, construct one `RunHealthTracker` (defaults `quietSeconds = 30`, `stalledSeconds = 180`, `now = Date.now`). Wrap the user-supplied `emit` so that every `transition`, `artifact`, `notice`, and `checkpoint` also calls `tracker.recordMeaningful(...)`. Heartbeat events (the ones this epic emits) must skip the tracker so they cannot self-confirm health. Emit `tracker.snapshot(...)` once at the start of each new phase transition if it differs from the last emitted state.
  - Extend `RunOptions` with optional `runHealth?: RunHealthTracker` and `heartbeatIntervalMs?: number` so step 2 and tests can drive the ticker themselves; do not change the existing default behavior when these are unset.
- `app/main/tandem-service.ts`:
  - In `run`, start a `setInterval` of `heartbeatIntervalMs = 5000` that calls `tracker.snapshot({ phase })`; if the state changed since the last snapshot, emit a `heartbeat` machine event (which both `emitMachine` and the renderer will receive). Stop the interval in the `finally` block of `run`.
  - In `emitMachine`, if the event is a `heartbeat`, also send it on a new `ipcChannels.heartbeatEvent` so the renderer can update without parsing every machine event. The same event still goes through the JSONL via `session.append("machine", event)`.
- `app/shared/ipc.ts`:
  - Add `heartbeatEvent: "evt:heartbeat"` to `ipcChannels`.
  - Export `RunHeartbeatEvent` (the same shape as the machine heartbeat) and re-export `RunHealthState`. Add `onHeartbeatEvent(callback: (event: RunHeartbeatEvent) => void): () => void` to `TandemDesktopApi`.
  - Add `heartbeat?: RunHeartbeatEvent` to `SessionResumeResponse` so a resumed session can show the last known health instead of "thinking..." on first paint.
- `app/preload/index.ts`: forward the new `heartbeatEvent` channel through `onHeartbeatEvent`.
- `tests/orchestrator.test.ts`: add tests covering `RunHealthTracker` with an injected clock:
  - `recordMeaningful` with `modelDelta` resets elapsed to zero and returns a `healthy` snapshot.
  - Calling `snapshot` after 31 s returns `quiet`, after 181 s returns `stalled`, and state transitions emit a fresh snapshot exactly when the bucket changes (no duplicate emissions).
  - Heartbeat self-emissions do not record as meaningful (a `recordMeaningful({ kind: "heartbeat" })` is a no-op).
- `tests/run-health.test.ts` (new, ≤ 80 lines): direct unit tests for `RunHealthTracker` covering thresholds, role propagation, and the `snapshot`/`recordMeaningful` split.
- `tests/desktop-service.test.ts`: extend the existing fake-window harness with one test that runs a multi-step build, asserts at least one `evt:heartbeat` IPC payload was sent, and asserts a corresponding `machine` event of type `heartbeat` was appended to the session JSONL.

Acceptance evidence:

- A new unit test (`tests/run-health.test.ts`) drives `RunHealthTracker` through `healthy -> quiet -> stalled` with `vi.useFakeTimers()` and asserts each transition emits exactly once.
- A new test in `tests/desktop-service.test.ts` exercises a real `run` cycle, captures every `evt:heartbeat` payload and every `session.append("machine", ...)` call, and asserts both contain at least one `heartbeat` event whose `state` matches the elapsed-time bucket the fake clock reported.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Step 2 — Renderer activity strip uses run-health instead of pulse clock

Files expected (≤ 6 production files):

- `app/renderer/src/run-health-display.ts` (new, ≤ 60 lines): export pure `formatRunHealth(snapshot: RunHeartbeatEvent)` returning `{ label: string; stalled: boolean; cssClass: "healthy" | "quiet" | "stalled" }`. `healthy` becomes `"healthy"`; `quiet` becomes `"quiet (Ns since last <event-kind>)"`; `stalled` becomes `"likely stalled (Ns since last <event-kind>) - Stop to abort"`. Always include `phase` (e.g. `"BUILDING"`) and the role if present. Use the existing `MODEL_STALL_WARNING_SECONDS = 180` constant from `session-state.ts` for the `stalled` styling parity; export a new `RUN_HEALTH_QUIET_SECONDS = 30` constant next to it so the formatter and tracker thresholds stay aligned.
- `app/renderer/src/activity-strip.ts`: extend the `activityStripState` input with optional `runHealth?: RunHeartbeatEvent`. When `runHealth` is present, return `{ role: runHealth.lastEventRole ?? input.fallbackRole, text: formatRunHealth(runHealth).label, stalled: runHealth.state === "stalled" }` and ignore `activityPulse`/`activeTool` for the text (the active tool call is still surfaced elsewhere in the UI). When `runHealth` is absent, keep the existing behavior so tests that don't supply it keep working unchanged.
- `app/renderer/src/main.tsx`:
  - Add `const [runHealth, setRunHealth] = useState<RunHeartbeatEvent | undefined>();`.
  - Subscribe to `tandem.onHeartbeatEvent(setRunHealth)` in the existing `useEffect` cleanup block.
  - Reset `runHealth` in `applyStartedSession` (new session) and on `onDoneEvent` (run end). Initialize from `resumed.checkpoint` / `resumed.events` by replaying the last `heartbeat` machine event so a resumed session shows the last known health instead of an empty pulse.
  - Pass `runHealth` to `activityStripState(...)`. Keep `lastActivityAt`/`activityTick` only as a fallback for runs without heartbeats (none in practice after Step 1, but defensively the old code path stays).
- `app/shared/ipc.ts` (Step 2 may extend): add `lastHeartbeat?: RunHeartbeatEvent` to `SessionResumeResponse` so the renderer can paint health on first paint without waiting for the next tick.
- `app/main/tandem-service.ts`: in `resumeSession`, scan `events` in reverse for the last `machine` event whose payload `type === "heartbeat"` and return it as `lastHeartbeat`. Reuse the existing `findLastCheckpoint` helper shape.
- `tests/renderer-run-health-display.test.ts` (new, ≤ 80 lines): regression tests for `formatRunHealth` covering the `healthy` / `quiet` / `stalled` branches, the role fallback to `phase` ("BUILDING"), and the `stalled` label's "Stop to abort" wording.
- `tests/renderer-activity-strip.test.ts`: add a test that supplies a `runHealth` snapshot and asserts the strip text matches `formatRunHealth(...)` and ignores any stale `activityPulse` text. Keep the existing two tests as-is so the pulse-only fallback path is still covered.
- `tests/desktop-service.test.ts`: add one test that `resumeSession` on a session JSONL containing a prior `heartbeat` event returns that heartbeat as `lastHeartbeat` and ignores older heartbeats.

Acceptance evidence:

- A new test in `tests/renderer-activity-strip.test.ts` shows the strip text matches `formatRunHealth(...)` when `runHealth` is supplied, regardless of any stale pulse.
- A new test in `tests/desktop-service.test.ts` proves `lastHeartbeat` is the most recent `heartbeat` machine event from the JSONL, so post-hoc analysis and resumed sessions agree on the last known state.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Safety Notes

- This epic only touches run-health tracking, heartbeat event emission, and renderer display. It does not modify agent, provider, compaction, prompt, or credential code; therefore the `VALIDATE` phase's cheap real-model smoke is not required by the protocol.
- The new IPC channel and `RunHeartbeatEvent` type are additive. The desktop build, preload, and existing renderer code paths remain backward-compatible: pre-Step-2 renderer builds ignore `evt:heartbeat` messages and the new optional `lastHeartbeat` resume field.
- No automatic cancellation is introduced. The existing `tandem.abortPipeline` path is untouched; the renderer keeps surfacing "Stop to abort" only as a label hint inside the existing `Stop` button affordance, which already exists in the desktop shell.
- All edits stay inside `src/orchestrator/run-health.ts`, `src/orchestrator/machine.ts`, `app/main/tandem-service.ts`, `app/shared/ipc.ts`, `app/preload/index.ts`, `app/renderer/src/run-health-display.ts`, `app/renderer/src/activity-strip.ts`, `app/renderer/src/main.tsx`, and tests under `tests/`. No protocol, reciprocal script, branch topology, dependency, or credential changes are in scope.