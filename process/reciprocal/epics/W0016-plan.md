# W0016 Telegram Remote Control Round D — Streaming Session Interaction

Objective: let a paired Telegram user interact with an individual running Tandem session — send a prompt and watch real-time streaming feedback in Telegram via message edits — while reusing the W0013 run-health heartbeat as the progress signal. Rounds A–C (pairing/status/sessions, pause/resume/stop/use, approval routing) are already merged, so Round D must build on the existing remote-control bridge and Telegram transport without regressing them.

This epic is `autonomy=plan-gated` and touches the pairing / remote-control surface, so the plan must be independently approved by a human before any implementation step begins. The relay's `autonomousContinuation` path is therefore disabled for this epic; every step requires an ordinary A `Start` after the plan candidate is accepted.

## Background (do not redesign)

- `src/remote-control/telegram.ts` already wraps `sendMessage`, `editMessageText`, `answerCallbackQuery`, and other `fetch` calls behind a `fetchImpl` seam. Round D must not reimplement these; it should compose with them.
- `src/remote-control/bridge.ts` already owns pairing, the command surface (`/status`, `/sessions`, `/pause`, `/resume`, `/stop`, `/use`), and the approval routing Round C introduced. Round D adds a streaming interaction surface on top.
- The W0013 run-health heartbeat exposes `healthy | quiet Ns | likely stalled`, elapsed time, current phase, role, and the last event kind. Round D will surface that state inside the live message instead of inventing a separate spinner or fake "thinking…" indicator.
- Pairing, allowlists, revocable credentials, rate limits, and confirmation for destructive actions are already enforced upstream; Round D inherits them and must not bypass or weaken them.
- The session store, cost ledger, search streaming (W0014), and run-health tracking (W0013) are existing infrastructure Round D consumes — not modifies.

## Invariants for every step

- Perform exactly one step per relay candidate and check only the implemented step box in the same commit.
- `npm run typecheck`, `npm test`, and `git diff --check` must all stay green after every step.
- Round D must never bypass pairing, the allowlist, rate limits, or the approval flow. A user without an active pairing cannot reach Round D commands; an action that requires approval routes through Round C unchanged.
- A running edit stream is bound to a single `(chatId, messageId)` pair per session. A second interaction for the same session reuses or replaces that pair deterministically; it never produces two parallel live messages for the same session.
- Edits are throttled to a single Telegram `editMessageText` per step (minimum interval ~1.5 s, or fewer than ~25 edits per minute per chat) so the transport rate limit is not exhausted. A burst of heartbeat updates must coalesce into the next tick.
- The live message must never claim a run is healthy when it is stalled. The heartbeat's `likely stalled` state must be visible verbatim, with elapsed time and last event kind, so the user can distinguish "still working" from "genuinely stuck".
- Send-prompt is read-mostly for the user-visible state, but it ultimately calls the existing session submission path; destructive actions still go through the existing approval callback.

## Ordered steps

- [ ] Step 1: build the streaming session gateway that subscribes to a session's events, formats a short live message, and edits one Telegram message at most once per throttle window.
- [x] Step 2: add prompt submission into a selected session, with the live message becoming the streaming response; replies on a live message route to that session.
- [ ] Step 3: integrate with the existing Round C approval flow so any prompt that requires approval pauses the stream, renders the approval card, and resumes or aborts based on the callback.

## Step 1 — Streaming session gateway

Files expected (≤ 6 production files):

