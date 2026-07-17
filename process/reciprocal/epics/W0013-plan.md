# W0013 Run-Health and Stall Visibility

Objective: surface an honest run-health state in the desktop UI so users can
tell whether a long-running turn is healthy (worker mid-build), silently
finished, or genuinely stuck, and so post-hoc analysis of the session JSONL
sees the same health transitions. Track the last meaningful event
(model delta, tool call, phase transition, artifact, notice, or checkpoint)
per run and emit a `heartbeat` machine event whenever the derived health
state crosses one of three thresholds: `healthy` (recent activity),
`quiet Ns` (silent longer than a short threshold), or `likely stalled`
(silent longer than the stall threshold, default 3 minutes). UI-only
signaling; no automatic run cancellation.

This epic is `autonomy=full`, so once the plan candidate is independently
accepted, the relay auto-approves it and step turns may begin immediately.

## Revision history

- Revision 1 (commit `b0a4ff1`, superseded): initial 2-step plan. Reviewer
  identified four gaps that this revision fixes.
- Revision 2 (this commit): revised 2-step plan.
  - **Issue 1 fix** — single tracker owner (`TandemService`) is wired into
    `emitText`, `emitTool`, `emitMachine`, machine transitions, and the
    interval. New tests prove model and tool activity reset elapsed time
    and prevent false stall transitions.
  - **Issue 2 fix** — explicit construction, sharing, phase-update,
    deduplication, and cleanup lifecycle. `RunHealthTracker` exposes
    three unambiguous methods (`recordMeaningful` / `tick` / `snapshot`)
    with a documented change-detection contract. Interval cleanup is
    exercised by a focused test.
  - **Issue 3 fix** — `"heartbeat"` is removed from `recordMeaningful.kind`
    and self-emission exclusion happens in the `emitMachine` wrapper. The
    acceptance test verifies exclusion at the wrapper boundary instead of
    passing an invalid union member.
  - **Issue 4 fix** — single resume field `lastHeartbeat?: RunHeartbeatEvent`
    on `SessionResumeResponse`, single source of truth (`events` replay
    inside `resumeSession`), single renderer init line.

## Background

Three independent event paths feed the desktop and session JSONL today:
`emitText` (model deltas via `evt:text`), `emitTool` (tool events via
`evt:tool`), and `emitMachine` (machine events via `evt:machine`).
`runOrchestration` (`src/orchestrator/machine.ts`) emits `transition`,
`artifact`, `notice`, `error`, and `checkpoint` machine events and surfaces
them through `options.emit`. `app/main/tandem-service.ts` forwards those
events to the renderer via `ipcChannels.machineEvent` and persists them
to the session JSONL through `session.append("machine", event)`.
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

## Tracker ownership (Issue 1 + Issue 2)

`TandemService.run` is the single owner of `RunHealthTracker`. It
constructs one tracker per `run()` call, holds it for the lifetime of
that run, passes it to `runOrchestration` via `RunOptions.runHealth`,
wires it into all three emit paths, drives the heartbeat interval, and
cleans it up in `finally`.

```
TandemService.run
  ├─ const tracker = new RunHealthTracker({ quietSeconds, stalledSeconds, now: Date.now })
  ├─ runOrchestration({ ..., runHealth: tracker, emit: (event) => this.emitMachine(event) })
  ├─ setInterval(() => this.pollHeartbeat(tracker), heartbeatIntervalMs)  // cleared in finally
  ├─ emitText   → tracker.recordMeaningful({ kind: "modelDelta", role, phase: this.currentPhase })
  ├─ emitTool   → tracker.recordMeaningful({ kind: "toolCall",   role, phase: this.currentPhase })
  └─ emitMachine:
       if (event.type === "transition") this.currentPhase = event.phase
       if (event.type === "heartbeat")  return  // skip self-emission (Issue 3)
       const kind = mapMachineKind(event.type)  // transition | artifact | notice | checkpoint
       tracker.recordMeaningful({ kind, role: undefined, phase: this.currentPhase })
```

