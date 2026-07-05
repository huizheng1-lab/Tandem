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
});
