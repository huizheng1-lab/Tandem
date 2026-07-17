import type { SessionMetadata, SessionResumeResponse, SessionStartResponse } from "../../shared/ipc.js";
import type { TandemConfig } from "../../../src/config/schema.js";

export const MODEL_STALL_WARNING_SECONDS = 180;
// W0013 Step 2: keep this constant next to MODEL_STALL_WARNING_SECONDS so the
// renderer formatter and orchestrator tracker thresholds stay aligned.
export const RUN_HEALTH_QUIET_SECONDS = 30;

export function sessionFromResume(response: SessionResumeResponse): SessionStartResponse {
  return {
    projectDir: response.projectDir,
    sessionId: response.id,
    config: response.config,
    defaultProject: response.defaultProject,
    projectSummary: response.projectSummary,
    projectConfigOverrides: response.projectConfigOverrides,
    projectInstructions: response.projectInstructions
  };
}

export function needsProjectPickForSession(session: SessionStartResponse | undefined): boolean {
  return !session || Boolean(session.defaultProject);
}

export function effectiveRendererConfig(session: Pick<SessionStartResponse, "config"> | undefined, config: TandemConfig | undefined): TandemConfig | undefined {
  return config ?? session?.config;
}

export function isSessionActionable(item: Pick<SessionMetadata, "projectDir">): boolean {
  return Boolean(item.projectDir);
}