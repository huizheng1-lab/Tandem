# Handoff D89 (URGENT: real renderer freeze on a specific session — huge unbounded transcript text)

Found while live-verifying D88 (which is separately approved and correct for what it fixed). This
is a DIFFERENT, more severe bug: driving a real session switch through the actual desktop UI (not
just the raw backend IPC call, which D88 correctly sped up to 190ms) caused a genuine, reproducible
renderer freeze — confirmed via process monitoring, not guessed:
- CPU usage climbing continuously and without bound (69.9s → 73.3s of cumulative CPU in 5 wall-clock
  seconds — pegging a core).
- Memory climbing continuously (503MB → 528MB in the same 5 seconds, still rising).
- CDP's `Runtime.enable` — a trivially cheap command — timed out after 8+ seconds, meaning the
  renderer's JS thread was fully blocked, not just slow.
- Had to force-kill the process; it never recovered on its own within the time I waited.

## Root cause (confirmed by directly reading the actual stored session data)

The frozen session is a real one on the user's machine:
`~/.tandem/sessions/48cc7d6d326e/a5629880-4bba-43e6-bb32-8f87129dbb26.jsonl` (29.7MB file, part of
the historical D79-D83 incident arc). Read its bounded tail (via the real `SessionStore.readRecent`
D86 already added) and inspected every returned event's size directly. Four `machine`-type events
are **each ~4.7MB when serialized** (raw `message` field length ~2.9 million characters). Their
content is the literal, verbatim text of a Node.js-level `TypeError: Arguments cannot contain null
bytes` error — the OLD, pre-D83 spawn-argv crash class. Node's own null-byte validation error
embeds the entire offending argument value in its own generated `.message` string for
debuggability; that argument was, at the time, the full Claude Code CLI review prompt including an
unsanitized diff with raw binary PNG bytes (the file literally ends mid-PNG, with `IEND` — the PNG
end marker — visible in the trailing bytes). Tandem's own error-catching code stored this verbatim
via `String(error)`/`error.message` with no sanitization at that specific catch site, so it's now
permanently embedded in the session log.

This predates and is DIFFERENT from what D79/D82 already fixed:
- D79 sanitizes tool OUTPUT before it's echoed into chat.
- D82 sanitizes diff GENERATION (git and snapshot-based).
- Neither covers a downstream Error's own `.message` when something outside Tandem's control (here,
  Node's own argv validation) embeds raw data in the text it generates when throwing. D83 already
  fixed the underlying cause (moved the review prompt to stdin, so this exact crash class can't
  recur going forward) — but the damage from before that fix is already permanently logged in this
  and possibly other old sessions, and nothing currently caps how much of that gets rendered.

`app/renderer/src/main.tsx`'s `replaySession()` pushes this event's `message` directly as a
transcript entry's `text` field with no length check, and the actual render site
(~line 1346: `<div className="messageText">{entry.text}</div>`) puts the full ~2.9-million-character
string into a single DOM text node with zero truncation. This is almost certainly what makes the
browser's layout/reflow engine hang — a single text node of that size, especially one with irregular
binary content mixed into otherwise-normal text, is a well-known class of browser performance
cliff.

**Practical immediate workaround for the user right now** (mention this, don't require it as the
fix): since D85's session delete now genuinely works, the user can simply delete this specific old
session (`a5629880-4bba-43e6-bb32-8f87129dbb26`, titled "check video quality and fix if any problem
is...") if they don't need its history — that immediately removes the freeze trigger. This does NOT
replace the need for a real fix below, since any future large embedded content (not just this one
historical event) could trigger the same class of freeze.

## What to do

D89-1 (primary fix, defensive, independent of the specific historical cause): cap the rendered
length of any individual transcript entry's text in `app/renderer/src/main.tsx`. When
`entry.text.length` exceeds a reasonable threshold (pick something sane — a few thousand to a few
tens of thousands of characters is plenty for a chat bubble; Claude Code's own UI truncates very
long tool outputs with a "show more" affordance rather than rendering everything inline), render a
truncated preview with an explicit expand action instead of the full string, mirroring how large
artifacts/tool outputs are likely already handled elsewhere in this UI if such a pattern exists —
check for one before inventing a new one. This must apply regardless of WHY an entry got large
(historical crash artifact, a future bug, a genuinely huge legitimate output) — it's a defensive
rendering bound, not a data-source-specific fix.

D89-2 (small, do while in this area): consider whether `replaySession()`'s own JS-side event
processing loop (building the `replayed` array) should also guard against pushing an
extremely-oversized single entry, as a second layer — though D89-1 at the render layer is the more
important fix since it protects against any future oversized entry regardless of how it got into
`entries` state.

D89-3 (optional, only if trivial): the underlying stored data (the ~2.9MB error messages) will
still bloat that session's `.jsonl` file and slow down any future bounded reads of it slightly
(though `readRecent`'s chunked tail-read handles this fine per D86/D88's design — this is a minor
data-hygiene note, not a functional requirement). No action needed unless there's an easy,
low-risk way to note it; do not attempt to rewrite/migrate old session files as part of this round
— that's out of scope and risks data loss for real user history.

## Acceptance

tsc + `npm test` green. A regression test asserting a transcript entry with an extremely long
`text` field renders a truncated preview (assert on rendered DOM text length or a "show more"
element, not the full un-truncated string being present in the render). Live verification (this one
is essential, not optional — this bug can only be confirmed fixed by actually reproducing the
freeze scenario): rebuild the packaged app, resume the REAL session
`a5629880-4bba-43e6-bb32-8f87129dbb26` in `C:\Users\huizh\tmp_test_data\tandem_hyperframe_video`
(the user's real data — do not delete or modify it, just resume/view it) through the actual UI
click path, and confirm it no longer freezes — the switch should complete promptly and the UI
should remain responsive. Paste real before/after observations (CPU/memory behavior, confirmation
that CDP/the UI stays responsive) in the completion report, not just "it built." Commit `D89-<n>:`,
create `D89_done.txt` in `handoffs/`.
