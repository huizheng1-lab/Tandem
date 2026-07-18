# W0013 Run-Health and Stall Visibility in the Desktop App

Objective: replace today's binary "stalled / not stalled" activity hint with an honest orchestration-level heartbeat. Track the last meaningful event per run (model text/thinking delta, tool call, phase transition); when the run goes silent, surface an explicit run-health state (`healthy` / `quiet Ns` / `likely_stalled`) that shows the current phase, role, last event kind, and elapsed silence. Mirror the snapshot into the session JSONL so post-hoc analysis sees the same truth the user saw. Never signal a fake "thinking…" indicator. UI-only signaling: no automatic run cancellation, no workflow changes.

This epic is `autonomy=full`. After independent acceptance of this plan candidate, the relay may auto-approve it and begin one implementation step per turn.

## Revision history

- Revision 1: initial three-step plan. Pure tracker first so thresholds and semantics are pinned by tests before any wiring; orchestrator wiring plus session-log emission second; renderer integration third so the visible surface area lives entirely behind already-tested data flow.

## Confirmed repository constraints

- `src/orchestrator/machine.ts` already exposes `MachinePhase` and a single `emit(event: MachineEvent)` callback used by `runOrchestration`. New event kinds extend the discriminated union without breaking existing emitters.
- `app/main/tandem-service.ts` owns the per-process lifecycle: it constructs the controller, tracks `currentPhase`, and exposes `remoteStatusSnapshot().runHealth` for the desktop UI. All health emissions must live behind that same lifecycle so paused/idle/error paths stay correct.
- Session JSONL appends already cover `text`, `thinking`, `tool`, `machine`, and `cost` event types (`SessionStore.append`). Adding a new `runHealth` event type is additive: old readers ignore it, new readers get the snapshot.
- `app/renderer/src/activity-strip.ts` currently classifies silence vs. stalled vs. active with a binary `stalled` flag and `MODEL_STALL_WARNING_SECONDS = 180`. The new tracker does not replace it directly in one step; the renderer integration step (Step 3) augments it without removing the existing strip until both shapes are visible side-by-side and the leader verifies the UX.
- `app/renderer/src/main.tsx` already maintains a 1Hz `activityTick` interval and tracks `lastActivityAt`. The renderer integration step subscribes to the new `runHealth` machine event and renders it next to the existing strip.

## Run-health contract

- A `RunHealthTracker` records meaningful events: `{ role: "leader" | "worker"; kind: "text" | "thinking" | "tool" | "phase" | "error" | "notice"; at?: number; detail?: string }`.
- `state(now: number)` returns `{ state: "idle" | "healthy" | "quiet" | "likely_stalled"; silentForMs: number; lastEvent?: { role; kind; at; detail? }; phase?: MachinePhase }`.
- Default thresholds: `quietThresholdMs = 30_000` (≥30s and <180s of silence) and `likelyStalledThresholdMs = 180_000` (≥180s of silence). A `quiet` snapshot still reports the last event and the silent duration; a `likely_stalled` snapshot keeps the existing "Stop to abort" affordance verbatim and never claims "thinking".
- `phase` is optional and only included when the run is active; `idle` is only emitted when no run is in progress, so downstream renderers can distinguish "no run" from "running but quiet".
- `record()` and `state()` are deterministic given a `now` argument; the tracker never reads `Date.now()` itself. Tests pass an explicit clock so transitions are observable without sleeps.

## Ordered steps

- [ ] Step 1: add `src/orchestrator/run-health.ts` plus unit tests with `vi.useFakeTimers()` covering every transition, threshold boundary, and role/kind permutation.
- [ ] Step 2: instantiate the tracker per run inside `tandem-service.ts`, wire machine/text/thinking/tool emission points, emit `runHealth` machine events, and append `runHealth` entries to the session log while the controller is active.
- [ ] Step 3: subscribe the desktop renderer to the latest `runHealth` event (live and on resume), render the tracker state beside the activity strip, and format the snapshot fields with focused tests.

Every intermediate candidate must leave focused tests, `npm run typecheck`, `npm test`, and `git diff --check` green. Exactly one checkbox is completed per implementation candidate.

