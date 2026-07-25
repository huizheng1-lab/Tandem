# Handoff D134 (reciprocal executor step budget stuck at the pre-D102 default of 60)

Live incident: W0013 Step 1's turn has resumed 3 times (hitting the D133 circuit
breaker's threshold) without producing a candidate. The session's own honest deviation
report explains why: `"Turn ended before implementation, verification, and relay
handoff could complete because the model exhausted output budget while reading
tandem-service.ts and the IPC and preload files; only the tracker module is in place
from the prior resume."`

## Root cause (verified directly - don't re-derive)

Both executors' configs still have `maxStepsPerAgentTurn: 60`:
`C:\Users\huizh\Apps\Tandem Reciprocal\state\executor-a\config.json` and
`...\executor-b\config.json`. This is the ORIGINAL pre-D102 shipped default. D102
(earlier this project) raised `defaultConfig.maxStepsPerAgentTurn` to 150 precisely
because 60 was proven too low for real multi-file work (that round's own evidence:
worker turns needing 74-236 steps on a real project). D103 then added auto-escalation
on genuine step exhaustion. Neither improvement reached the reciprocal executors: their
configs were generated once (D116 setup) from whatever `defaultConfig` was at the time
and are never regenerated on rerun (`setup-reciprocal-tandem.ps1` preserves existing
config - confirmed no `maxStepsPerAgentTurn` write in that script at all). W0011/W0012's
trivial one-line proofs never came close to 60 steps, so this was invisible until the
first genuinely substantive epic step (W0013's real tracker + renderer/IPC work).

## D134-1: raise the reciprocal executors' step budget

Update BOTH `C:\Users\huizh\Apps\Tandem Reciprocal\state\executor-a\config.json` and
`...\executor-b\config.json`: set `maxStepsPerAgentTurn` to at least 150 (matching the
current shipped default; consider higher, e.g. 200-250, given reciprocal turns do a full
plan-or-implement cycle including verification and relay handoff within one budget -
use your judgment, document why). Executors must be stopped before editing (same
safety rule as `promote-reciprocal-runtime.ps1` - verify no Tandem.exe running from
either runtime dir before writing, then confirm the app picks up the new value on next
start, e.g. via `/model` or a status check reflecting it).

## D134-2: fix the setup script so this can't silently recur

`scripts/setup-reciprocal-tandem.ps1` should explicitly set `maxStepsPerAgentTurn` to a
sane value (150+) when GENERATING a fresh config, rather than silently inheriting
whatever `defaultConfig` happens to be at generation time with no override - so a future
re-provision (or a fresh reciprocal setup on another machine) doesn't quietly repeat
this exact bug. Since the script already preserves an EXISTING config on rerun (correct,
don't change that), this only affects first-time generation.

## D134-3: recover the stuck W0013 turn

After the fix: the relay is currently sitting with `resumeCount` at or near the D133
circuit-breaker threshold (verify current value - it may have already auto-paused). If
paused, that's correct behavior, not a bug - just resume once the budget fix is live so
the next attempt has real headroom. The partial work already in place ("only the
tracker module") should be reused, not discarded, if it's sound - review it against the
plan before continuing.

## Acceptance

Both configs show the raised value (paste the new JSON). Setup script diff shown.
Live evidence: after restarting both executors with the new budget, resume the relay
and let W0013 Step 1 actually complete this time (a real candidate commit + peer
validation) - paste the relay state transitions showing it. If it still doesn't
complete even with the larger budget, report that honestly with the new deviation
detail rather than just re-raising the number again. tsc + `npm test` green in the
admin repo (sanity - this round is mostly external config/script, minimal src changes
expected). Commit `D134-<n>:` for the setup-script change; describe the executor
config edits in the marker (they're outside the repo). Create `handoffs/D134_done.txt`.
