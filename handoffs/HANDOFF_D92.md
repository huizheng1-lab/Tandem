# Handoff D92 (REVISE of D91: checkpoint exemption missing, excluded sidecars were built anyway)

D91 (commit ffca122) was reviewed and REVISED. The bounding mechanics are competently built and
its own tests pass — but the implementation contradicts two explicit, load-bearing requirements
of `handoffs/HANDOFF_D91.md` (the rewritten version marked "authoritative"). Read that file's
D91-2 and D91-3 sections first; this round makes the implementation match them.

## Finding 1 (critical): no checkpoint exemption — resume can now be silently corrupted

`boundedSessionEvent()` in `src/session/store.ts` applies to EVERY event, including `machine`
events whose payload is a `{ type: "checkpoint" }` MachineEvent. Checkpoints carry the full plan
+ all reports + verdicts + feedback history, and resume reconstructs orchestration state
VERBATIM from the last checkpoint in the JSONL (`tandem-service.ts` `findLastCheckpoint` →
`runOrchestration` `initialState`; same in the TUI). The resume path does NOT resolve
`artifactPath` — it reads only the bounded JSONL preview. So a checkpoint serializing over
256KB (realistic: multi-round sessions accumulate every report's verificationResults output in
each checkpoint) now gets its strings truncated and its keys dropped (`__tandemTruncatedKeys`),
and a later resume silently continues from a MANGLED plan/reports. Before D91 this scenario
worked correctly; D91 as-built made it worse. This was handoff D91-2, explicitly labeled the
critical constraint, with a "non-negotiable" acceptance test (checkpoint-lossless round-trip)
that was not written.

Fix (D92-1): exempt checkpoint-carrying machine events from bounding entirely — detect
`event.type === "machine" && payload?.type === "checkpoint"` in `boundedSessionEvent()` (or
before calling it) and return the event unmodified. Add the non-negotiable regression test from
the D91 handoff: append a checkpoint machine event whose serialized payload exceeds
`SESSION_EVENT_JSON_MAX_BYTES` (build a synthetic checkpoint with many large reports), then
assert it round-trips COMPLETELY intact through `read()`/`readRecent()` and that a
`findLastCheckpoint`-style extraction yields a deep-equal checkpoint object.

## Finding 2: sidecar artifacts were explicitly excluded, but were built — and leak exactly as predicted

Handoff D91-3 said, verbatim: "NO sidecar artifact files ... They'd need lifecycle cleanup in
`deleteSession()` and `pruneOldEmptySessions()` (which today remove only the `.jsonl` and the
index entry — sidecars would orphan)". The implementation added
`writePayloadArtifact()` writing full original payloads to `sessions/<id>.artifacts/<uuid>.json`
— and did NOT touch `deleteSession()` or `pruneOldEmptySessions()`. Confirmed in the current
code: `deleteSession()` still removes only the `.jsonl` + index entry. So deleting a session now
orphans precisely the multi-megabyte payloads this whole round exists to keep off disk.

Fix (D92-2): REMOVE the sidecar mechanism (`writePayloadArtifact`, `artifactRelativePath`, the
`artifactPath` metadata field, and the sidecar assertions in tests). This is a decision, not an
option — the handoff already adjudicated it: the observed oversized payloads are diagnostic
garbage (binary spew from a long-fixed crash), not content worth full-fidelity archival, and
keeping sidecars means every future session-file consumer (delete, prune, GC, any future
export/import) must know about a second storage location. The in-JSONL truncation metadata
(`truncated`, `originalBytes`, `storedBytes`, `note`) stays — it's good. Also update the
truncated-string marker text, which currently says "Full payload may be available in the event
artifact" — after removal that sentence is false; reword to match D91's original marker style
("[Tandem truncated N additional characters ... at storage time to keep the session log
bounded.]").

## Keep as-is (reviewed and accepted, don't churn)

- The recursive `previewValue()` string/array/object bounding and the three-stage fallback
  (preview → tighter fallback → structural stub) — reasonable, tested, keep.
- The 256KB whole-event threshold (`SESSION_EVENT_JSON_MAX_BYTES`) — differs from the D91
  handoff's suggested numbers but is acceptable ONCE checkpoints are exempt; no need to retune.
- The existing D91 tests for normal-event passthrough and readRecent-after-truncation — keep,
  minus the sidecar assertions.

## Acceptance

tsc + `npm test` green. The checkpoint-lossless round-trip test exists and passes — this is the
non-negotiable item, same as it was in D91. No `.artifacts/` directory is created by any test
run (assert its absence in the oversized-event test). `git grep artifactPath src/` returns
nothing. Commit `D92-<n>: ...`, create `handoffs/D92_done.txt` with commit hash and
verification summary.
