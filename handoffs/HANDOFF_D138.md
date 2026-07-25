# Handoff D138 (remote control Round B: pause/resume/stop + session switching over Telegram)

Second implementation round of `process/REMOTE_CONTROL_DESIGN.md` (Round A = D135/D136,
approved and live-verified: pairing, /status, /sessions, /revoke, all read-only). This
round adds real control. **Read the design doc first.** Follow its Command Surface
table and Session Semantics section exactly; this handoff scopes Round B and adds
acceptance criteria. Rounds C (approvals routing) and D (flag-gated /prompt) remain
SEPARATE future handoffs - do not implement them here even partially.

## Scope: Round B

1. **`/pause`** - pause the current orchestration run (mirrors the desktop's own
   pause). If a reciprocal-style relay context is somehow active for this instance,
   the design's Round A explicitly scoped reciprocal executors OUT - this bridge
   targets the human's own daily Tandem instance only; do not add relay-awareness.
2. **`/resume`** - resume a paused run.
3. **`/stop`** - EMERGENCY STOP per the design's confirmation flow: reply keyboard
   "Confirm STOP" with a single-use nonce, 60s expiry. No stop without confirmation;
   an expired or reused nonce is rejected with a clear message, not silently ignored.
4. **`/sessions`** (Round A, read-only) gains teeth: **`/use <id-prefix>`** switches
   which session subsequent commands (`/status`, `/pause`, `/resume`, `/stop`) act on -
   per the design's Session Semantics section. Ambiguous or unmatched prefixes get a
   clear rejection listing close matches, never a silent wrong-session action.
5. Rate limiting: reuse the design's global limit; `/stop` and `/use` count toward it
   like any other command.
6. Audit: every pause/resume/stop/use attempt (including rejected confirmations and
   ambiguous /use) gets an audit line, per the existing Round A pattern.

## Constraints

- No new mutating verb beyond pause/resume/stop/use - specifically NOT approvals and
  NOT /prompt (those are C and D).
- Reuse Round A's pairing/allowlist/audit/rate-limit infrastructure - don't duplicate
  or fork it.
- `/stop` must actually stop cleanly (same guarantee as the desktop's own stop
  control) - verify it doesn't leave a run in a half-torn-down state.
- Keep the `RemoteTransport` interface boundary from Round A intact.

## Acceptance

tsc + `npm test` green with new regressions (confirmation-nonce state machine incl.
expiry/reuse/wrong-value; /use matching incl. ambiguous-prefix rejection; rate limit
on the new verbs). **Live verification with the user's real phone and a real running
session is required, same standing as D136** - demonstrate: pause a real run from the
phone and confirm the desktop reflects it; resume it back; trigger /stop WITH
confirmation and verify the run actually stopped; trigger /stop and let the nonce
expire without confirming, verify nothing happened; /use to switch between two real
sessions and confirm subsequent /status reflects the new one; an ambiguous /use
prefix rejected. Paste real command/response evidence (redact chat ids) and the
relevant audit lines. If the human isn't available for live testing when this round
finishes, implement fully, verify everything unit-testable, and say plainly what
awaits them - do not simulate the Telegram side. Commit `D138-<n>:`. Create
`handoffs/D138_done.txt`.