The tracker never receives `kind: "heartbeat"`, so a heartbeat cannot
self-confirm health and `recordMeaningful`'s TypeScript union stays
strict. The `role` is only meaningful for `modelDelta` and `toolCall`,
so the type uses an optional `role?: "leader" | "worker"` field; the
tracker ignores it for transition / artifact / notice / checkpoint.

## `RunHealthTracker` API (Issue 2 + Issue 3)

```ts
export type RunHealthState = "healthy" | "quiet" | "stalled";

export interface RunHealthSnapshot {
  state: RunHealthState;
  phase: MachinePhase;
  lastEventAt: number;
  lastEventKind: "modelDelta" | "toolCall" | "transition" | "artifact" | "notice" | "checkpoint";
  lastEventRole?: "leader" | "worker";
  elapsedMs: number;
  quietSeconds: number;
  stalledSeconds: number;
}

export interface RecordMeaningfulInput {
  kind: "modelDelta" | "toolCall" | "transition" | "artifact" | "notice" | "checkpoint";
  role?: "leader" | "worker";
  phase: MachinePhase;
  at?: number;
}

export interface TickInput {
  phase: MachinePhase;
  at?: number;
}

export interface SnapshotInput {
  phase: MachinePhase;
  at?: number;
}

export class RunHealthTracker {
  constructor(opts: { quietSeconds: number; stalledSeconds: number; now?: () => number });
  /**
   * Records a meaningful event and returns a fresh snapshot ONLY when the
   * bucket (`healthy` / `quiet` / `stalled`) just changed since the last
   * `recordMeaningful` or `tick` call that returned a snapshot. Returns
   * `undefined` when the bucket is unchanged. Callers use this to decide
   * whether to emit a `heartbeat` machine event in the same tick.
   */
  recordMeaningful(input: RecordMeaningfulInput): RunHealthSnapshot | undefined;
  /**
   * Like `recordMeaningful` but does not advance `lastEventAt`. The
   * interval calls this; the returned snapshot is sent as a heartbeat
   * when the bucket just changed. Two consecutive `tick` calls at the
   * same `at` return `undefined` on the second call (no bucket change).
   */
  tick(input: TickInput): RunHealthSnapshot | undefined;
  /**
   * Returns the current snapshot unconditionally, without recording and
   * without changing the dedup state. The display layer (`formatRunHealth`)
   * calls this so a stale view can refresh without spurious heartbeat
   * emissions.
   */
  snapshot(input: SnapshotInput): RunHealthSnapshot;
}
```

Three method contracts, three callers:
- `recordMeaningful` — only emit paths (`emitText`, `emitTool`, `emitMachine`).
- `tick` — only the heartbeat interval inside `TandemService.run`.
- `snapshot` — only `formatRunHealth` (Step 2) and any future display
  code that needs the current snapshot without emitting.

The internal `lastEmittedBucket` field advances exactly when a method
returns a non-`undefined` snapshot, so the next `tick()`/`recordMeaningful()`
compares against the new bucket and returns `undefined` for the rest of
that bucket window. This is the deduplication guarantee: consecutive
`ticks` at the same `at` return `undefined` on the second call.

## Ordered Steps

- [ ] Step 1: add the orchestration-level `RunHealthTracker`, emit `heartbeat` machine events on state transitions, persist them in the session JSONL, surface them through a new IPC channel, and compute `lastHeartbeat` from the session events on resume.
- [ ] Step 2: replace the renderer's silent-stall inference with the orchestrator's run-health state, so the activity strip and session log show a single honest "healthy / quiet Ns / likely stalled" indicator instead of a stale "thinking..." pulse.

## Invariants for every step

