import type { RunHeartbeatEvent } from "../../shared/ipc.js";
import { MODEL_STALL_WARNING_SECONDS, RUN_HEALTH_QUIET_SECONDS } from "./session-state.js";

export interface FormattedRunHealth {
  label: string;
  stalled: boolean;
  cssClass: "healthy" | "quiet" | "stalled";
}

function describeEventKind(kind: RunHeartbeatEvent["lastEventKind"]): string {
  if (kind === "modelDelta") return "model delta";
  if (kind === "toolCall") return "tool call";
  return kind;
}

/**
 * Formats a serialized heartbeat machine event into the user-facing label
 * shown in the desktop activity strip. `now` lets callers advance the visible
 * elapsed counter beyond `snapshot.elapsedMs`, which is frozen at the moment
 * the heartbeat was emitted; the renderer passes its existing `activityTick`.
 *
 * The formatter re-derives the bucket from elapsed time so a healthy snapshot
 * cannot show "healthy" if enough wall-clock time has passed since the
 * serialized heartbeat was emitted. The thresholds stay aligned with
 * `MODEL_STALL_WARNING_SECONDS` / `RUN_HEALTH_QUIET_SECONDS` so the formatter
 * and tracker agree on what counts as healthy, quiet, or stalled.
 */
export function formatRunHealth(snapshot: RunHeartbeatEvent, now: number): FormattedRunHealth {
  const elapsedSeconds = Math.max(
    Math.max(0, Math.floor(snapshot.elapsedMs / 1000)),
    Math.max(0, Math.floor((now - snapshot.lastEventAt) / 1000))
  );
  const phase = snapshot.phase;
  const rolePart = snapshot.lastEventRole ? `${snapshot.lastEventRole.toUpperCase()} ` : "";
  const eventKind = describeEventKind(snapshot.lastEventKind);
  const derivedState = elapsedSeconds >= MODEL_STALL_WARNING_SECONDS
    ? "stalled"
    : elapsedSeconds >= RUN_HEALTH_QUIET_SECONDS
      ? "quiet"
      : "healthy";
  const state = snapshot.state === "healthy" ? derivedState : snapshot.state;
  if (state === "healthy") {
    return { label: `${rolePart}${phase} healthy`, stalled: false, cssClass: "healthy" };
  }
  if (state === "quiet") {
    return {
      label: `${rolePart}${phase} quiet (${elapsedSeconds}s since last ${eventKind})`,
      stalled: false,
      cssClass: "quiet"
    };
  }
  return {
    label: `${rolePart}${phase} likely stalled (${elapsedSeconds}s since last ${eventKind}) - Stop to abort`,
    stalled: true,
    cssClass: "stalled"
  };
}