## Step 1 - Pure RunHealthTracker module with focused tests

Expected files:

- `src/orchestrator/run-health.ts` (new) — exports `RunHealthTracker`, `RunHealthSnapshot`, `RunHealthLastEvent`, `DEFAULT_QUIET_THRESHOLD_MS`, `DEFAULT_LIKELY_STALLED_THRESHOLD_MS`, and a `RunHealthEventInput` type.
- `tests/orchestrator-run-health.test.ts` (new) — pure unit tests with `vi.useFakeTimers()`.
- this plan file, checked complete at the end of the candidate.

Implementation:

- Implement `RunHealthTracker` with `constructor(options?: { now?: () => number; quietThresholdMs?: number; likelyStalledThresholdMs?: number })`. When `now` is not provided, default to `Date.now`. Threshold defaults are the constants above.
- `record(input: RunHealthEventInput)` records `role`, `kind`, optional `at` (default: tracker clock), and optional `detail`. The tracker keeps only the last event; older events are discarded.
- `state(active: boolean | { phase?: MachinePhase }, now?: number): RunHealthSnapshot` returns `idle` when `active === false` and `now` is omitted only when no event has ever been recorded; otherwise derive state from `now - lastEvent.at` against the thresholds.
- `snapshot()` returns the raw tracking fields without computing thresholds; tests use it for boundary assertions.

Focused evidence in `tests/orchestrator-run-health.test.ts`:

- `idle` is returned until the first `record()` call; `state` becomes `healthy` immediately after.
- Crossing the quiet threshold flips state to `quiet`; crossing the likely-stalled threshold flips to `likely_stalled`.
- `record()` resets state to `healthy` regardless of prior threshold position; `lastEvent` is the most recent record (later records win even if they are `thinking` or `notice` from a different role).
- Threshold boundaries are exact: exactly `quietThresholdMs - 1` is healthy; `quietThresholdMs` is quiet; `likelyStalledThresholdMs - 1` is quiet; `likelyStalledThresholdMs` is likely_stalled.
- Custom thresholds change transitions without changing `lastEvent`.
- `record({ at: 0 })` lets tests pin a deterministic clock without `vi.advanceTimersByTime`; calling `state(12345)` returns a snapshot whose `silentForMs` is `12345 - 0`.
- The tracker never invokes `Date.now()` when `now` is provided and never throws on undefined `detail`.

Terminating focused command:

`npm test -- tests/orchestrator-run-health.test.ts`

## Step 2 - Orchestrator wiring and session-log emission

Expected production files (three):

- `app/main/tandem-service.ts`
- `src/orchestrator/machine.ts` (only to widen the `MachineEvent` union if the tracker state cannot live on the service alone)
- `app/shared/ipc.ts` if a new typed channel is needed

Test files:

- `tests/desktop-run-health-wiring.test.ts` (new) — exercises the service without electron, using an injected `SessionLike` and a fake clock.
- this plan file, checked complete at the end of the candidate.

Implementation:

- Add a new `MachineEvent` variant `{ type: "runHealth"; snapshot: RunHealthSnapshot }`.
- Construct one `RunHealthTracker` per run on `controller` creation. Reset it when the controller is cleared. Record (`role: "leader"`, `kind: "phase"`) on every `transition` emit. Record (`role: "leader" | "worker"`, `kind: "text" | "thinking"`) on every `emitText`. Record (`role: "leader" | "worker"`, `kind: "tool"`) on every `emitTool`. Record (`role: "leader" | "worker"`, `kind: "error" | "notice"`) on machine notice/error emits.
- Start a 10s `setInterval` while the controller is active that emits a fresh `runHealth` machine event and appends one `runHealth` JSONL row so the renderer can update even when nothing else fires. Clear the interval when the controller is cleared.
- `remoteStatusSnapshot().runHealth` is replaced with a derived value from the latest tracker snapshot so the remote control sees the same state users see locally; the literal `idle` snapshot when no controller is active is preserved.
- Never `throw` if `session.append` is unavailable; the heartbeat must not crash a run.

