# W0023: Telegram Remote Control Round D — Approval Integration (Step 3)

## Objective

Implement only the remaining W0016 Round D Step 3 behavior: connect `requires-approval` prompt submissions to the existing Round C approval card and callback registry. When a Telegram prompt returns `requires-approval`, the bound stream pauses, the existing approval card is pushed, and the stream resumes after a single decision. On approval, the prompt is submitted. On denial or timeout, a denied footer is rendered while the selected session remains unchanged. The accepted W0021/W0022 baseline and all D158–D161 prompt, streaming, service wiring, diagnostics, and tests are preserved verbatim.

## Lifecycle note

The reciprocal `Claim` command returned `phase=working activeRole=A` and the `Start` command reported that W0023 is already owned by role A (`IN_PROGRESS ... phase=PLAN role=A started=2026-07-22T12:57:12Z`). Per the protocol, the lifecycle is not re-entered; this planning turn is the authorized plan-only candidate that records the remaining Step 3 plan and leaves the guarded commit and `Complete` to Tandem's app layer.

## Autonomy and authority gate

The wishlist item is `autonomy=full phase=PLAN`, but the implementation of the single remaining source step (Step 3) is a sensitive authority boundary because it changes the remote-control approval surface. The relay's `autonomousContinuation` MUST be disabled for this epic; an ordinary A `Start` is required after the plan candidate is independently accepted.

The human authority gate attached to this plan grants authority ONLY to:

1. Connect `requires-approval` prompt results to the existing Round C `pushApproval` / `resolveApproval` / `pendingApprovals` registry, reusing the existing `APPROVAL_PREFIX` callback format and `formatApprovalRequest` card.
2. Pause the bound `TelegramSessionStream` for the duration of one decision and resume it on a single approval.
3. Render a denied or timeout footer on denial or timeout without clearing `selectedSessionsByChat`.
4. Cancel the in-flight approval on `/cancel` so the pending entry does not outlive the user's intent.

The gate grants NO authority for: pairing, the allowlist, rate-limit changes, credential or token handling, the prompt validation rules, a parallel approval UI surface, runtime promotion, master integration, or any protocol change. The `requires-approval` payload, callback routing, default-deny timeout, duplicate-decision suppression, and audit semantics are inherited verbatim from Round C; Step 3 does not redesign them.

## Accepted baseline and shared invariants

- W0016 Steps 1 and 2 are merged. `StreamingSessionGateway`, `TelegramSessionStream`, `submitRemotePrompt`, prompt routing in `handlePrompt`, the tap-to-use selection UX, and the streaming edits on the live `(chatId, messageId)` triple are accepted and untouched.
- W0021 and W0022 are merged. The real `runOrchestration` answer path, the `BuildPlanOrAnswer.kind="answer"` and `done.summary` rendering in the stream, and the separate prompt-rate-limit bucket are accepted and untouched.
- Round C is the single source of truth for approval routing: `pushApproval`, `resolveApproval`, `pendingApprovals`, `formatApprovalRequest`, the `APPROVAL_PREFIX` callback, `REMOTE_APPROVAL_TTL_MS = 5 * 60 * 1000`, and the default-deny timeout. Step 3 MUST reuse these symbols without redefining them.
- A running stream is bound to a single `(chatId, messageId, sessionId)` triple. Approval integration MUST NOT spawn a second live message for the same session; the approval card MUST be painted by editing the existing bound message in place.
- The selected session (`selectedSessionsByChat`) MUST remain set after approval, denial, timeout, or cancel. Only an explicit `/use <other>` or `/revoke` clears it.
- Pairing, the allowlist, the prompt and command rate-limit buckets, and the audit log remain upstream of Step 3 and MUST NOT be bypassed or weakened.
- Edits remain throttled to one `editMessageText` per step window; the existing `StreamingSessionGateway` and `TelegramSessionStream` coalescing logic continues to govern edit frequency, and `resetForSubmission` / `showSubmissionError` are the only existing stream-side escape hatches for non-streaming text edits.
- The approval card text and inline keyboard are produced exclusively by `formatApprovalRequest` and the existing `pushApproval` path. Step 3 MUST NOT introduce a parallel approval UI or a second card renderer.

## Ordered steps

- [x] Step 1: streaming session gateway.
- [x] Step 2: prompt submission and live reply routing.
- [ ] Step 3: connect `requires-approval` to the Round C approval card; pause/resume the stream around the decision; render a denied footer on denial or timeout while leaving the session selected.

## Step 3 — Approval integration for prompts

Connect the existing `PromptSubmissionResult.status === "requires-approval"` branch in `handlePrompt` to the Round C approval registry. Pause the bound Telegram stream for the duration of the decision, then resume it (submit the prompt on approval, render a denied footer on denial or timeout, render a cancellation footer on `/cancel`).

### Expected source ownership (≤ 5 production files)

