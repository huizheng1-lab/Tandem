import { describe, expect, it } from "vitest";
import { ThinkingStreamFilter } from "../src/agents/runner.js";

function runFilter(chunks: string[]): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  const filter = new ThinkingStreamFilter((delta) => {
    text += delta;
  }, (delta) => {
    thinking += delta;
  });

  for (const chunk of chunks) filter.push(chunk);
  filter.end();
  return { text, thinking };
}

describe("ThinkingStreamFilter", () => {
  it("strips a think block contained within one chunk", () => {
    expect(runFilter(["hello <think>secret</think>world"])).toEqual({ text: "hello world", thinking: "secret" });
  });

  it("strips a think block when the opening tag is split across chunks", () => {
    expect(runFilter(["<thi", "nk>secret</think>visible"])).toEqual({ text: "visible", thinking: "secret" });
  });

  it("strips a think block when the closing tag is split across chunks", () => {
    expect(runFilter(["visible<think>sec</thi", "nk>done"])).toEqual({ text: "visibledone", thinking: "sec" });
  });

  it("suppresses the remainder when a think block never closes", () => {
    expect(runFilter(["visible<think>secret", " still secret"])).toEqual({ text: "visible", thinking: "secret still secret" });
  });

  it("handles multiple think blocks in a stream", () => {
    expect(runFilter(["a<think>one</think>b<think>two</think>c"])).toEqual({ text: "abc", thinking: "onetwo" });
  });

  it("swallows whitespace between consecutive think blocks and before real output", () => {
    expect(runFilter(["<think>a</think>\n\n\n<think>b</think>\n\nHello"])).toEqual({ text: "Hello", thinking: "ab" });
  });

  it("preserves visible blank lines before a later think block but swallows whitespace after it", () => {
    expect(runFilter(["line1\n\n<think>x</think>\n\nline2"])).toEqual({ text: "line1\n\nline2", thinking: "x" });
  });

  it("swallows adjacent whitespace around think blocks split across chunks", () => {
    expect(runFilter(["<think>a</think>\n", "\n<thi", "nk>b</think>\n", "\nHello"])).toEqual({ text: "Hello", thinking: "ab" });
  });

  it("emits no visible text for a turn that is only thinking plus whitespace", () => {
    expect(runFilter(["<think>a</think>\n\n", "\n<think>b</think>\n\n"])).toEqual({ text: "", thinking: "ab" });
  });

  it("suppresses a stray closing tag emitted after provider reasoning deltas", () => {
    expect(runFilter(["</think>"])).toEqual({ text: "", thinking: "" });
  });

  it("suppresses a split stray closing tag without leaking partial text", () => {
    expect(runFilter(["</thi", "nk>\n\nvisible"])).toEqual({ text: "visible", thinking: "" });
  });
});
