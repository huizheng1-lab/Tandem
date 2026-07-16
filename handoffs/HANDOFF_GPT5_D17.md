# Handoff to GPT-5 — Round D17 (plan approval must respect permission mode)

User report + reviewer-confirmed: the desktop app asks for plan approval on EVERY run.
`TandemService.confirmPlan` (app/main/tandem-service.ts ~line 357) unconditionally sends the
plan-confirm modal. The TUI gates plan confirmation on `permissionMode !== "ask"` (auto-approve);
the desktop service never got that gate. Spec reference: BUILD_PLAN.md §5.1 — plan confirmation
is an "ask"-mode behavior.

## D17-1: Gate plan confirmation on permission mode
In `TandemService.confirmPlan` (or at the call site in `run()`): if
`this.config.permissionMode !== "ask"` and session auto-approve is not "none"— resolve `true`
immediately WITHOUT sending the modal. Exact rule: modal only when `permissionMode === "ask"`
and session-scoped auto-approve-all is not active. The BuildPlan card must still appear in the
transcript (informational, collapsed) in all modes — users should see what was planned, just not
be blocked by it.

Also update the D8 "Allow everything this session" escalation: when active, plan confirmations
are auto-approved too.

Unit test (service with fake orchestrator): permissionMode "yolo" → confirmPlan resolves true
with no planConfirm IPC sent; "ask" → IPC sent and resolution follows the user's response.

## Acceptance
tsc + `npm test` green; commit `D17-1:`. Reviewer will CDP-drive: set Permissions to Auto, send
a prompt, and expect the full pipeline to run to DONE with zero modal interactions; set back to
Ask and expect the plan modal to appear.
