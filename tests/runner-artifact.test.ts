import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();

vi.mock("ai", () => ({
  hasToolCall: (toolName: string) => ({ type: "hasToolCall", toolName }),
  stepCountIs: (steps: number) => ({ type: "stepCountIs", steps }),
  streamText: streamTextMock
}));

describe("runAgentArtifact", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  it("D98: nudges once on the same conversation before failing a missing artifact attempt", async () => {
    const { runAgentArtifact } = await import("../src/agents/runner.js");
    let artifact: { ok: true } | undefined;
    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: "text-delta", text: "done in prose" };
        })(),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        steps: Promise.resolve([{}, {}]),
        response: Promise.resolve({
          messages: [
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "contents" } }] },
            { role: "assistant", content: [{ type: "text", text: "done in prose" }] }
          ]
        })
      }))
      .mockImplementationOnce((options) => {
        void options.tools.submit_completion_report.execute({ ok: true });
        artifact = { ok: true };
        return {
          fullStream: (async function* () {})(),
          totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
          steps: Promise.resolve([{}]),
          response: Promise.resolve({ messages: [] })
        };
      });

    const result = await runAgentArtifact({
      model: {} as never,
      system: "system",
      messages: [{ role: "user", content: "work" }],
      tools: {
        submit_completion_report: {
          description: "submit",
          inputSchema: {} as never,
          execute: (value: { ok: true }) => {
            artifact = value;
            return { ok: true };
          }
        }
      } as never,
      maxSteps: 10,
      stopToolName: "submit_completion_report",
      artifactName: "CompletionReport",
      getArtifact: () => artifact
    });

    expect(result.artifact).toEqual({ ok: true });
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    const nudgeCall = streamTextMock.mock.calls[1]?.[0];
    expect(nudgeCall.messages.slice(-4, -1)).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "contents" } }] },
      { role: "assistant", content: [{ type: "text", text: "done in prose" }] }
    ]);
    expect(nudgeCall.messages.at(-1)).toMatchObject({
      role: "user",
      content: "You did not call submit_completion_report. Call submit_completion_report now with your final CompletionReport. Do not write prose."
    });
    expect(nudgeCall.toolChoice).toEqual({ type: "tool", toolName: "submit_completion_report" });
    expect(nudgeCall.stopWhen[0]).toEqual({ type: "stepCountIs", steps: 3 });
  });

  it("does not nudge when the first turn exhausts its step budget", async () => {
    const { runAgentArtifact } = await import("../src/agents/runner.js");
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {})(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
      steps: Promise.resolve([{}, {}]),
      response: Promise.resolve({ messages: [] })
    }));

    const result = await runAgentArtifact({
      model: {} as never,
      system: "system",
      messages: [{ role: "user", content: "work" }],
      tools: {} as never,
      maxSteps: 2,
      stopToolName: "submit_completion_report",
      artifactName: "CompletionReport",
      getArtifact: () => undefined
    });

    expect(result.artifact).toBeUndefined();
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });
});
