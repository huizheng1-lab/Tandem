# Handoff D191 (D190's live schedule edit corrupted schedules.json shape — Executor A's cron is silently dead, and schedule-load failures are invisible)

## Live incident (root cause confirmed at code level — don't re-derive)

Executor A has missed every scheduled tick since 16:37Z (12:37 local). The app is
healthy (automation /status returns ok, instance A, idle), but
`worktrees\copy-b\.tandem\schedules.json` — rewritten during D190's live executor
template/prompt update — is now a **bare JSON object** instead of the required
**array of schedules**:

- Before D190: `[ { "id": "relay-a", ... } ]`
- After D190's edit: `{ "id": "relay-a", ... }` (classic PowerShell
  `ConvertTo-Json` single-element-array unwrapping)

`src/commands/schedule.ts:11` defines `SchedulesSchema = z.array(ScheduleSchema)`
and `listSchedules` does `SchedulesSchema.parse(...)` — a bare object throws, so
the scheduler sees no schedules and **fails silently**: no error surfaced anywhere,
ticks at 17:07Z and 17:37Z simply didn't fire, and W0027 step 3/3 (ready, plan
approved, autonomy=full) is not being claimed.

Note the prompt content change D190 made (admin relay script path in the prompt)
is correct and wanted — only the container shape broke.

## Fix — all three parts

1. **Repair the live file**: restore `copy-b\.tandem\schedules.json` to an array
   wrapping the existing (correct, D190-updated) schedule entry. Preserve the
   entry's content including `lastRunAt`. Verify the same corruption did not hit
   `copy-a\.tandem\schedules.json` (relay-b entry) or any other `.tandem`
   schedules file, and repair those too if so.
2. **Fix the writer**: whatever wrote the file (D190's live-update step, and any
   script/helper that edits schedules from PowerShell) must always serialize an
   array — in PowerShell, wrap with `ConvertTo-Json -InputObject @(...)` or
   equivalent so single-element arrays stay arrays. If schedule edits are expected
   to recur (executor prompt updates are now a protocol-level concern per D190),
   provide one shared, tested helper for editing schedules files rather than ad-hoc
   JSON rewriting.
3. **Make schedule-load failures loud**: `listSchedules`/the scheduler startup must
   surface a malformed schedules.json (log + visible app state + ideally the
   automation /status payload), not silently run zero schedules. A dead scheduler
   is an availability outage for the whole autonomous loop and must be observable.
   Add a regression: malformed schedules.json (bare object, invalid entry) →
   loud, identifiable failure; valid array → schedules run.

## Live proof required

After repair: show the next cron tick actually firing (lastRunAt advancing past
17:37Z) and Executor A claiming W0027 step 3/3 (or whatever the relay correctly
hands it). Show the loud-failure path once with a deliberately malformed copy in a
fixture (not the live file).

## Constraints

- Do not change schedule semantics/cadence or the D190-corrected prompt content.
- Do not touch relay state, W0027's board entry, or runtimes beyond what the
  normal claimed work does.
- App-side changes (schedule.ts) ship as a normal candidate through the gate;
  the live schedules.json repair itself is an operational fix that may be done
  directly, documented in the done notes.

## Acceptance

`handoffs/D191_done.txt`: the repaired file content (array shape), the writer fix,
the loud-failure change, regression names, and the live tick/claim proof with
timestamps. tsc + `npm test` green. Commit `D191-<n>:`. Create
`handoffs/D191_done.txt`.
