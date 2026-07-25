# Tandem Remote Control - Design (formerly W0003)

**STATUS: DESIGN FOR HUMAN REVIEW - DO NOT IMPLEMENT.** This document is not an
implementation handoff. After the human approves (or amends) the decisions below, the
leader will cut it into individually reviewed D-series handoffs. It deliberately lives in
`process/`, not `handoffs/`, so no implementer or autonomous executor picks it up.

## Goal

Control and monitor a running Tandem desktop instance from the user's iPhone: see status,
approve/deny pending actions, pause/resume, emergency-stop, and (gated) send new
instructions - with an allowlisted user, revocable credentials, least privilege, rate
limits, confirmation for destructive actions, and a complete audit log.

## 1. Transport decision

Evaluated: Telegram bot, Slack/Discord bot, self-hosted web UI over VPN (Tailscale),
SMS/Twilio, email.

**Recommendation: Telegram bot, long-polling only.**

- The app makes OUTBOUND HTTPS calls to Telegram (`getUpdates` long-poll). No webhook, no
  inbound port, no public endpoint, no firewall/router changes - the machine exposes
  nothing. This is the single biggest attack-surface decision and long-polling wins it.
- Free, reliable push to iPhone, supports inline buttons (ideal for Approve/Deny), bot
  credentials are revocable server-side at any time via BotFather.
- Runner-up: self-hosted panel over Tailscale (stronger privacy - no third party sees
  message content) but meaningfully more setup and a real web-attack surface to maintain.
  Not chosen for v1; the design keeps the transport behind an interface so it could be
  added later.

**Documented tradeoff**: message content (status text, prompts you send) transits
Telegram's servers. Mitigation: a configurable status verbosity level, and nothing
secret (keys, tokens, file contents) is ever included in outbound messages by design.

## 2. Architecture

A `remote-bridge` module INSIDE the Tandem desktop main process (not a separate daemon):

- Off by default. Enabled only when both a bot token and an allowlist/pairing exist AND
  the user turns it on in the desktop UI. No config -> the module never loads.
- It talks to the existing service layer through the same narrow verbs the D122
  automation surface established (status / session / prompt) plus new pause / stop /
  approval-response verbs added for it. It reuses that boundary rather than reaching into
  internals - one place to audit what remote control can ever do.
- In-process keeps lifecycle simple (bridge dies with the app; a dead app can't be
  remote-controlled anyway). The one capability lost - "phone alerts me when the app is
  DOWN" - is explicitly out of scope for v1.
- Designed behind a `RemoteTransport` interface so Telegram is a plug-in, not a marriage.

## 3. Pairing and authentication

Layered, all of which must hold:

1. **Bot token** (`TELEGRAM_BOT_TOKEN` in `.env`, same handling class as existing API
   keys; revocable instantly via BotFather).
2. **Allowlisted numeric Telegram user ID** - IDs are immutable (usernames are not).
   Stored in local config. Exactly ONE allowed ID in v1.
3. **Pairing ceremony** (sets or confirms the allowlist): when the user enables the
   bridge, the DESKTOP UI displays a one-time 8-digit code valid for 5 minutes. The user
   sends `/pair <code>` from their phone; the bridge binds that sender's numeric ID and
   shows the bound identity in the desktop UI. This proves control of both ends and
   prevents allowlisting a typo'd ID.
4. **Everything from any other sender is dropped**: no reply (don't reveal the bot is
   alive), one audit line, and rate-limited counting so a spammer can't bloat the log.
5. **Revocation, three independent paths**: `/revoke` from the phone; a disable toggle in
   the desktop UI (always wins, works even if the phone is lost); revoking the bot token
   at BotFather (kills transport entirely).

**Residual risk stated plainly**: if the user's Telegram account itself is compromised
(and Telegram 2FA fails), the attacker gets whatever the command surface allows until
revocation. This is why the command surface is narrow, destructive actions confirm, and
`/prompt` is flag-gated (below) - and why desktop-side revocation must always win.

## 4. Command surface (v1 - deliberately narrow)

