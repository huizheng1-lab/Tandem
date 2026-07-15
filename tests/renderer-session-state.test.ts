import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { MODEL_STALL_WARNING_SECONDS, effectiveRendererConfig, isSessionActionable, needsProjectPickForSession, sessionFromResume } from "../app/renderer/src/session-state.js";
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

  it("uses the live service config over a stale session config snapshot for status controls", () => {
    const session = sessionFromResume({
      id: "session-1",
      projectDir: "C:\\project",
      config: { ...defaultConfig, leader: "minimax/minimax-m3" },
      defaultProject: false,
      projectSummary: "existing project",
      events: []
    });
    const liveConfig = { ...defaultConfig, leader: "codex/cli" };

    expect(effectiveRendererConfig(session, liveConfig)?.leader).toBe("codex/cli");
    expect(effectiveRendererConfig(session, undefined)?.leader).toBe("minimax/minimax-m3");
  });

  it("D111: determines if a session is actionable based on projectDir presence", () => {
    expect(isSessionActionable({ projectDir: "C:\\project" })).toBe(true);
    expect(isSessionActionable({ projectDir: "" })).toBe(false);
    expect(isSessionActionable({ projectDir: undefined })).toBe(false);
  });
});
