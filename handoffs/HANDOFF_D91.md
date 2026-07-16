# Handoff D91 (data hygiene: bound session event payloads at the append boundary)

Rewritten by the Claude leader from GPT-5.6's original draft after review; this version is
authoritative. Core idea preserved (bound huge payloads at persistence time, not just at render
time), with two design corrections: checkpoint events must stay losslessly resumable, and the
sidecar-artifact idea is explicitly dropped to keep scope narrow.

## Problem (confirmed with real incident data, don't re-derive)

`SessionStore.append()` (src/session/store.ts) serializes whatever payload it's given with no
size ceiling. Real consequences already observed on this machine:

- Session `a5629880-4bba-43e6-bb32-8f87129dbb26` permanently contains four `machine` error
  events of ~2.9 MILLION characters each (a pre-D83 Node null-byte error that embedded an entire
  binary-laden CLI argv in its `.message`). Those events froze the desktop renderer outright
  until D89 added render-side caps.
- That session file reached 29.7MB, which made every unbounded full-file read expensive (D86/D88
  fixed the hot readers with bounded head/tail reads).

D86/D88/D89 taught each READER to defend itself. This round makes the WRITER defend the store:
no single event should ever be able to bloat a session file by megabytes again, no matter what
future bug produces the oversized content.

## What to do

D91-1: add a bounding step inside `SessionStore.append()` (the single choke point — all writers
go through it) that caps oversized STRING fields in the event payload before serialization:

- Walk the payload (same recursive style as the existing `sanitizePromptValue`/`stripNulls`
  helpers — reuse a pattern, don't invent a new traversal idiom). For any string field longer
  than the cap, replace it with: `<prefix slice> + "\n\n[Tandem truncated N additional
  characters at storage time to keep the session log bounded.]"`.
- Recommended cap: **300,000 characters per string field**. Rationale: comfortably above D89's
  render-side state cap (200k chars, `MESSAGE_TEXT_STATE_CHARS` in
  app/renderer/src/TranscriptText.tsx) so storage truncation never becomes the visible limiter
  in normal UI flows — the two layers stay independently reasoned. Export the constant; don't
  bury a magic number.
- Add truncation metadata on the event (e.g. `truncated: true` at the event level, or per-field
  markers — keep it simple; the in-string marker plus one boolean is enough). Existing readers
  must keep working: `payloadText()` in history.ts, `rebuildLeaderThread`, the desktop replay
  loop, and compaction all read these string fields and a truncated string is still a string.
- As a defensive backstop for non-string bloat (a pathological array of many strings), if the
  WHOLE serialized event still exceeds 2MB after string capping, store a stub event of the same
  `type` with a short structural note (`{ truncatedEvent: true, originalBytes }`) instead of the
  payload. This case should be near-impossible once strings are capped — it's a fuse, not a
  feature.

D91-2 (**critical constraint — this is why the original draft was rewritten**): checkpoint
events MUST NOT be lossily truncated. `machine.ts`'s checkpoint events carry the full plan +
reports + verdicts + feedback history, and resume reconstructs orchestration state VERBATIM
from the last checkpoint (`tandem-service.ts` `findLastCheckpoint` → `runOrchestration`'s
`initialState`; same pattern in the TUI). A large-but-legitimate plan could exceed any
reasonable cap, and truncating it would make resume silently continue from a corrupted plan —
worse than the disease. Implementation: exempt machine events whose payload is a
`{ type: "checkpoint" }` MachineEvent from D91-1's capping entirely. (Checkpoint bloat is real
but is a SEPARATE problem — superseded checkpoints outlive their usefulness — and is explicitly
out of scope this round; see follow-ups.) Everything else (text/thinking deltas, tool events,
machine error/transition/notice events, user prompts, done summaries) gets capped.

D91-3: explicitly NOT in scope (decisions made at review, don't build these):
- NO sidecar artifact files (the original draft's suggestion). They'd need lifecycle cleanup in
  `deleteSession()` and `pruneOldEmptySessions()` (which today remove only the `.jsonl` and the
  index entry — sidecars would orphan), and the observed oversized payloads are diagnostic
  garbage (binary spew), not content worth preserving at full fidelity. If a future incident
  needs full-fidelity capture, that's its own round.
- NO rewriting/migrating existing session files. Old sessions stay as-is; readers already
  defend (D86/D88/D89).
- NO changes to render-side caps (D89) or bounded reads (D86/D88).

## Required tests

Unit tests are sufficient this round (pure store logic, no UI surface) — but they must include
the real incident shape, not only toy strings:

1. Appending a normal event is byte-identical to today (no regression for the common case).
2. Appending an event with a ~3-million-character string field (mirror the real incident: mixed
   normal text + binary-ish garbage) produces a bounded JSONL line with the truncation marker
   and metadata; `read()` and `readRecent()` parse the file cleanly afterward.
3. **Checkpoint losslessness**: append a checkpoint machine event whose serialized payload
   exceeds every cap (build a synthetic plan with many large tasks), then confirm it round-trips
   COMPLETELY intact through `read()`/`readRecent()` and that a resume-shaped consumer
   (`findLastCheckpoint`-style extraction) reconstructs the identical checkpoint object.
4. The whole-event 2MB fuse produces a typed stub and the file stays parseable.
5. `buildConversationHistory` and `rebuildLeaderThread` behave sanely on a truncated event
   (the summary/prompt string is shorter but present; no throw).
6. Session index title updates still work for a truncated oversized user prompt.

Static gates: `npm run typecheck`, `npm test`, `git diff --check`.

## Acceptance

All tests above green, including the checkpoint-lossless round-trip — that test is the
non-negotiable one. tsc + full `npm test` green. No unrelated files modified. Commit as
`D91-<n>: ...`, create `handoffs/D91_done.txt` with commit hash and verification summary.

## Follow-ups (recorded, not for this round)

- Checkpoint compaction (only the LAST checkpoint matters for resume; superseded ones are the
  main remaining source of file bloat) — see IMPROVEMENT_SUGGESTIONS.md §4.2.
- Verification identity (IDs instead of string echo) and, more fundamentally,
  orchestrator-executed verification — IMPROVEMENT_SUGGESTIONS.md §1.1 and the original draft's
  D92 candidate.
- claude-code-cli still passes `--json-schema`/`--system-prompt` via argv (only user prompts
  moved to stdin in D83/D84); `--system-prompt-file` was live-verified to exist during the D84
  investigation — good D93 candidate.
- Retry-with-feedback in `retryArtifact`, leader-token cost reductions, session GC, subprocess
  inactivity timeout — IMPROVEMENT_SUGGESTIONS.md §1.2, §2, §4.1, §3.1.
