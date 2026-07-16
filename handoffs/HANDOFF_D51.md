# Handoff D51 (add /loop and typed /schedule to the desktop app's composer)

On completion, create `D51_done.txt` in the workspace root (same convention as every prior round)
summarizing what changed and the live-verification results below.

The CLI TUI (`src/tui/App.tsx`) supports `/loop <interval> <prompt>` and `/schedule "<cron>"
<prompt>` as typed commands. The desktop app (`app/renderer/src/main.tsx`) does not — its
`handleComposerCommand` only recognizes `/help`, `/models`, `/model`, `/rounds`, `/status`,
`/cost`, `/goal` (line ~630-704), falling through to `"Unknown command - try /help"` for anything
else, including `/loop`. `/schedule` already works in the desktop app, but only via the sidebar
form (cron + prompt inputs, "Schedules" list) — not as something typed in the composer. User
tried `/loop` in the desktop app expecting parity with the CLI TUI and got "Unknown command."

## 51-1: Add `/loop <interval> <prompt>` and `/loop stop` to the composer

Reuse `src/commands/loop.ts` (`parseLoop`, `parseInterval`) verbatim — it's already
frontend-agnostic (pure parsing, no I/O), already imported by the CLI TUI, so no changes needed
there.

In `app/renderer/src/main.tsx`:
- Add a `loopTimerRef`/`loopRunningRef` pair (React `useRef`), mirroring
  `src/tui/App.tsx:53-54` (`loopTimerRef = useRef<NodeJS.Timeout>()`, `loopRunningRef =
  useRef(false)`).
- Add a `runSequential(prompt, source)` helper mirroring `src/tui/App.tsx:299-313`: if
  `loopRunningRef.current` is true, append a system message saying the tick was skipped because a
  previous run is still active, and return; otherwise set the ref, call the same prompt-execution
  path `send()` already uses (`tandem.runPipeline({ prompt, attachments: [] })`, with the same
  `appendMessage`/`setRunning`/`setPhase` bookkeeping `send()` does around it — don't duplicate
  that state handling ad hoc, factor it out of `send()` into a shared `runPrompt(text)` function if
  that's cleaner, and have both `send()` and the new loop path call it), then clear the ref in a
  `finally`.
- In `handleComposerCommand`, add a `/loop` branch before the final `"Unknown command"` fallback:
  parse `args` the same way `/goal` does (`splitCommand` already splits the input; loop's own
  quoted-arg handling isn't needed here since intervals/prompts don't need quoting the way cron
  expressions do), call `parseLoop(args)`, handle the `"stop"` case (clear the interval, clear the
  ref, confirm via `appendMessage("system", "Loop stopped.")`), otherwise set the interval via
  `setInterval(() => void runSequential(spec.prompt, "loop"), spec.intervalMs)` and immediately
  call `runSequential(spec.prompt, "loop")` once, matching the CLI TUI's immediate-then-repeat
  behavior exactly. Wrap `parseLoop`'s thrown usage error in the existing try/catch pattern the
  other branches use (it already reports via `Command failed: ...` — check if that's an acceptable
  UX for a bad `/loop` invocation or if it should show the plain `Usage: /loop <30s|5m|2h> <prompt>`
  string instead, matching the CLI TUI's usage-message style used by other branches like `/model`).
- Clear the interval on unmount / when a new project/session is picked (check what the CLI TUI
  does with `loopTimerRef.current && clearInterval(...)` around `App.tsx:133` — that's an
  analogous cleanup-on-teardown case; the desktop app needs the equivalent so a loop from a
  previous project doesn't keep firing into a newly picked one).

## 51-2: Add a typed `/schedule "<cron>" <prompt>` alias to the composer

The desktop app already has full schedule CRUD via IPC (`tandem.listSchedules` /
`tandem.addSchedule` / `tandem.removeSchedule`, already used by the sidebar form). Add a
`/schedule` branch to `handleComposerCommand` that's a thin typed wrapper over the same calls the
sidebar form already makes — don't add new backend logic. Support the same three forms the CLI TUI
does: `/schedule "<cron>" <prompt>` (add), `/schedule list`, `/schedule rm <id>` — parse quoted
args the same way `src/tui/App.tsx:332` does
(`value.match(/"[^"]*"|\S+/g)?.slice(1).map(...)`), and keep the sidebar form working unchanged
(it should stay in sync with schedules added via the typed command, since both go through the
same `tandem.addSchedule`/`setSchedules` state).

## 51-3: Update the help text and docs

Add `/loop <interval> <prompt>`, `/loop stop`, `/schedule "<cron>" <prompt>`, `/schedule list`,
`/schedule rm <id>` to `composerHelpText()` (`app/renderer/src/main.tsx:100-114`), matching the
existing terse one-line-per-form style.

## Acceptance
tsc + `npm test` green. Then rebuild the packaged app (`npm run dist:app`) and live-verify in the
actual running desktop app (not just unit tests) — reviewer will check via CDP against the
rebuilt app, same as prior desktop-facing rounds:
- `/loop 30s <prompt>` fires the prompt immediately, then again every 30s, until `/loop stop`.
- A loop tick that lands while a run is still in progress is skipped with a visible system
  message, not silently dropped or queued.
- `/schedule "*/5 * * * *" <prompt>` adds a schedule that also appears in the sidebar Schedules
  list; `/schedule list` and `/schedule rm <id>` work from the composer too.
- `/help` output includes the new commands.
- Switching projects (or closing the app) stops any active loop — it doesn't keep firing against
  the wrong project directory.
