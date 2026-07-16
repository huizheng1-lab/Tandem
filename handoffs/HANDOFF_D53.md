# Handoff D53 (fix desktop /goal clear count bug; fix the handoff-monitor script)

Two unrelated fixes bundled since both are small.

## D53-1: Desktop `/goal clear` reports the wrong count (real bug, confirmed live)

Live-tested in the rebuilt app: added 4 goals, ran `/goal clear`, the sidebar Goals panel
correctly emptied (the actual deletion works), but the confirmation said "Cleared 0 goal(s)."
instead of "Cleared 4 goal(s)."

Root cause, traced end to end:
- `src/session/goals.ts:56-62`'s `clearGoals(cwd)` is correct — it captures the count BEFORE
  deleting and returns it.
- `app/main/tandem-service.ts:356-359`'s `TandemService.clearGoals()` calls the backend
  `clearGoals(this.projectDir)` correctly but **discards its return value** and returns
  `this.listGoals()` instead — the list of goals REMAINING after the clear, which is always `[]`.
- `app/shared/ipc.ts:235` declares `clearGoals(): Promise<Goal[]>`, matching that wrong shape.
- `app/renderer/src/main.tsx:726-730` does `const removed = await tandem.clearGoals(); ...
  \`Cleared ${removed.length} goal(s).\`` — since `removed` is always `[]`, `.length` is always `0`,
  regardless of how many goals actually existed.

Note the CLI TUI's path (`src/commands/goal.ts:33-35`) does NOT have this bug — it calls the
backend `clearGoals(cwd)` directly and returns the real count. This is a desktop-only defect in
the IPC plumbing layer.

Fix: change the desktop IPC contract to return the actual count, not the (always-empty) post-clear
list — the renderer isn't even using the returned list for anything (it already does `setGoals([])`
unconditionally right after), so there's no reason to return `Goal[]` here at all.
- `app/shared/ipc.ts`: `clearGoals(): Promise<number>`.
- `app/main/tandem-service.ts`: `async clearGoals() { return clearGoals(this.projectDir); }`
  (return the backend function's count directly, matching what `src/commands/goal.ts` already
  does correctly).
- `app/renderer/src/main.tsx`: drop `.length` — `removed` is now already the number:
  `` `Cleared ${removed} goal(s).` ``.
- `app/main/index.ts`'s handler just forwards the value, shouldn't need changes, but check it.

## D53-2: Fix `scripts/handoff-monitor.ps1` so it actually detects new-style handoffs

Per the user: this script (and its companion `register-handoff-monitor.ps1`, which registered a
real, currently-active Windows Scheduled Task named `TandemHandoffMonitor`, polling every 10
minutes) should stay, but needs to actually work — the user wants it kept for its intended purpose
(spotting new unhandled handoff files) and fixed if anything about it doesn't serve that purpose.

Two real bugs found on inspection:
1. `Get-ChildItem -Path $workspace -Filter "HANDOFF_GPT5_D*.md"` only matches the OLD handoff
   naming convention. Handoffs from D51 onward are named `HANDOFF_D<n>.md` (no `GPT5` segment,
   per an explicit renaming — see `process/LEADER_WORKER_WORKFLOW.md` for why). As written, this
   script will never see any handoff numbered D51 or higher, ever. Fix the filter to match both
   `HANDOFF_D*.md` and (for backward compatibility with any old files still present)
   `HANDOFF_GPT5_D*.md`, and update the two places that parse the base name back into a round
   number (`^HANDOFF_GPT5_D(\d+)$`) to also accept `^HANDOFF_D(\d+)$`.
2. Line ~25's regex `'^D(\d+)-d+[: ]'` has an unescaped `d+` where it almost certainly meant
   `\d+` (a literal digit, escaped). As written this only matches a commit message with the
   literal letter "d" repeated, which real commit messages like `D51-1: add /loop...` never
   produce — so this git-log-based "handled" fallback path is currently dead. Fix the escape.

Also do a final read-through of both `.ps1` files for anything else that doesn't serve the stated
purpose ("identify new handoff files") and fix it — the user's instruction was general, not just
these two specific bugs, so use judgment if you spot something else while you're in there, and
say what you changed and why in the completion report.

## Acceptance
tsc + `npm test` green for D53-1. For D53-1, live-verify: add 3+ goals, run `/goal clear`, confirm
the count in the message matches how many were actually there (not 0) — rebuild the packaged app
and check via the real running app, not just a unit test, since this bug only showed up in the
live IPC round-trip, not in any existing test. For D53-2, verify by temporarily creating a fake
`HANDOFF_D999.md` (no matching `D999_done.txt`) and confirming a manual run of
`scripts/handoff-monitor.ps1` reports it as unhandled and exits 1; then delete the fake file
before finishing. Commit `D53-<n>:`, create `D53_done.txt`.
