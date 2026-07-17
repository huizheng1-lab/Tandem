import type { MachinePhase } from "./machine.js";

export type RunHealthState = "healthy" | "quiet" | "stalled";

export type RunHealthEventKind = "modelDelta" | "toolCall" | "transition" | "artifact" | "notice" | "checkpoint";

export interface RunHealthSnapshot {
  state: RunHealthState;
  phase: MachinePhase;
  lastEventAt: number;
  lastEventKind: RunHealthEventKind;
  lastEventRole?: "leader" | "worker";
  elapsedMs: number;
  quietSeconds: number;
  stalledSeconds: number;
}

export interface RecordMeaningfulInput {
  kind: RunHealthEventKind;
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

export interface RunHealthTrackerOptions {
  quietSeconds: number;
  stalledSeconds: number;
  initialPhase: MachinePhase;
  now?: () => number;
}

/**
 * Tracks the last meaningful event for a single orchestration run and derives a
 * three-bucket health state (healthy / quiet / stalled). The tracker is pure:
 * it never calls `Date.now()` itself and accepts an injected clock so tests can
 * drive deterministic transitions with `vi.useFakeTimers()`.
 *
 * Method contracts (per the W0013 plan, Issue 2 + Issue 3):
 *  - `recordMeaningful` is the only entry point for emit paths
 *    (`emitText`, `emitTool`, `emitMachine`). It advances `lastEventAt` to the
 *    event's `at`, advances `lastEventKind` / `lastEventRole`, and returns a
 *    fresh snapshot ONLY when the bucket (`healthy` / `quiet` / `stalled`)
 *    just changed since the last `recordMeaningful` or `tick` call that
 *    returned a snapshot. Returns `undefined` when the bucket is unchanged
 *    so the caller can decide whether to emit a `heartbeat` machine event.
 *  - `tick` is called by the heartbeat interval. It does NOT advance
 *    `lastEventAt`; it only re-derives the bucket from elapsed time. The
 *    returned snapshot is published as a heartbeat when the bucket just
 *    changed. Two consecutive `tick` calls at the same `at` return
 *    `undefined` on the second call.
 *  - `snapshot` always returns the current snapshot without recording and
 *    without changing the dedup state. Tests and diagnostics use it for
 *    inspection only.
 */
export class RunHealthTracker {
  private readonly quietMs: number;
  private readonly stalledMs: number;
  private readonly now: () => number;
  private lastEventAt: number;
  private lastEventKind: RunHealthEventKind;
  private lastEventRole?: "leader" | "worker";
  private lastEmittedBucket?: RunHealthState;

  constructor(opts: RunHealthTrackerOptions) {
    if (!Number.isFinite(opts.quietSeconds) || opts.quietSeconds <= 0) {
      throw new Error(`RunHealthTracker: quietSeconds must be a positive number, got ${opts.quietSeconds}`);
    }
    if (!Number.isFinite(opts.stalledSeconds) || opts.stalledSeconds <= opts.quietSeconds) {
      throw new Error(
        `RunHealthTracker: stalledSeconds (${opts.stalledSeconds}) must be greater than quietSeconds (${opts.quietSeconds})`
      );
    }
    this.quietMs = opts.quietSeconds * 1000;
    this.stalledMs = opts.stalledSeconds * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.lastEventAt = this.now();
    // Issue 2: initialize `lastEventKind` to "transition" so `tick()` and
    // `snapshot()` are total even before the first external event.
    this.lastEventKind = "transition";
    this.lastEventRole = undefined;
  }

  recordMeaningful(input: RecordMeaningfulInput): RunHealthSnapshot | undefined {
    const at = input.at ?? this.now();
    this.lastEventAt = at;
    this.lastEventKind = input.kind;
    this.lastEventRole = input.role;
    return this.afterMutation(input.phase, at);
  }

  tick(input: TickInput): RunHealthSnapshot | undefined {
    return this.afterMutation(input.phase, input.at ?? this.now());
  }

  snapshot(input: SnapshotInput): RunHealthSnapshot {
    const at = input.at ?? this.now();
    const elapsed = Math.max(0, at - this.lastEventAt);
    const bucket = this.bucketFor(elapsed);
    return {
      state: bucket,
      phase: input.phase,
      lastEventAt: this.lastEventAt,
      lastEventKind: this.lastEventKind,
      lastEventRole: this.lastEventRole,
      elapsedMs: elapsed,
      quietSeconds: Math.floor(this.quietMs / 1000),
      stalledSeconds: Math.floor(this.stalledMs / 1000)
    };
  }

  private afterMutation(phase: MachinePhase, at: number): RunHealthSnapshot | undefined {
    const elapsed = Math.max(0, at - this.lastEventAt);
    const bucket = this.bucketFor(elapsed);
    if (bucket === this.lastEmittedBucket) return undefined;
    this.lastEmittedBucket = bucket;
    return {
      state: bucket,
      phase,
      lastEventAt: this.lastEventAt,
      lastEventKind: this.lastEventKind,
      lastEventRole: this.lastEventRole,
      elapsedMs: elapsed,
      quietSeconds: Math.floor(this.quietMs / 1000),
      stalledSeconds: Math.floor(this.stalledMs / 1000)
    };
  }

  private bucketFor(elapsedMs: number): RunHealthState {
    if (elapsedMs >= this.stalledMs) return "stalled";
    if (elapsedMs >= this.quietMs) return "quiet";
    return "healthy";
  }
}
