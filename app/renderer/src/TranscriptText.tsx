import React, { useState } from "react";

export const MESSAGE_TEXT_PREVIEW_CHARS = 12_000;
export const MESSAGE_TEXT_EXPANDED_CHARS = 80_000;
export const MESSAGE_TEXT_STATE_CHARS = 200_000;

export function isMessageTextOversized(text: string): boolean {
  return text.length > MESSAGE_TEXT_PREVIEW_CHARS;
}

export function renderedMessageText(text: string, expanded: boolean): string {
  const limit = expanded ? MESSAGE_TEXT_EXPANDED_CHARS : MESSAGE_TEXT_PREVIEW_CHARS;
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

export function boundedMessageTextForState(text: string): string {
  if (text.length <= MESSAGE_TEXT_STATE_CHARS) return text;
  const hidden = text.length - MESSAGE_TEXT_STATE_CHARS;
  return `${text.slice(0, MESSAGE_TEXT_STATE_CHARS)}

[Tandem desktop truncated ${hidden.toLocaleString()} additional characters from this stored transcript entry to keep the UI responsive.]`;
}

export function MessageText({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const oversized = isMessageTextOversized(text);
  const visible = oversized ? renderedMessageText(text, expanded) : text;
  const hiddenChars = Math.max(0, text.length - visible.length);

  return (
    <div className="messageText">
      {visible}
      {oversized ? (
        <div className="messageOverflow">
          <span>
            Showing {visible.length.toLocaleString()} of {text.length.toLocaleString()} characters.
            {hiddenChars > 0 ? ` ${hiddenChars.toLocaleString()} hidden.` : ""}
          </span>
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
