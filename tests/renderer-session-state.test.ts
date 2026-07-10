import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { MODEL_STALL_WARNING_SECONDS, needsProjectPickForSession, sessionFromResume } from "../app/renderer/src/session-state.js";
import type { SessionResumeResponse } from "../app/shared/ipc.js";

describe("renderer session resume state", () => {
  it("builds a full non-default session from a resume response", () => {
    const resumed: SessionResumeResponse = {
      id: "session-1",
      projectDir: "C:\\project",
      config: { ...defaultConfig, permissionMode: "yolo" },
      defaultProject: false,
      projectSummary: "existing project, 3 files",
      projectConfigOverrides: ["permissionMode"],
      events: []
    };

    const session = sessionFromResume(resumed);

    expect(session).toMatchObject({
      sessionId: "session-1",
      projectDir: "C:\\project",
      defaultProject: false,
      projectSummary: "existing project, 3 files"
    });
    expect(needsProjectPickForSession(session)).toBe(false);
    expect(needsProjectPickForSession(undefined)).toBe(true);
  });

  it("relaxes the model-stall warning threshold to three minutes", () => {
    expect(MODEL_STALL_WARNING_SECONDS).toBe(180);
  });
});