- Perform exactly one step per relay candidate and check only the implemented step box in the same commit.
- Keep `npm run typecheck`, `npm test`, and `git diff --check` green after every step.
- No automatic run cancellation, no new abort signal, no change to the existing `tandem.abortPipeline` path. The stall indicator is purely UI signaling plus JSONL logging.
- The thresholds are configuration constants (defaults: `quietSeconds = 30`, `stalledSeconds = 180`) so users / future config can tune them. The defaults match the wishlist example (3 minutes).
- The "last meaningful event" set is exactly `{ transition, artifact, notice, checkpoint }` plus model text deltas (non-empty, including `thinking`) and tool events surfaced through `emitText`/`emitTool`. `heartbeat` is NOT in the set; it is excluded at the `emitMachine` wrapper.
- `RunHealthTracker` is a pure module with no `Date.now()` calls; it accepts `now()` injection so tests can use `vi.useFakeTimers()` for deterministic transitions.
- Do not modify `app/renderer/src/activity-strip.ts`'s existing public signature in a breaking way; the optional `runHealth` override is additive.
- Do not weaken any existing orchestrator, cost, renderer-cost-display, or activity-strip tests; this epic builds on them.
- Resume contract: `SessionResumeResponse.lastHeartbeat` is the single field; renderer initialization reads ONLY this field; no event-replay in the renderer.

## Step 1 — Orchestration-level run-health tracker, heartbeat events, and JSONL persistence

Files expected (≤ 6 production files):

- `src/orchestrator/run-health.ts` (new, ≤ 160 lines): export
  `RunHealthState`, `RunHealthSnapshot`, `RecordMeaningfulInput`,
  `TickInput`, `SnapshotInput`, and `RunHealthTracker`. `recordMeaningful`
  advances `lastEventAt` and returns a snapshot only when the bucket
  changes; `tick` does not advance `lastEventAt` and returns a snapshot
  only when the bucket changes; `snapshot` always returns the current
  snapshot. State-machine transitions are explicit (`healthy` →
  `quiet` when `elapsedMs >= quietSeconds * 1000`,
  `quiet` → `stalled` when `elapsedMs >= stalledSeconds * 1000`,
  and the inverse transitions happen the instant a meaningful event
  is recorded). Constructor takes
  `{ quietSeconds: number; stalledSeconds: number; now?: () => number }`
  and validates both thresholds are positive.
- `src/orchestrator/machine.ts`:
  - Extend `MachineEvent` with
    `{ type: "heartbeat"; state: RunHealthState; lastEventAt: number; lastEventKind: string; lastEventRole?: "leader" | "worker"; phase: MachinePhase; elapsedMs: number; quietSeconds: number; stalledSeconds: number }`.
  - Extend `RunOptions` with optional
    `runHealth?: RunHealthTracker`. When supplied, `runOrchestration`
    does not construct or poll its own tracker; it just passes through.
    Default behaviour (no `runHealth` supplied) is unchanged for tests
    that don't care about health tracking.
  - No `heartbeatIntervalMs` option on `RunOptions`; the interval lives
    in the service (see below). This is the explicit ownership decision
    required by Issue 2: the orchestrator does not own polling.