- `src/remote-control/streaming-session.ts` (new) — pure formatting + subscription glue: takes a session event subscription and a clock, yields coalesced `StreamingSnapshot` records at most once per throttle interval, and renders the live message text from the snapshot.
- `src/remote-control/telegram-session-stream.ts` (new) — owns the `editMessageText` loop: starts a stream for a `(chatId, messageId, sessionId)` triple, schedules coalesced edits through the existing `telegram.editMessageText`, and stops cleanly on `stopStream`, session end, or transport failure.
- `src/remote-control/bridge.ts` (extension only) — expose `startSessionStream(chatId, messageId, sessionId)` and `stopSessionStream(chatId, messageId)` so the renderer (or future inline handler) can begin and end streams without touching the transport directly. Do not refactor existing bridge code; only add the new hooks and a registry that maps triples to active streams.
- `tests/remote-control-streaming-session.test.ts` (new) — pure unit tests for coalescing, throttle, heartbeat text formatting, and stalled-state rendering using fake timers.
- `tests/remote-control-telegram-session-stream.test.ts` (new) — unit tests for the edit loop, using a stub `telegram.editMessageText` to assert throttled edit count, replacement on stream restart, and clean shutdown on `stopStream`, session end, and transport error.
- this plan file, only to check Step 1 complete.

Implementation notes:

- The live message format is a small fixed template: a one-line header (`role / phase / elapsed`), a one-line health line that is either `healthy`, `quiet Ns — last event: <kind>`, or `likely stalled — last event: <kind>`, and up to N lines of recent streamed text (default 12), with the last line truncated to fit Telegram's 4096-character limit.
- Coalescing is keyed by session; a burst of N heartbeat updates within the throttle window yields exactly one edit. The snapshot carries a `version` counter that increments on every coalesced update so a stale edit is rejected by the test harness (and is safe even if Telegram applies a late edit out of order).
- The `stopStream` path must cancel pending timers, remove the triple from the bridge registry, and never throw if the underlying session has already ended.

Acceptance evidence:

- `tests/remote-control-streaming-session.test.ts` proves the heartbeat states (healthy / quiet / likely stalled) format correctly, that coalescing reduces a 10-event burst to one snapshot, and that no snapshot is emitted after `stopStream` is called.
- `tests/remote-control-telegram-session-stream.test.ts` proves a 3-second burst of 20 events triggers at most 2 edits, that a `stopStream` mid-burst cancels the next edit, and that a transport error from `editMessageText` does not crash the stream.
- `npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/remote-control-streaming-session.test.ts tests/remote-control-telegram-session-stream.test.ts` passes.
- `npm run typecheck` and `git diff --check` pass.

## Step 2 — Prompt submission and live reply routing

Files expected (≤ 6 production files):

- `src/remote-control/bridge.ts` (extension only) — add `/prompt <text>` and a reply-on-live-message path: when the user replies to a Telegram message that is currently bound to a streaming session, the reply text is forwarded to that session as a new user prompt. Add a `/cancel` command that ends the current stream and posts a short summary of the last snapshot.
- `src/remote-control/prompt-submission.ts` (new) — pure module that takes a `(chatId, sessionId, text)` triple and a session submission seam, validates the text (length cap, no control characters that would corrupt the JSONL), and emits a structured `PromptSubmissionResult` so the bridge can branch on the existing approval flow without coupling to it.
- `src/remote-control/telegram-session-stream.ts` (extension only) — on a successful prompt submission, the existing stream becomes the response stream: the same `(chatId, messageId)` triple is reused, the snapshot is reset to `submitting`, and the next event tick is rendered against the new prompt. On submission failure, the stream posts a one-line error footer in the next edit and stays bound to the session so the user can retry.
- `tests/remote-control-prompt-submission.test.ts` (new) — unit tests for length cap, control-character rejection, empty-text rejection, and the structured result types.
- `tests/remote-control-bridge-prompt.test.ts` (new) — integration test using a stub Telegram transport and a stub session submission seam: a `/prompt` routes to the selected session, a reply on a live message routes to the same session, a second concurrent reply reuses the same triple, and `/cancel` stops the stream and emits the summary.
- this plan file, only to check Step 2 complete.

Implementation notes:

- The existing `/use <sessionId>` command (Round B) is the only way to bind a chat to a session. Round D does not introduce a parallel selection path. If a chat has no bound session, `/prompt` and replies fall through to the existing Round A "no active session" reply.
- The prompt submission seam must not bypass pairing, the allowlist, or rate limits. Round D relies on the bridge-level checks Round A introduced; it does not reimplement them.
- Reply routing reads `message.reply_to_message.message_id` from the inbound update. The bridge's existing message-id → triple registry (introduced in Step 1) is the only lookup; an unknown `reply_to_message.message_id` is treated as a free-form `/prompt` and falls through to the bound session if one exists, or returns the existing "no active session" reply.

