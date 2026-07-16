# Handoff D52 (make /goal <text> start work immediately, matching the user's Claude Code workflow)

## Context
Today, `/goal add <text>` only records a standing goal (`src/session/goals.ts` via
`src/commands/goal.ts`'s `handleGoal`, mirrored inline in `app/renderer/src/main.tsx`'s `/goal`
branch) — it never triggers execution. The user expects `/goal <text>` (no `add` keyword) to work
the way it does for them in Claude Code: typing it starts real work on `<text>` immediately, and
that work continues until the goal is achieved. Currently in Tandem, `/goal <anything that isn't
add/done>` silently falls through to the goal-LIST branch and does nothing with the text — this is
the literal bug the user hit (`/goal count from 1 to 100` printed "No goals yet" instead of doing
anything).

"Continues until achieved" doesn't need a new mechanism — Tandem's existing plan→build→review
pipeline already revises up to `maxReviewRounds` and escalates to leader takeover on repeated
failure; a normal request already runs to a real conclusion (approved, or takeover completes it).
The only actual gap is that `/goal <text>` today never enters that pipeline at all.

## D52-1: New composer behavior — `/goal <text>` adds AND runs

Keep every existing form working exactly as today (do not remove or change their output):
- `/goal` (no args) → list, unchanged.
- `/goal add <text>` → adds only, does NOT run. Keep this — it's the "just note this for later"
  form, and the desktop app's sidebar goal-add input+button likely calls the add path directly via
  IPC (check `app/renderer/src/main.tsx`), not through composer parsing — don't touch that.
- `/goal done <n>` → marks complete, unchanged.
- `/goal list` (exactly one arg, `list`) → same as bare `/goal`, unchanged (make this explicit if
  it isn't already, since today it's only reached by falling through the add/done checks — no
  behavior change, just making the intent explicit).

New (both of these are new, not present today):
- `/goal clear` (exactly one arg, `clear`) → deletes ALL goals (both active and done — a full
  reset, distinct from `/goal done <n>` which marks one goal complete but keeps it listed). Add a
  `clearGoals(cwd)` function to `src/session/goals.ts` (mirror `saveGoals`'s file-write pattern,
  just write `[]`) and wire it into both surfaces the same way `add`/`done` are wired. Confirm with
  a message like `Cleared N goal(s).` (0 is fine, don't error on an already-empty list). Apply the
  same one-word-exact-match disambiguation as `list`: `/goal clear the temp build directory` (more
  words after "clear") must be free-form goal text that runs immediately, not the clear subcommand
  — a task that happens to start with the word "clear" must not be swallowed silently.
- `/goal <text>` where `<text>` is anything else (i.e. the first token is not `add`, `done`, or a
  lone `list`) → (a) add it as a standing goal via the same call `/goal add` already makes, THEN
  (b) immediately execute `<text>` as a real request through the exact same path a normal
  composer message uses (the same call `send()` makes in the desktop app, the same path a plain
  typed message takes in the CLI TUI after falling through the command chain) — do not build a
  parallel/simplified execution path, reuse the real one so it gets the full pipeline (planning,
  worker build, review/revise loop, cost tracking, activity events) exactly like typing the text
  directly with no `/goal` prefix would.
- Disambiguation for the `list` collision: only treat args as the `list` subcommand when
  `args.length === 1 && args[0] === "list"`. Anything with more words after "list" (e.g. `/goal
  list the pending TODOs in this repo`) is free-form goal text, not the list subcommand — a user
  describing a task that happens to start with the word "list" should still get real work, not a
  goal listing.

## D52-2: Implement in both surfaces
- **CLI TUI** (`src/tui/App.tsx`): the command chain currently checks `/model`, then
  `handleLoop`, then `handleSchedule`, then `/resume`, then falls to `dispatchCommand` (which
  handles `/goal` via `src/commands/goal.ts`'s `handleGoal`), and only runs the input as a normal
  prompt if nothing matched (around line 385-435). Add a check before the `dispatchCommand` call:
  if the input is `/goal <text>` per the new rule above, add the goal (reuse `addGoal` from
  `src/session/goals.ts`, the same function `handleGoal`'s `add` branch calls) and then fall
  through into the SAME code path that runs a normal prompt (don't call `dispatchCommand` for
  this case at all, and don't invent a second run-trigger — reuse whatever function actually kicks
  off `runPipeline`/the leader for a plain typed message).
- **Desktop app** (`app/renderer/src/main.tsx`): the existing inline `/goal` branch in
  `handleComposerCommand` (~line 690) already has `sub`/`add`/`done` logic. Add the new branch
  there, calling `tandem.addGoal({text})` (same as the `add` branch does) followed by the same
  execution path `send()` uses for a normal prompt (respect `needsProjectPick` the same way `send()`
  and the D51 `/loop` `runSequential` helper already do — don't let this bypass that guard).

## D52-3: Update help text
Add `/goal <text>` (start working on it now) and `/goal clear` to both `composerHelpText()`
(`app/renderer/src/main.tsx`) and the CLI TUI's help text (`src/commands/misc.ts`), next to the
existing `/goal add <text>` / `/goal list` / `/goal done <n>` lines, worded so it's clear the bare
`<text>` form both records the goal and starts work immediately (distinct from `/goal add`, which
only records), and that `clear` deletes everything (distinct from `done`, which keeps history).

## Acceptance
tsc + `npm test` green. Then rebuild the packaged app (`npm run dist:app`) and live-verify via CDP
against the real running app (same bar as D51), plus verify the CLI TUI directly:
- `/goal write a haiku about autumn` immediately starts a real run (visible leader
  planning/triage activity, not just a "No goals yet" or "Added goal" message with nothing else
  happening), and the goal also shows up in `/goal list` afterward.
- `/goal add <text>` still only adds, does not run (regression check — this form must stay
  inert).
- `/goal list` and bare `/goal` still just list, unchanged.
- `/goal list the pending TODOs in this repo` (word "list" followed by more text) triggers a real
  run, not the list subcommand — confirms the disambiguation rule.
- `/goal done <n>` still works unchanged.
- `/goal clear` with 2+ existing goals removes all of them, `/goal list` afterward shows "No goals
  yet." Running it again on an empty list doesn't error, just reports 0 cleared.
- `/goal clear the temp build directory` (word "clear" followed by more text) triggers a real run,
  not the clear subcommand — confirms the disambiguation rule for both new keywords.
- Desktop sidebar's dedicated goal-add input/button still works exactly as before (regression
  check that it wasn't accidentally routed through the new run-triggering path).
