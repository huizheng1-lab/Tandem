import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  boundedMessageTextForState,
  MESSAGE_TEXT_EXPANDED_CHARS,
  MESSAGE_TEXT_PREVIEW_CHARS,
  MESSAGE_TEXT_STATE_CHARS,
  MessageText,
  renderedMessageText
} from "../app/renderer/src/TranscriptText.js";

describe("MessageText", () => {
  it("renders oversized transcript entries as a bounded preview", () => {
    const longText = `start-${"x".repeat(MESSAGE_TEXT_PREVIEW_CHARS + 500)}-tail`;
    const markup = renderToStaticMarkup(<MessageText text={longText} />);

    expect(markup).toContain("Show more");
    expect(markup).toContain("Showing");
    expect(markup).toContain("start-");
    expect(markup).not.toContain("-tail");
    expect(renderedMessageText(longText, false)).toHaveLength(MESSAGE_TEXT_PREVIEW_CHARS);
    expect(renderedMessageText(longText, true)).toHaveLength(longText.length);
  });

  it("caps transcript text stored in renderer state", () => {
    const longText = `${"x".repeat(MESSAGE_TEXT_STATE_CHARS + MESSAGE_TEXT_EXPANDED_CHARS)}tail`;
    const bounded = boundedMessageTextForState(longText);

    expect(bounded.length).toBeLessThan(longText.length);
    expect(bounded).toContain("Tandem desktop truncated");
    expect(bounded).not.toContain("tail");
  });
});