- `app/main/tandem-service.ts`:
  - Private field `currentPhase: MachinePhase = "IDLE"`.
  - Private `HEARTBEAT_INTERVAL_MS = 5000` constant.
  - In `run`, immediately after the existing `this.controller = new AbortController()` line:
    ```ts
    const tracker = new RunHealthTracker({ quietSeconds: 30, stalledSeconds: 180 });
    let lastEmittedBucket: RunHealthState | undefined;
    const heartbeatTimer = setInterval(() => {
      const snap = tracker.tick({ phase: this.currentPhase });
      if (!snap) return;
      if (snap.state === lastEmittedBucket) return; // belt-and-braces; tick already dedupes
      lastEmittedBucket = snap.state;
      void this.emitMachine({ type: "heartbeat", ...snap });
    }, HEARTBEAT_INTERVAL_MS);
    ```
  - Pass `runHealth: tracker` to `runOrchestration` via `RunOptions`.
  - In the `finally` block of `run`, after `this.controller = undefined`,
    add `clearInterval(heartbeatTimer)`. Also reset
    `this.currentPhase = "IDLE"` so the next run starts clean.
  - Update `emitText(role, delta, thinking)` so it calls
    `tracker.recordMeaningful({ kind: "modelDelta", role, phase: this.currentPhase })`
    when `delta.length > 0`. Empty deltas are dropped (matches the
    existing `appendStream`/`appendThinking` skip on empty/whitespace).
  - Update `emitTool(event)` so it calls
    `tracker.recordMeaningful({ kind: "toolCall", role: event.role, phase: this.currentPhase })`
    on every tool event (the renderer already gets `evt:tool` for every
    phase, including the `end` phase, and so does the tracker).
  - Update `emitMachine(event)` so it:
    1. Skips heartbeat events: `if (event.type === "heartbeat") return;`
       (Issue 3 — self-emission exclusion lives at the wrapper, not in
       the tracker).
    2. Tracks phase on transition: `if (event.type === "transition") this.currentPhase = event.phase`.
    3. Maps the event to a tracker kind: `transition` / `artifact` /
       `notice` / `checkpoint` each map to themselves; `error` is
       treated as a `notice` (errors are user-visible activity and a
       silent error must not look like a stall).
    4. Calls `tracker.recordMeaningful({ kind, role: undefined, phase: this.currentPhase })`.
  - In `resumeSession`, after `events` is computed, scan them in reverse
    for the most recent `machine` event whose payload `type === "heartbeat"`
    and assign it to a new local `lastHeartbeat`. Add a small private
    helper `findLastHeartbeat(payloads: unknown[]): RunHeartbeatEvent | undefined`
    next to the existing `findLastCheckpoint`. Return
    `lastHeartbeat: this.findLastHeartbeat(events.map((e) => e.payload))`
    in the response. This is the SINGLE source of truth for the resume
    field; the renderer never replays events itself.
- `app/shared/ipc.ts`:
  - Add `heartbeatEvent: "evt:heartbeat"` to `ipcChannels`.
  - Export `RunHealthState` (re-exported from `src/orchestrator/run-health.ts`).
  - Export `RunHeartbeatEvent` matching the machine `heartbeat` payload.
  - Add `onHeartbeatEvent(callback: (event: RunHeartbeatEvent) => void): () => void`
    to `TandemDesktopApi`.
  - Add `lastHeartbeat?: RunHeartbeatEvent` to `SessionResumeResponse`
    (this is the ONLY resume field for health; `heartbeat` is not added
    separately — Issue 4).
- `app/preload/index.ts`: forward the new `heartbeatEvent` channel
  through `onHeartbeatEvent`. Add the corresponding `on<RunHeartbeatEvent>`
  helper alongside the existing `onMachineEvent`/`onTextEvent` lines.
- `tests/orchestrator.test.ts`: add focused tests for the tracker
  driving `RunHealthTracker` with an injected clock:
  - `recordMeaningful` with `kind: "modelDelta"` resets elapsed to 0
    and returns a `healthy` snapshot on the first call.
  - Calling `tick({ phase: "BUILDING" })` after 31 s returns `quiet`,
    after 181 s returns `stalled`; consecutive `tick` calls with the
    same `at` return `undefined` (duplicate suppression, Issue 2).
  - State transitions emit a fresh snapshot exactly when the bucket
    changes (`healthy` → `quiet` → `stalled` → `healthy` on the next
    meaningful event), and the second `tick()` in the same bucket
    window returns `undefined`.
  - `snapshot()` always returns the current snapshot (no `undefined`),
    even when the bucket is unchanged; this is what the display layer
    uses.
- `tests/run-health.test.ts` (new, ≤ 100 lines): direct unit tests for
  `RunHealthTracker` covering thresholds (`quietSeconds = 5`,
  `stalledSeconds = 10`), role propagation through `lastEventRole` on
  `modelDelta` / `toolCall`, the `snapshot` / `tick` / `recordMeaningful`
  split, and the `now` injection (`vi.useFakeTimers` advance then
  record).
