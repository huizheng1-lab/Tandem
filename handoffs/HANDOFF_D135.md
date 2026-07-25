# Handoff D135 (remote control Round A: Telegram transport, pairing, read-only status)

First implementation round of the human-approved design in
`process/REMOTE_CONTROL_DESIGN.md` (formerly wishlist W0003, deliberately moved OUT of
the autonomous loop into human-reviewed D-rounds because it creates a new trust
boundary). **Read the design doc first - it is the spec; this handoff scopes Round A and
adds acceptance criteria.** The design's Open Questions section records the human's
decisions (Telegram confirmed; /prompt wanted but NOT in this round; single user;
default-deny approvals) - honor them.

## Scope: Round A ONLY

Build the `remote-bridge` module in the desktop main process with EXCLUSIVELY read-only
capability. No mutating verb of any kind may exist in this round's build - not pause,
not stop, not approvals, not prompt. Those are Rounds B-D, each its own future handoff.

Deliverables per the design doc:

1. **Transport**: Telegram long-polling only (`getUpdates`), outbound HTTPS, no webhook,
   no listening socket. Token from `TELEGRAM_BOT_TOKEN` in `.env`; module completely
   inert (never loads, zero network calls) when the token or enablement is absent.
2. **Enablement + pairing**: off by default; desktop UI toggle; pairing ceremony exactly
   as designed (one-time 8-digit code shown in the DESKTOP UI, 5-minute validity,
   `/pair <code>` from the phone binds that sender's numeric ID; bound identity shown in
   the desktop UI). Non-allowlisted senders: silently dropped, one rate-limited audit
   line, no reply.
3. **Read-only commands**: `/status` (session id, phase, active role, run-health state
   from W0013's heartbeat if present, cost totals incl. W0010's cumulative) and
   `/sessions` (recent sessions: id-prefix, title, project - read-only list per the
   design's Session Semantics section).
4. **Revocation**: `/revoke` from the phone and the desktop toggle both fully unbind +
   stop polling. (BotFather-side revocation needs no code - just verify the bridge
   handles a dead token gracefully: log, back off, no crash loop.)
5. **Audit**: append-only JSONL per the design (every inbound command incl. rejected
   senders, every outbound send, pairing/revocation events). No secrets in the log.
6. **Rate limits**: the design's global limit applies even to read-only verbs.
7. Config surface: a `remoteControl` config block (schema-validated, all-optional so
   existing configs are untouched - remember the D99 lesson: never make an existing
   config fail to parse).

## Constraints

- This is Tandem product code (src/ + app/) in the ADMIN repo via the normal D-round
  flow - NOT a reciprocal item. Normal commit discipline.
- protection.ts, the automation server (D122), and the reciprocal machinery are not to
  be modified.
- No new dependencies unless genuinely necessary; if one is needed (e.g. nothing more
  than node's fetch should be required for Telegram's HTTP API - justify anything
  beyond that).
- The module must be cleanly separated (design's `RemoteTransport` interface) so a
  future non-Telegram transport slots in without rework.

## Acceptance

tsc + `npm test` green with new regressions (pairing state machine incl. code expiry +
wrong-code + wrong-sender paths; command parsing allowlist grammar; inert-when-disabled;
audit writing). **Live verification with the real Telegram bot and the user's real
phone is REQUIRED and is the round's centerpiece** (this project's standing discipline:
live-facing code is never accepted on unit tests alone): create the bot via BotFather
(ask the human for the token via the .env - do NOT paste tokens into the marker or
commits), pair from the real phone, show `/status` and `/sessions` returning real data,
show a non-allowlisted sender being ignored (a second account or the human's judgment
call if unavailable - say which), show `/revoke` working, and paste the audit-log lines
(redact chat ids partially). If any part of live verification cannot be completed
without the human (e.g. they must create the bot token first), implement everything,
verify what you can, and say plainly in the marker what awaits the human - do not fake
or simulate the Telegram side. Commit `D135-<n>:`. Create `handoffs/D135_done.txt`.
Rounds B-D (pause/stop, approvals, /prompt) come later as separate handoffs - do not
implement ahead.
