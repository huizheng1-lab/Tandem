# Tandem Reciprocal Control Panel

Local human oversight for the two-copy reciprocal improvement process.

## Start

From the dashboard directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start-dashboard.ps1
```

The launcher opens `http://127.0.0.1:4782`. It reuses an existing panel server on that port and registers one Windows Scheduled Task per port, named `TandemReciprocalDashboardWatchdog-<port>`. The task starts at logon and repeats every five minutes with "ignore new instance" semantics, so a killed watchdog/server pair is revived by the next task tick. The task runs the existing watchdog, which still restarts a missing listener after a two-second backoff. The dashboard Quit button writes an intentional-stop signal so both the watchdog and future scheduled-task ticks exit without restarting the panel. Pass `-NoBrowser` to start it without opening a browser, or `-Port <number>` to select another local port.

To refresh only the scheduled-task registration:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File register-dashboard-watchdog-task.ps1
```

Server lifecycle messages, uncaught errors, rejected promises, and redirected stdout/stderr append to `C:\Users\huizh\Apps\Tandem Reciprocal\control\dashboard-server.log`. The current log rotates to `.1` at 2 MB.

On Windows, you can double-click `Launch Reciprocal Control Panel.bat` in this directory. The same file accepts PowerShell parameters, for example `Launch Reciprocal Control Panel.bat -Port 4783`.

## Control Boundary

- Status refreshes every 15 seconds from relay state, both worktrees, pinned runtimes, the shared direction board, checkpoints, and Git history.
- Wishlist additions use the existing mutex-protected `reciprocal-direction.ps1` helper.
- General Direction edits use that same mutex and preserve the guardrails, wishlist, and human notes sections.
- Model controls mirror Tandem's leader/worker picker, including media badges, unavailable-provider labels, Claude CLI variants, and Codex reasoning variants. Updates to each stopped executor's isolated config are atomic and never expose credential values.
- Start and stop actions affect only the selected pinned Tandem runtime. Stopping preserves relay state, checkpoints, refs, and stashes.
- Pause and resume actions affect only relay turn-claiming. They do not stop executor apps, clean worktrees, regenerate tokens, or move refs.
- Kickstart is token-gated and audited. It starts and waits for Executor A only during normal idle work; Executor B being dormant is the healthy topology until the relay reaches the verified recovery-authority phase. Because the current Tandem desktop app exposes no safe local IPC/CLI trigger for an immediate prompt, the panel provides the exact first-turn prompt for Executor A as a copy-paste fallback instead of synthesizing fragile UI keystrokes.
- Recovery is an instruction generator. It does not reset branches or execute rollback commits from the browser.
- Mutation requests require an in-memory control token and the server listens only on `127.0.0.1`.
- Human panel actions and rejected mutations are recorded in `C:\Users\huizh\Apps\Tandem Reciprocal\control\CONTROL_PANEL_AUDIT.jsonl`.
- Rejecting a candidate turns the required review comment into a deduplicated P0 wishlist item, releases a matching `a-upgrade-pending` gate without promoting the rejected runtime, and leaves the relay idle for Kickstart or Executor A's next `7,37 * * * *` scheduled run.

## Sources Of Truth

- Direction and wishlist: `C:\Users\huizh\Apps\Tandem Reciprocal\control\SHARED_DIRECTION.md`
- Relay state: `C:\Users\huizh\Apps\HZ code\.git\tandem-relay\state.json`
- Stable version: `refs/tandem-relay/stable`
- Worktrees: `C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a` and `copy-b`
