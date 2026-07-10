import type { SessionResumeResponse, SessionStartResponse } from "../../shared/ipc.js";

export const MODEL_STALL_WARNING_SECONDS = 180;

export function sessionFromResume(response: SessionResumeResponse): SessionStartResponse {
  return {
    projectDir: response.projectDir,
    sessionId: response.id,
    config: response.config,
    defaultProject: false,
    projectSummary: response.projectSummary,
    projectConfigOverrides: response.projectConfigOverrides,
    projectInstructions: response.projectInstructions
  };
}

export function needsProjectPickForSession(session: SessionStartResponse | undefined): boolean {
  return !session || Boolean(session.defaultProject);
}