| Command | Effect | Gating |
|---|---|---|
| `/status` | Session id, phase, active role, run-health (W0013's heartbeat if landed), cost totals | none |
| `/pause` / `/resume` | Pause/resume the current orchestration run (and relay, if the reciprocal context is active) | rate-limited |
| `/stop` | Emergency stop of the current run | confirmation: reply keyboard "Confirm STOP" with a nonce, 60s expiry |
| Approve/Deny buttons | Pushed to the phone when ask-mode raises a permission request or plan confirmation; taps route back as the response | timeout behavior: **default deny after the same timeout the desktop would apply; never auto-approve** |
| `/prompt <text>` | Send a new instruction to the current session | OFF by default (`remoteControl.allowPrompt: false`); when enabled: length cap, echo-confirm, strictest rate limit |

Explicitly NOT in v1: file read/write, config or model changes, memory notes, shell
anything, multi-user support, session switching. Each would be its own reviewed design
change.

## 5. Rate limits and abuse controls

- Global: max 10 commands/minute, then a cooldown notice.
- `/prompt`: max 3/hour, 2,000-char cap.
- Confirmation nonces: single-use, 60s expiry, invalidated by any newer command.
- Long-poll offset handling prevents replay of already-consumed updates.

## 6. Audit

Append-only JSONL (`~/.tandem/remote-control-audit.jsonl` or per-project equivalent):
every inbound command (sender id, verb, args hash for /prompt, decision, outcome), every
outbound notification kind, every pairing/revocation event. Surfaced read-only in the
desktop UI. Nothing sensitive in the log itself (prompt text stored as hash + length in
the audit line; the actual prompt already lands in the session log like any other).

## 7. Threat sketch (what we defend against, what we accept)

- Stolen phone / compromised Telegram account -> narrow verbs, confirmations, default-
  deny approvals, three revocation paths. Accepted residual: /status leakage and
  pause/stop nuisance until revoked.
- Token leak from `.env` -> same class as existing provider keys; BotFather revocation;
  bot without pairing still refuses all senders except the bound ID.
- Telegram outage/MITM -> TLS to Telegram; outage degrades to "no remote control",
  desktop unaffected.
- Malicious content in inbound messages -> commands parsed against a strict allowlist
  grammar; anything else ignored; inbound text is NEVER fed to a model or shell except
  the explicit, flag-gated `/prompt` body, and prompt-injection risk there is identical
  to typing in the desktop composer (it's a user-authored prompt by definition).

## 8. Phasing for D-series implementation (each round separately reviewed, live-verified)

1. **Round A - transport + pairing + read-only `/status`.** No mutating verb exists in
   the build at all. Live verification: real phone, real pairing ceremony, wrong-sender
   rejection shown in audit.
2. **Round B - `/pause`, `/resume`, `/stop`** with confirmations and rate limits.
3. **Round C - approvals routing** (ask-mode permissions + plan confirmations to inline
   buttons, default-deny on timeout).
4. **Round D - flag-gated `/prompt`**, audit UI panel in the desktop app, hardening pass.

No round mixes new trust surface with convenience features; any round can be the stopping
point and the feature remains coherent.

## Open questions - ANSWERED by the human (2026-07-17)

1. Telegram confirmed as the transport. ("make the telegram/messaging app support plan
   a handoff")
2. `/prompt` IS wanted - the feature should serve as a full remote control of a running
   session, in the spirit of Claude Code's /remote-control. It stays in Round D with its
   flag-gating and rate limits as designed.
3. Approvals timeout: mirror the desktop's existing pending-request behavior; where the
   desktop would wait indefinitely, apply default-deny after 5 minutes for
   remote-surfaced requests (never auto-approve). Implementer verifies what the desktop
   actually does and documents the mirrored behavior.
4. Single allowlisted user confirmed.
5. (2026-07-18) Clarified what "/prompt" actually means to the user: a REAL interactive
   loop - send a prompt from the phone, get live/streaming feedback back, "just like
   Claude Code's own /remote-control." Not fire-and-forget.
6. (2026-07-18) Remote-session permission handling: session permission mode (ask /
   auto-edit / yolo) must behave IDENTICALLY whether driven from the desktop or from
   Telegram - no special "auto-edit for remote" bypass. This makes Round C (approvals
   routing) a HARD PREREQUISITE for a genuinely useful Round D: an `ask`-mode session
   prompted remotely with no approval path would simply hang forever with nobody at the
   desktop to click. Round D must not be built (or at least not verified as complete)
   until Round C is live and real.

## Round D design note: streaming feedback over Telegram (added 2026-07-18)

Telegram has no low-latency token-streaming primitive comparable to a terminal. The
practical, widely-used pattern (and the one to build): send one initial message when a
remote-prompted run starts, then EDIT that same message periodically as the run
progresses, then a final edit with the completed result. Two implementation notes:
- Reuse W0013's run-health heartbeat as the progress signal (phase, elapsed, last event
  kind) rather than inventing a second progress-tracking mechanism - the two features
  are a natural pair.
- Do not edit on a fixed short timer (e.g. every token or every second) - Telegram
  message-edit rate limits will throttle a chat well before that. Edit on meaningful
  state changes (phase transition, tool call, or a coarse timer no tighter than ~5s,
  whichever is less frequent) and always do a final edit with the real result on
  completion. If the final result is long, send it as a follow-up message rather than
  cramming it into the progress message's edit history.

## Session semantics ("remote control of any running session")

The bridge attaches to the Tandem desktop instance it runs inside, and its commands act
on that instance's ACTIVE session. Round A adds a read-only `/sessions` command listing
recent sessions (id-prefix, title, project) so the phone can see what exists; switching
the active session remotely (`/use <id-prefix>`) lands in Round B alongside the other
mutating-but-nondestructive verbs. One instance per bridge: if multiple isolated Tandem
instances run (e.g. reciprocal executors), each would need its own bridge+token -
reciprocal executors are explicitly OUT of scope for v1 (human's daily instance only).
