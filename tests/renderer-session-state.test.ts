import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { claudeCliModelOptions } from "../app/renderer/src/cli-model-options.js";
import { MODEL_STALL_WARNING_SECONDS, effectiveRendererConfig, isSessionActionable, isVisibleLiveTextRole, needsProjectPickForSession, replayVisibleSessionEvents, sessionFromResume } from "../app/renderer/src/session-state.js";
import type { SessionResumeResponse } from "../app/shared/ipc.js";
import type { SessionEvent } from "../src/session/store.js";

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

  it("D113: includes verified Claude Code CLI Fable 5 option", () => {
    expect(claudeCliModelOptions).toEqual(expect.arrayContaining(["haiku", "sonnet", "opus", "claude-fable-5"]));
  });

  it("includes the Claude Code CLI Opus 5 option", () => {
    expect(claudeCliModelOptions).toEqual(expect.arrayContaining(["claude-opus-5"]));
  });

  it("W0099: suppresses persisted worker text while preserving leader output", () => {
    expect(isVisibleLiveTextRole("leader")).toBe(true);
    expect(isVisibleLiveTextRole("worker")).toBe(false);
    let id = 1;
    const events: SessionEvent[] = [
      { type: "user", at: "2026-07-26T00:00:00.000Z", payload: { prompt: "Build the thing" } },
      { type: "thinking", at: "2026-07-26T00:00:01.000Z", payload: { role: "worker", delta: "I will reveal private step-by-step reasoning." } },
      { type: "text", at: "2026-07-26T00:00:02.000Z", payload: { role: "worker", delta: "The render directory is empty; this is investigative worker narration." } },
      { type: "text", at: "2026-07-26T00:00:02.500Z", payload: { role: "leader", delta: "Leader plan and answer." } },
      { type: "machine", at: "2026-07-26T00:00:03.000Z", payload: { type: "transition", phase: "BUILDING", message: "BUILDING round 1/3" } },
      { type: "done", at: "2026-07-26T00:00:04.000Z", payload: { summary: "Final summary", takeover: false } }
    ];

    const replay = replayVisibleSessionEvents(events, () => id++);
    const visibleText = replay.entries.map((entry) => (entry.kind === "message" ? entry.text : "")).join("\n");

    expect(visibleText).not.toContain("private step-by-step reasoning");
    expect(visibleText).toContain("Build the thing");
     expect(visibleText).not.toContain("investigative worker narration");
     expect(visibleText).toContain("Leader plan and answer.");
    expect(visibleText).not.toContain("BUILDING round 1/3");
    expect(visibleText).not.toContain("Final summary");
    expect(replay.entries.every((entry) => entry.kind !== "message" || entry.role !== "system")).toBe(true);
    expect(replay.entries).toContainEqual({ id: 2, kind: "message", role: "worker", text: "Thinking", thinking: true });
  });

  it("W0100: keeps a worker status placeholder for plain worker-only deltas", () => {
    let id = 1;
    const replay = replayVisibleSessionEvents(
      [
        { type: "user", at: "2026-08-15T00:00:00.000Z", payload: { prompt: "Run the worker" } },
        { type: "text", at: "2026-08-15T00:00:01.000Z", payload: { role: "worker", delta: "plain minimax-style worker output" } },
        { type: "text", at: "2026-08-15T00:00:02.000Z", payload: { role: "worker", delta: "more hidden output" } }
      ],
      () => id++
    );

    expect(replay.entries).toContainEqual({ id: 2, kind: "message", role: "worker", text: "Thinking", thinking: true });
    expect(replay.entries.filter((entry) => entry.kind === "message" && entry.role === "worker")).toHaveLength(1);
    expect(JSON.stringify(replay.entries)).not.toContain("plain minimax-style worker output");
  });
});
