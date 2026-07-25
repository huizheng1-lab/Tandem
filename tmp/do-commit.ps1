$ErrorActionPreference = "Stop"
Set-Location "C:\Users\huizh\Apps\HZ code"
git add src/remote-control/bridge.ts
git add src/remote-control/telegram-session-stream.ts
git add tests/remote-control-bridge-prompt.test.ts
git add tests/remote-control-telegram-session-stream.test.ts
$msg = @'
D200-6: integrate Telegram prompt approvals with Round C card

Wire requires-approval prompt submissions through pushApproval so the
existing Round C plan/permission card handles Telegram approvals. Pause
the live session stream while the card is up, resume with a submitting
header on approval (retrying submitRemotePrompt with the same text), or
paint a denied/timeout footer on rejection so the selected session stays
usable. /cancel now withdraws an in-flight approval and marks the pending
Telegram callback stale. Adds bridge integration tests for the approve /
deny / timeout / cancel paths and stream-level tests for pause, resume,
denial footer, and cancel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
git commit -m $msg
git rev-parse HEAD