Acceptance evidence:

- `tests/remote-control-prompt-submission.test.ts` proves the validation rules and the structured result.
- `tests/remote-control-bridge-prompt.test.ts` proves routing, reuse of the live triple, the no-bound-session fallback, and `/cancel` behavior.
- `npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/remote-control-prompt-submission.test.ts tests/remote-control-bridge-prompt.test.ts` passes.
- `npm run typecheck` and `git diff --check` pass.

## Step 3 — Approval integration for prompts

Files expected (≤ 6 production files):

- `src/remote-control/bridge.ts` (extension only) — when a prompt submission returns `requiresApproval`, the live message is replaced (via a new edit) with the existing approval card from Round C; on approval, the stream resumes and the response is rendered; on denial, the stream posts a one-line "denied" footer and stays bound to the session.
- `src/remote-control/telegram-session-stream.ts` (extension only) — add `pauseForApproval()` and `resumeAfterApproval(result)` methods that swap the snapshot to an approval-aware template, preserve the prior streaming text in a footer for context, and restore the live template on resume.
- `src/remote-control/approval-routing.ts` (new, optional) — thin adapter that maps the structured `PromptSubmissionResult.requiresApproval` payload onto the existing Round C approval callback contract; only created if Step 1/2 surfaces a real mismatch, otherwise the bridge handles the mapping inline.
- `tests/remote-control-bridge-approval.test.ts` (new) — integration test using a stub Telegram transport: a prompt that requires approval pauses the stream, the existing approval callback is invoked, approval resumes the stream, denial posts the denial footer, and a second approval decision after resume is ignored.
- `tests/remote-control-telegram-session-stream.test.ts` (extension) — add cases for `pauseForApproval` / `resumeAfterApproval` that prove the snapshot template swaps and the prior text is preserved verbatim in the footer.
- this plan file, only to check Step 3 complete.

Implementation notes:

- The approval card is rendered by the existing Round C code path. Round D does not introduce a parallel approval UI; it only decides when to swap the live message to the approval card and when to swap it back.
- If the approval callback never resolves (e.g. the user ignores the card), the live message remains in the approval state until the session ends or the user sends `/cancel`. There is no separate timeout in this epic; the existing approval card's own timeout (Round C) governs.
- Round D must not weaken any Round C safety property: a prompt that requires approval is never executed before the callback resolves, and a denial always leaves the session unchanged.

Acceptance evidence:

- `tests/remote-control-bridge-approval.test.ts` proves the pause / resume / deny / cancel paths and the second-decision-ignored invariant.
- `tests/remote-control-telegram-session-stream.test.ts` extension passes.
- `npm --prefix "C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a" test -- tests/remote-control-bridge-approval.test.ts tests/remote-control-telegram-session-stream.test.ts` passes.
- `npm run typecheck` and `git diff --check` pass.

## Safety and scope

- Round D only touches `src/remote-control/`, the existing bridge registry, and tests under `tests/`. No agent, orchestrator, compaction, provider, model registry, credential, pairing, session-store, JSONL, IPC, preload, or renderer change is in scope.
- Pairing, allowlist, rate limits, and approval routing are inherited, not modified. Any new command or reply path is gated by the same checks Round A introduced.
- No new dependency, no protocol change, no branch topology change, no reciprocal script change. The runtime promotion gate (D151) and master integration remain human-only.
- The full suite remains `authoritative-only: npm test`; the focused commands above are the in-sandbox evidence for each step. The passive gate repeats the full suite before trust advances.
- This plan is plan-gated. After the plan candidate is independently accepted, the human must explicitly approve the plan before any implementation step begins. The relay's `autonomousContinuation` is not used for this epic.
