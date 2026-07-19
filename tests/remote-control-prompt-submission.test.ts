import { describe, expect, it, vi } from "vitest";
import {
  MAX_REMOTE_PROMPT_CHARS,
  submitRemotePrompt,
  type SessionPromptSubmission
} from "../src/remote-control/prompt-submission.js";

const input = { chatId: 10, sessionId: "session-1", text: "Build the next step" };

describe("submitRemotePrompt", () => {
  it("rejects empty, oversized, and prohibited-control-character input", async () => {
    const submit = vi.fn<SessionPromptSubmission>(async () => ({ status: "submitted" }));

    await expect(submitRemotePrompt({ ...input, text: "  \n\t " }, submit)).resolves.toMatchObject({ status: "invalid", code: "empty" });
    await expect(submitRemotePrompt({ ...input, text: "x".repeat(MAX_REMOTE_PROMPT_CHARS + 1) }, submit)).resolves.toMatchObject({ status: "invalid", code: "too-long" });
    await expect(submitRemotePrompt({ ...input, text: "unsafe\u0000value" }, submit)).resolves.toMatchObject({ status: "invalid", code: "control-character" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("normalizes valid input and returns a structured submitted result", async () => {
    const submit = vi.fn<SessionPromptSubmission>(async () => ({ status: "submitted" }));

    await expect(submitRemotePrompt({ ...input, text: "  Build it  " }, submit)).resolves.toEqual({
      status: "submitted",
      chatId: 10,
      sessionId: "session-1"
    });
    expect(submit).toHaveBeenCalledWith({ chatId: 10, sessionId: "session-1", text: "Build it" });
  });

  it("preserves approval details and converts rejection or thrown errors to failures", async () => {
    await expect(submitRemotePrompt(input, async () => ({
      status: "requires-approval",
      approval: { id: "approval-1", kind: "permission", title: "Write", body: "Write a file" }
    }))).resolves.toMatchObject({ status: "requires-approval", approval: { id: "approval-1" } });

    await expect(submitRemotePrompt(input, async () => ({ status: "rejected", message: "Session is busy" }))).resolves.toEqual({
      status: "failed",
      message: "Session is busy"
    });
    await expect(submitRemotePrompt(input, async () => { throw new Error("Session disconnected"); })).resolves.toEqual({
      status: "failed",
      message: "Session disconnected"
    });
  });
});
