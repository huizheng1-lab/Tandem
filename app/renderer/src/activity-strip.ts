import type { ToolActivityEvent } from "../../shared/ipc.js";
import { MODEL_STALL_WARNING_SECONDS } from "./session-state.js";

export interface ActivityPulse {
  role: "leader" | "worker";
  kind: "thinking" | "writing";
  startedAt: number;
}

export interface ActiveTool extends ToolActivityEvent {
  startedAt: number;
}

export function activityStripState(input: {
  activeTool?: ActiveTool;
  activityPulse?: ActivityPulse;
  fallbackRole: "leader" | "worker";
  noActivitySeconds: number;
  activityTick: number;
  secondsSince: (startedAt: number, now: number) => number;
  silenceThresholdSeconds?: number;
}): { role: "leader" | "worker"; text: string; stalled: boolean } {
  const role = input.activeTool?.role ?? input.activityPulse?.role ?? input.fallbackRole;
  const stalled = input.noActivitySeconds > MODEL_STALL_WARNING_SECONDS;
  if (stalled) return { role, stalled, text: `no activity for ${input.noActivitySeconds}s - the model call may be stalled (Stop to abort)` };
  if (input.activeTool) return { role, stalled, text: `running: ${input.activeTool.target} (${input.secondsSince(input.activeTool.startedAt, input.activityTick)}s)` };
  if (input.activityPulse) {
    const silentFor = input.secondsSince(input.activityPulse.startedAt, input.activityTick);
    if (silentFor > (input.silenceThresholdSeconds ?? 10)) return { role, stalled, text: `no output for ${silentFor}s` };
    return { role, stalled, text: `${input.activityPulse.kind === "thinking" ? "thinking" : "writing"}...` };
  }
  return { role, stalled, text: `waiting for model... (${input.noActivitySeconds}s)` };
}
