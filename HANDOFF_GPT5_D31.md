# Handoff to GPT-5 — Round D31 (dedupe leader context: thread OR history digest, not both)

D30 is functionally approved (live two-turn continuity verified). One efficiency defect from
implementing D28+D29+D30 together: in `src/agents/live.ts` `plan()`, every user turn pushed onto
the persistent `leaderThread` ALSO embeds the full D28 "Compact session-log history:" digest.
The thread already contains those turns as real messages, so each new turn adds a redundant
digest of all prior turns — and old digests stay inside old thread messages forever. By turn N
the leader context carries the real conversation plus N-1 nested summaries: compounding token
cost with zero information gain.

## D31-1: History digest only when no thread
- Rule: if a non-empty `leaderThread` is provided, do NOT embed `history` in the new user turn
  (the thread IS the history). The history digest remains the fallback for thread-less callers
  and as the compaction summary source.
- Also strip prior embedded digests when REBUILDING the thread from old session logs
  (`rebuildLeaderThread`): drop the "Compact session-log history:" block from reconstructed
  user turns so existing sessions get cleaned on next resume.
- Keep the "context: N prior turns" notice (it should count thread turns).
- Unit tests: with thread → new turn contains no digest; rebuilt thread from a log containing
  digest-bearing turns → digests stripped; without thread → digest present.

## Acceptance
tsc + `npm test` green; commit `D31-1:`. Reviewer will inspect the assembled context in a
3-turn fake-agent test (no duplicated content) and spot-check a live 2-turn run's logged
context sizes.