- `tests/desktop-service.test.ts`:
  - **Service-level activity-reset test (Issue 1)**: stand up a fake
    `run` with a fake agents object that emits a `transition` to
    `BUILDING`, then a `toolEvent` 60s later, then idles 200s with no
    further activity, then a `text` delta. Spy on
    `this.window.webContents.send` to capture every `evt:machine`
    payload. Assert: (a) zero heartbeat payloads carry `state: "stalled"`,
    (b) the final heartbeat's `lastEventKind` is `"modelDelta"`,
    (c) the `evt:machine` payload that lands within the
    `stalledSeconds` window reports `state: "stalled"` only briefly
    before the model delta flips it back, but no heartbeat
    *externally visible to the renderer* is emitted for the transient
    stall because `tick` returned `undefined` for that window (the
    tool call already kept the bucket at `healthy`).
  - **Interval cleanup test (Issue 2)**: spy on `setInterval` and
    `clearInterval` for the lifetime of a synchronous `run` cycle
    (mock the orchestrator to resolve immediately). Assert:
    `setInterval` is called exactly once with the heartbeat cadence,
    `clearInterval` is called exactly once with the same handle in the
    `finally` block, and no further `tick` calls happen after cleanup.
  - **Self-emission exclusion test (Issue 3)**: capture every
    `tracker.recordMeaningful` invocation via a `vi.spyOn` on the
    tracker instance. Run a `run` cycle that emits at least one
    `heartbeat` machine event. Assert: the `recordMeaningful` call
    count never includes an entry for a `heartbeat` payload (the
    wrapper short-circuited).
  - **Resume `lastHeartbeat` test (Issue 4)**: feed a session JSONL
    containing two heartbeat machine events (older `quiet`, newer
    `stalled`) plus several non-heartbeat events. Call `resumeSession`
    and assert `response.lastHeartbeat.state === "stalled"` AND
    `response.lastHeartbeat.lastEventKind` matches the newer payload's
    `lastEventKind`. Also test the empty case: JSONL with no heartbeat
    events → `response.lastHeartbeat === undefined`.

Acceptance evidence:

- A new unit test (`tests/run-health.test.ts`) drives `RunHealthTracker`
  through `healthy -> quiet -> stalled` with `vi.useFakeTimers()` and
  asserts each transition emits exactly once (the next `tick` in the
  same bucket returns `undefined`).
- A new test in `tests/desktop-service.test.ts` exercises a real
  `run` cycle, captures every `evt:heartbeat` payload and every
  `session.append("machine", ...)` call, and asserts both contain
  heartbeats only at bucket boundaries (no duplicates within a
  bucket), that model/tool activity resets elapsed time and prevents
  false stall transitions, that the interval is cleared in `finally`,
  and that the resume response's `lastHeartbeat` is the most recent
  heartbeat machine event from the JSONL.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Step 2 — Renderer activity strip uses run-health instead of pulse clock

Files expected (≤ 6 production files):

- `app/renderer/src/run-health-display.ts` (new, ≤ 60 lines): export
  pure `formatRunHealth(snapshot: RunHeartbeatEvent)` returning
  `{ label: string; stalled: boolean; cssClass: "healthy" | "quiet" | "stalled" }`.
  `healthy` becomes `"healthy"`; `quiet` becomes
  `"quiet (Ns since last <event-kind>)"`; `stalled` becomes
  `"likely stalled (Ns since last <event-kind>) - Stop to abort"`.
  Always include `phase` (e.g. `"BUILDING"`) and the role if present
  (e.g. `"WORKER"`). Use the existing
  `MODEL_STALL_WARNING_SECONDS = 180` constant from `session-state.ts`
  for the `stalled` styling parity; export a new
  `RUN_HEALTH_QUIET_SECONDS = 30` constant next to it so the formatter
  and tracker thresholds stay aligned.
- `app/renderer/src/activity-strip.ts`: extend the `activityStripState`
  input with optional `runHealth?: RunHeartbeatEvent`. When `runHealth`
  is present, return
  `{ role: runHealth.lastEventRole ?? input.fallbackRole, text: formatRunHealth(runHealth).label, stalled: runHealth.state === "stalled" }`
  and ignore `activityPulse` / `activeTool` / `noActivitySeconds` for
  the text (active tool calls still surface elsewhere in the UI).
  When `runHealth` is absent, keep the existing behaviour so tests that
  don't supply it keep working unchanged.