- `src/remote-control/bridge.ts` (extension only):
  - In `handlePrompt`, when `result.status === "requires-approval"`, route to a new private method `await this.handlePromptApproval(message, sessionId, stream, result.approval, text)` instead of the current `showSubmissionError` fallback.
  - `handlePromptApproval` MUST call `this.pushApproval({ id: result.approval.id, kind: result.approval.kind, title: result.approval.title, body: result.approval.body, onResolve })` exactly once. The `onResolve` callback MUST distinguish three outcomes:
    - `approved && source === "telegram"` or `"desktop"`: resume submission by invoking the existing `submitPrompt` seam with the original `text` and route the result through the same `submitted` / `requires-approval` / `failed` branches already used in `handlePrompt`. If a second `requires-approval` is returned, fall through to a one-line "another approval required" footer without consuming another rate-limit slot and without resubmitting.
    - `!approved` (deny from Telegram, deny from desktop, or timeout): call `stream.resumeAfterDecision("denied" | "timeout", reason)` and audit `prompt` with `outcome: "denied"` or `"timeout"`.
  - `handlePromptApproval` MUST also call `this.resolveApproval(id, approved, source)` so the existing Round C bookkeeping (`pendingApprovals` deletion, `approval-resolved` audit, message edit) runs. The Telegram callback path already calls `resolveApproval` before `onResolve`; the desktop / timeout paths MUST call it inside `handlePromptApproval` so the bookkeeping stays in one place.
  - On `pushApproval` returning `false` (remote control not enabled, token missing, not paired, or no `editMessage` support), render the existing `showSubmissionError("Approval routing is unavailable.")`, leave the session selected, and audit `prompt` with `outcome: "approval-unavailable"`.
  - The post-approval submission MUST reuse the existing `submitPrompt` seam; it MUST NOT consume a second prompt-rate-limit slot. The original `requires-approval` request already consumed the bucket in `handleMessage`, and `consumeRateLimit` is the only entry point for that bucket. `handlePromptApproval` therefore does not call `consumeRateLimit`.
  - The `/cancel` command (`handleCancel`) MUST check `pendingApprovals` for an approval whose `chatId` matches and whose `onResolve` would resume the same bound stream, call `request.onResolve(false, "timeout")` semantics (i.e. resolve with `false` and source `"timeout"` so the audit and message edit match), and then call `stream.cancelForApproval()` so the live binding is removed.
- `src/remote-control/telegram-session-stream.ts` (extension only):
  - Add `pauseForApproval(cardText: string)`: snapshots the current `lastSnapshot`, replaces `pendingText` with the approval card text so the next `editMessageText` paints the Round C card in place, and ignores further streaming deltas until `resumeAfterDecision` or `cancelForApproval` is called. It MUST NOT stop the underlying `StreamingSessionGateway` subscription (the round-trip answer still needs to land in the live message once approval lands).
  - Add `resumeAfterDecision(decision: "approved" | "denied" | "timeout", reason?: string)`: clears the approval-paused state. On `"approved"`, calls the existing `resetForSubmission` so the next prompt-submit edit paints `"Submitting prompt..."` again. On `"denied"` or `"timeout"`, calls a new private `showDecisionFooter(decision, reason)` that appends a single-line denied or timeout footer beneath the last snapshot without re-rendering the full stream or re-coalescing prior text.
  - Add `cancelForApproval()`: removes the live binding exactly like the existing `stop()` path, but records an audit-friendly reason so `/cancel` while awaiting approval is distinguishable from a normal stream end.
  - The existing `cancellationSummary`, `resetForSubmission`, and `showSubmissionError` paths remain untouched; they continue to cover non-approval cases.
- `src/remote-control/prompt-submission.ts` (extension only if the existing types are insufficient):
  - The existing `PromptApprovalPayload` already carries `id`, `kind`, `title`, and `body`, and `SessionPromptSubmissionResult` already exposes `status: "requires-approval"`. No new exported type is required unless the post-approval resubmission needs a distinct seam; in that case add a single optional `resubmit?: SessionPromptSubmission` field to `RemoteBridgeDeps` rather than introducing a parallel prompt type.
- `src/remote-control/approval-routing.ts` (new, optional):
  - ONLY created if `bridge.ts` would otherwise grow an untestable inline closure. If created, it exports a pure `routePromptApproval({ approval, onApprove, onDeny, onTimeout })` helper that returns the `RemoteApprovalRequest` and a cancel function, keeping `bridge.ts` thin and the approval branch independently testable. If the inline closure in `bridge.ts` remains small and is directly testable through the bridge tests, this file is omitted.
