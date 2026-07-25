# Handoff D136 (rebuild with D135; live-verify Telegram remote control Round A with the human)

The human has created the Telegram bot and saved `TELEGRAM_BOT_TOKEN` in the GLOBAL env
file (`C:\Users\huizh\.tandem\.env` - verified present, key name only). D135's code is
approved at the code level; this round completes its REQUIRED live verification, which
was honestly deferred for lack of a token.

## D136-1: rebuild the packaged app

`npm run dist:app` (BUILD_INFO stamping included per D120). The current release build
predates D135. Confirm the stamp shows a commit containing 84f5048. Do NOT touch the
reciprocal executor runtimes - this round is about the human's daily app only; runtime
promotion for executors stays behind the dashboard gate as usual.

## D136-2: live verification protocol (split: what you do vs what needs the human)

The human is available and expecting this. Steps YOU can do:
- Launch the rebuilt app normally (their daily instance; make sure no stale instance is
  running first - coordinate via the marker/notes rather than killing anything the
  human may be using).
- Confirm the bridge is INERT before enablement: no Telegram network calls, no polling
  (evidence: audit log empty / no bridge start line).
- After the human pairs (below): verify the audit JSONL contains the pairing event,
  the /status and /sessions commands with outcomes, rate-limit behavior if exercised,
  and (if the human can send from a second account or asks a family member) the
  wrong-sender silent-drop line. Partially redact chat ids in the marker.
- Dead-token resilience: after all positive tests pass, TEMPORARILY test graceful
  handling if practical without disrupting the human's working setup (e.g. verify the
  code path via the existing unit tests instead if a live token-invalidation test is
  too disruptive - say which you did).

Steps that need the HUMAN (write these into the marker as a short checklist for them,
and coordinate by leaving the app running):
1. Open the desktop app's new Remote Control section, toggle Enable - an 8-digit
   pairing code appears.
2. In Telegram, message their bot: `/pair <code>` (within 5 minutes).
3. Send `/status` and `/sessions` from the phone - confirm real data comes back.
4. Optionally send garbage text - should get the short supported-commands reply.
5. `/revoke` from the phone at the end IF they want to test unbind, then re-pair if
   they intend to keep using it (or leave paired - their choice; note which).

## Acceptance

Rebuild stamped and verified. The live checklist executed with the human: pairing
worked, /status and /sessions returned real session data on the phone, audit log lines
pasted (redacted), wrong-sender case either demonstrated or explicitly noted as
untestable today. Any friction the human hits in the UI flow (confusing toggle, code
hard to find, etc.) gets recorded verbatim in the marker as future UX input, not
silently smoothed over. tsc + `npm test` green as sanity. Commit `D136-<n>:` if any
code fix proves necessary during live testing (small fixes allowed; anything
structural gets reported for a new round instead). Create `handoffs/D136_done.txt`.