- `app/renderer/src/main.tsx`:
  - Add `const [runHealth, setRunHealth] = useState<RunHeartbeatEvent | undefined>();`.
  - Subscribe to `tandem.onHeartbeatEvent(setRunHealth)` in the existing
    `useEffect` cleanup block.
  - Reset `runHealth` to `undefined` in `applyStartedSession` (new
    session) and on `onDoneEvent` (run end), mirroring the existing
    `setActivityPulse(undefined)` lines.
  - **Resume init (Issue 4)**: in `replaySession`, after the existing
    `setCost(resumed.cost)` line, add
    `setRunHealth(resumed.lastHeartbeat)`. The renderer does NOT scan
    `resumed.events` itself; the service's `findLastHeartbeat` already
    did. This is the single source-of-truth flow.
  - Pass `runHealth` to `activityStripState(...)`. Keep
    `lastActivityAt` / `activityTick` only as a fallback for runs
    without heartbeats (none in practice after Step 1, but defensively
    the old code path stays).
- `tests/renderer-run-health-display.test.ts` (new, ≤ 80 lines):
  regression tests for `formatRunHealth` covering the `healthy` /
  `quiet` / `stalled` branches, the role fallback to `phase`
  (`"BUILDING"`), the `stalled` label's `"Stop to abort"` wording,
  and the `RUN_HEALTH_QUIET_SECONDS` constant value.
- `tests/renderer-activity-strip.test.ts`: add a test that supplies a
  `runHealth` snapshot and asserts the strip text matches
  `formatRunHealth(...)` and ignores any stale `activityPulse` text.
  Keep the existing tests as-is so the pulse-only fallback path is
  still covered.
- `tests/desktop-service.test.ts` (Step 2 may add): one test that
  exercises `resumeSession` on a JSONL with multiple heartbeats and
  asserts the response's `lastHeartbeat` is the most recent one
  (already covered in Step 1; if Step 2 changes the wire format it
  extends the same test rather than adding a duplicate).

Acceptance evidence:

- A new test in `tests/renderer-activity-strip.test.ts` shows the
  strip text matches `formatRunHealth(...)` when `runHealth` is
  supplied, regardless of any stale pulse.
- The Step 1 `resumeSession` test proves `lastHeartbeat` is the most
  recent `heartbeat` machine event from the JSONL, so post-hoc
  analysis and resumed sessions agree on the last known state.
- `npm run typecheck`, `npm test`, and `git diff --check` all pass.

## Safety Notes

- This epic only touches run-health tracking, heartbeat event emission,
  and renderer display. It does not modify agent, provider, compaction,
  prompt, or credential code; therefore the `VALIDATE` phase's cheap
  real-model smoke is not required by the protocol.
- The new IPC channel and `RunHeartbeatEvent` type are additive. The
  desktop build, preload, and existing renderer code paths remain
  backward-compatible: pre-Step-2 renderer builds ignore `evt:heartbeat`
  messages and the new optional `lastHeartbeat` resume field.
- No automatic cancellation is introduced. The existing
  `tandem.abortPipeline` path is untouched; the renderer keeps
  surfacing `"Stop to abort"` only as a label hint inside the existing
  `Stop` button affordance, which already exists in the desktop shell.
- All edits stay inside `src/orchestrator/run-health.ts`,
  `src/orchestrator/machine.ts`, `app/main/tandem-service.ts`,
  `app/shared/ipc.ts`, `app/preload/index.ts`,
  `app/renderer/src/run-health-display.ts`,
  `app/renderer/src/activity-strip.ts`, `app/renderer/src/main.tsx`,
  and tests under `tests/`. No protocol, reciprocal script, branch
  topology, dependency, or credential changes are in scope.
- Heartbeat exclusion is implemented at the `emitMachine` wrapper, not
  inside `RunHealthTracker`. A heartbeat cannot satisfy its own
  `recordMeaningful` contract because `recordMeaningful.kind`'s union
  does not include `"heartbeat"` (compile-time enforcement) and the
  service wrapper skips heartbeat payloads before they reach the
  tracker (runtime enforcement, covered by the wrapper-level
  acceptance test).