- `tests/remote-control-bridge-prompt.test.ts` (extension): add focused integration tests for the approval flow against the existing stub `PromptTransport`.
- `tests/remote-control-telegram-session-stream.test.ts` (extension): add cases for `pauseForApproval` / `resumeAfterDecision` / `cancelForApproval`, proving the snapshot template swaps and the prior text is preserved verbatim in the footer.
- `tests/remote-control.test.ts` (extension): add cases proving Step 3 reuses the existing approval routing (callback, desktop-first, timeout) without modifying it, and that `pendingApprovals` bookkeeping remains consistent after a `/cancel` race.
- This plan file, only to check Step 3 complete.

### Required behavior and simulations

1. **Approval**: A `/prompt` whose `submitPrompt` returns `requires-approval` triggers exactly one `pushApproval`; the bound stream edits to the approval card text; a Telegram `approve` callback resumes the stream via `resetForSubmission`, the same prompt is submitted, and the eventual leader answer renders exactly as in the accepted W0022 path. The audit log records `approval-push`, `approval-resolved` with `source: "telegram"`, and `prompt` with `outcome: "approved"`.
2. **Denial**: A Telegram `deny` callback (or a desktop `resolveApproval(..., false, "desktop")` while the stream is paused) renders a single-line denied footer in the next edit, leaves the session selected, and emits no further edits. The audit log records `approval-resolved` with `source: "telegram"` or `"desktop"` and `prompt` with `outcome: "denied"`.
3. **Timeout**: Advancing fake timers past `REMOTE_APPROVAL_TTL_MS` (5 minutes) default-denies, renders a timeout footer ("Timed out after 5 minutes: denied by default."), leaves the session selected, and emits no further edits. The audit log records `approval-timeout` and `prompt` with `outcome: "timeout"`.
4. **Cancel**: `/cancel` while a prompt is waiting for approval calls `cancelForApproval`, removes the pending approval from `pendingApprovals`, posts a one-line cancellation summary, and leaves the session selected. The audit log records `cancel` with `outcome: "approval-cancelled"` and `approval-resolved` with `source: "timeout"`.
5. **Duplicate decision**: A second Telegram `approve`/`deny` callback after the request is resolved is ignored, the audit log records `approval-callback` with `outcome: "stale"`, and the stream is not edited again.
6. **Unchanged session**: Denial, timeout, and cancel leave `selectedSessionsByChat` populated; only an explicit `/use <other>` or `/revoke` clears it. `handleSessions` and `handleUse` continue to overwrite the binding exactly as today.
7. **Authorization**: An approval callback from a non-paired sender is rejected by the existing sender check; the audit log records `rejected-sender` and the stream remains paused. The approval timeout still fires. A non-paired sender's plain text prompt is still rejected upstream.
8. **Rate limit**: The original `requires-approval` request consumes exactly one slot in the prompt-rate-limit bucket via the existing `consumeRateLimit` call in `handleMessage`. The post-approval resubmission does NOT consume a second slot. A subsequent `/prompt` from the same chat still respects the existing 10-per-minute cap.
9. **Audit**: `approval-push`, `approval-resolved` (with `source` matching the decision channel), `approval-timeout` (if timeout), `approval-callback` (with `outcome`), and `prompt` (with `outcome: "approved" | "denied" | "timeout" | "cancelled" | "approval-unavailable"`) are appended to the audit log.
10. **Baseline regression**: All W0016 Step 1 / Step 2, W0021, and W0022 tests continue to pass unchanged. No edit in this step touches `submitRemotePrompt`, the prompt validation rules, the command or prompt rate-limit buckets, the `runOrchestration` answer path, the run-health heartbeat, or the tap-to-use selection UX.

### Independent verification

- `npm test -- tests/remote-control-bridge-prompt.test.ts tests/remote-control-telegram-session-stream.test.ts tests/remote-control.test.ts`
- `npm run typecheck`
- `git diff --check`
- `authoritative-only: npm test`

The candidate checks only Step 3 complete in this plan. Completion of Step 3 completes W0016's Round D approval integration and W0023.

## Safety and scope

- Step 3 touches only `src/remote-control/bridge.ts`, `src/remote-control/telegram-session-stream.ts`, optionally `src/remote-control/prompt-submission.ts` (one optional field) or the new `src/remote-control/approval-routing.ts`, and the listed test files. No agent, orchestrator, compaction, provider, model registry, credential, pairing, session-store, JSONL, IPC, preload, or renderer change is in scope.
- Pairing, allowlist, rate limits, and Round C approval routing are inherited, not modified. The new code only connects `requires-approval` results to the existing registry; it does not redefine approval semantics.
- No new dependency, no protocol change, no branch topology change, no reciprocal script change. The runtime promotion gate and master integration remain human-only.
- The full suite remains `authoritative-only: npm test`; the focused command above is the in-sandbox evidence for Step 3. The passive gate repeats the full suite before trust advances.
- This plan is plan-gated. The human authority boundary above MUST be explicitly approved before the Step 3 implementation candidate begins. The relay's `autonomousContinuation` is not used for this epic; an ordinary A `Start` is required after the plan candidate is independently accepted.
