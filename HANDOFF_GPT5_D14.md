# Handoff to GPT-5 — Round D14 (thinking suppression leaves blank rows)

Context: D13 APPROVED and shipped. User report: worker thinking is suppressed, but the
transcript shows many empty rows where the think blocks used to be.

## D14-1: Swallow whitespace stranded by suppressed think blocks
Cause: the worker emits patterns like `<think>…</think>\n\n\n\n<think>…</think>\ntext`. The
stream filter (src/agents/runner.ts) removes the tag contents but passes the newline runs
between/after blocks through to `onText`, so the UI accumulates whitespace-only deltas.

Fix in the filter, not the UI alone:
- While filtering, treat whitespace-only visible text that is adjacent to a suppressed block as
  part of the suppression: after emitting a removal, swallow following whitespace until the next
  non-whitespace visible character or the next think block; likewise swallow whitespace-only
  text at stream start that precedes a think block.
- Do NOT collapse whitespace inside genuine visible output (code blocks may legitimately contain
  blank lines) — only whitespace directly adjacent to removed blocks.
- Extend tests/thinking-filter.test.ts: `"<think>a</think>\n\n\n<think>b</think>\n\nHello"` →
  text `"Hello"`; `"line1\n\n<think>x</think>\n\nline2"` → `"line1\n\nline2"` is acceptable, or
  `"line1\nline2"` if you trim one side — state the chosen contract in the test names;
  split-chunk variants of the above.

Screenshot-confirmed worst case: a worker turn that is almost entirely thinking produces ONE
huge empty WORKER bubble — the whitespace deltas accumulate inside a single open bubble for the
whole turn. The fix contract must therefore cover: a turn whose visible output is entirely
whitespace produces NO bubble at all (the "thinking…" shimmer indicator is the only trace while
streaming, and nothing remains after the turn ends).

## D14-2: Renderer/TUI must not render whitespace-only bubbles
Defense in depth: in `app/renderer/src/main.tsx` `appendStream` (and the TUI equivalent), do not
create a message entry for a whitespace-only delta when no entry for that role is open; on
stream end (done/error), trim trailing whitespace from the last bubble and drop it if empty.

## Acceptance
tsc + `npm test` green; commits `D14-<n>:`. Reviewer will run a live worker round and expects a
transcript with no empty message rows, with thinking hidden and real output intact (including
any code blocks with internal blank lines).
