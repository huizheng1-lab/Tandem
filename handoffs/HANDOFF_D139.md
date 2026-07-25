# Handoff D139 (remote control Round C: route permission approvals to Telegram)

Third implementation round of `process/REMOTE_CONTROL_DESIGN.md`. **Read the design doc
first**, especially the 2026-07-18 additions (open questions 5 and 6) - the human
clarified that remote sessions must behave IDENTICALLY to desktop sessions, permission
mode included, which makes this round a hard prerequisite for Round D (the actual
prompt+streaming feature the human wants next). D138 (Round B: pause/resume/stop/use)
may be in flight or landed already - this round builds alongside/after it, same
Round A infrastructure, no conflict expected.

## Scope: Round C

When a running Tandem session in `ask` permission mode raises a permission request
(file write, shell command, plan confirmation) that would normally show a desktop
dialog, and the remote bridge is enabled+paired, the SAME request must also be pushed
to Telegram as a message with inline Approve/Deny buttons - not a replacement for the
desktop dialog, an ADDITIONAL surface for it (whichever answers first wins; the other
surface should reflect the resolved state, not double-prompt).

1. **Push**: permission/plan-confirmation requests get a Telegram message describing
   the action (tool name, target, a bounded summary of the command/diff - do not dump
   an entire large diff into a Telegram message; truncate with a note) plus inline
   Approve/Deny buttons.
2. **Timeout**: default-deny after 5 minutes for remote-surfaced requests specifically
   (per the human's earlier answer) - verify what the desktop's own pending-request
   timeout actually is (if any) and document the mirrored/adapted behavior precisely,
   don't assume. NEVER auto-approve on timeout.
3. **Resolution routing**: a button tap resolves the SAME underlying permission
   request the desktop would resolve - reuse the existing permission-bridge mechanism,
   don't build a parallel one. If the desktop resolves it first, the Telegram message
   should be edited to reflect that (e.g. "Resolved on desktop: approved") rather than
   staying live with dead buttons.
4. Rate limiting and audit: reuse Round A's infrastructure; every push, resolution,
   and timeout gets an audit line.
5. This only activates for sessions where the bridge is enabled AND paired - a session
   with remote control off must behave exactly as it does today (no behavior change,
   no latency added to the desktop-only path).

## Constraints

- Do not build Round D (`/prompt`) as part of this round, even partially.
- Do not change the underlying permission-bridge/ensurePermission mechanics beyond
  what's needed to also notify the Telegram side - this is an additional notification
  surface, not a redesign of permission handling.
- Reuse Round A/B infrastructure (pairing, allowlist, audit, rate limits, the
  RemoteTransport interface).

## Acceptance

tsc + `npm test` green with new regressions (dual-surface resolution race - desktop
resolves first vs Telegram resolves first vs timeout; truncation of long
commands/diffs in the pushed message). **Live verification with the human's real phone
is required, same standing as D136/D138**: put a real session in `ask` mode, trigger a
real permission request (e.g. a file write), confirm it appears on the phone with
working buttons, approve from the phone and confirm the desktop session proceeds; do
it again and deny from the phone, confirm the action is blocked; do it again and let
it time out, confirm default-deny with no action taken; if practical, show the
desktop-resolves-first case updating the phone message. Paste real evidence (redact
chat ids) and audit lines. Commit `D139-<n>:`. Create `handoffs/D139_done.txt`.

Round D (the human's actual goal - real-time prompt/response over Telegram) is the
NEXT handoff after this one lands and is reviewed - do not start it yet.