Focused evidence in `tests/desktop-run-health-wiring.test.ts`:

- A simulated run that records text, thinking, and tool events produces matching `runHealth` machine events with the right `lastEvent.role`/`lastEvent.kind` and `healthy` state immediately after each.
- Advancing the fake clock by `quietThresholdMs` after the last record flips the next emitted snapshot to `quiet`; advancing again by the additional gap to `likelyStalledThresholdMs - quietThresholdMs` flips to `likely_stalled`.
- Session log receives one `runHealth` row per emit, in order; the rows are valid JSONL (each line `JSON.parse`s and contains `snapshot.state`).
- Resetting the controller clears the interval and any further emits stop; the next `runOrchestration` starts a fresh tracker with no carry-over from the previous run.
- Pause does not stop the heartbeat: the snapshot reports `phase: BUILDING`-like carries and the renderer still sees a `quiet` state when silence exceeds the threshold (the existing Pause behavior stays untouched).
- `runOrchestration` failures still surface the existing terminal event path; no extra `runHealth` is emitted after `DONE`.

Terminating focused command:

`npm test -- tests/desktop-run-health-wiring.test.ts`

## Step 3 - Desktop renderer display and formatting

Expected production files (three):

- `app/renderer/src/main.tsx`
- `app/renderer/src/run-health-display.ts` (new) — pure formatting helpers (no React) so they can be unit-tested without the renderer harness.
- `app/renderer/src/styles.css`

Expected test/evidence files:

- `tests/renderer-run-health.test.ts` (new) — vitest with `vi.useFakeTimers()` for snapshot formatting and event-driven updates.
- this plan file, checked complete at the end of the candidate.

Implementation:

- Add a `formatRunHealth(snapshot: RunHealthSnapshot, now: number)` helper that returns `{ stateLabel, detailLabel, roleLabel, kindLabel, silentForLabel }`. `stateLabel` is "healthy" / "quiet Ns" / "likely stalled" (with the existing "Stop to abort" suffix on likely_stalled preserved verbatim). `detailLabel` carries the last event's `detail` when set.
- Subscribe to the `runHealth` machine event in `main.tsx` (live) and read the latest `runHealth` row from the session JSONL on resume so the same state appears after a reload.
- Render a `<section>` next to the existing activity strip showing the latest label plus the current `phase` and `silentFor` counter. Hide the section while the run is idle. Stop spinning the existing activity strip's heartbeat in favor of the tracker-driven view only when both states are visible side-by-side for at least one tick, so users can compare before the leader signs off on removing the legacy indicator.
- Preserve keyboard focus visibility and expose the new region with `aria-live="polite"`.

Focused evidence in `tests/renderer-run-health.test.ts`:

- `formatRunHealth({ state: "healthy", silentForMs: 0, lastEvent: { role: "worker", kind: "tool", at: 0, detail: "bash" } }, 0)` returns labels that match the spec.
- "quiet Ns" formatting caps at `Ns` (no fractional seconds) and uses the provided `now`.
- "likely_stalled" includes the "Stop to abort" suffix and continues to include the last-event detail when `detail` is set.
- `idle` snapshot returns the empty-state label without `silentFor` and without showing a `lastEvent`.
- Subscribing to two `runHealth` events keeps only the latest snapshot; stale `phase` values are replaced.

Terminating focused command:

`npm test -- tests/renderer-run-health.test.ts`

## Safety and scope

- No protocol, reciprocal script, dependency, credential, session-store-format, agent, provider, or compaction changes.
- Tracker files are pure additions inside `src/orchestrator/`; no edits to the orchestrator's decision logic (only `emit` calls are added at existing event sites).
- The desktop renderer change is additive: the existing activity strip is retained in Step 3's first commit, then optionally tightened in a follow-up after the leader verifies the UX. No automatic run cancellation is added; the existing Stop button is the only abort path.
- Each step stays within three production files and roughly 300 net new lines. If an implementation cannot satisfy that bound, revise this plan in its own candidate instead of combining steps.
- No real-model smoke test is required unless an implementation unexpectedly touches a protocol-designated model path; such a scope change requires plan revision first.
