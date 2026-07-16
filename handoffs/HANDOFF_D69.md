# Handoff D69 (let Tandem pin a cheaper model for claude-code/cli and codex/cli leader calls)

Follow-on to D68 (do not start until D68 lands — it's touching the same files right now).
Same overarching goal restated by the user: **Tandem's #1 priority is minimizing LEADER token
cost; worker cost is secondary and should never be traded against leader cost.** This round is
a second, independent lever on top of D68's session-reuse/budget-cap work.

## Finding

Checked `src/providers/registry.ts`: the `codex/cli` and `claude-code/cli` registry entries
both have `modelName: ""` (empty string). Confirmed via code read
(`buildClaudeExecArgv`/`buildCodexExecArgv`-equivalent) that an empty `modelName` means NO
`--model` flag is passed to either CLI at all — so each one falls back to whatever the user's
own CLI-level account config defaults to, entirely outside Tandem's control.

Live-checked what that currently resolves to (real calls, not guessed):
- `claude-code/cli` -> **`claude-opus-4-7[1m]`** (Opus tier, in 1M-context mode) — confirmed via
  a real `-p "say ok" --output-format json` call's `modelUsage` field.
- `codex/cli` -> **`gpt-5.5`** at `model_reasoning_effort = "high"` — confirmed via the user's
  real `~/.codex/config.toml`.

Both are the most expensive tier/mode available for their respective CLI. For LEADER calls
specifically (plan/review/takeover — the exact cost center the user wants minimized), this is a
second real, structural cost driver independent of D68's session-reuse issue.

## What to do

D69-1: Add a real, user-facing config field for pinning a specific model per CLI engine, e.g.
`claudeCliModel`/`codexCliModel` on `TandemConfig` (check whether a single shared field naming
convention fits better than two, your call) - when set, thread it through to the existing
`--model` flag plumbing (`buildClaudeExecArgv`'s `if (input.modelName) args.push("--model",
input.modelName)` already exists and works, it's just never fed a value for these two engines
today). Leave it optional/empty by default (preserve current behavior - don't silently change
what any existing user's session does) so this is purely an opt-in lever, not a forced
downgrade.

D69-2: Since the user's actual explicit ask is "minimize leader token cost," and both CLIs
accept model aliases (Claude: e.g. `sonnet`, `haiku`; confirmed via `claude --help`'s `--model`
description - "Provide an alias for the latest model (e.g. 'sonnet' or 'opus')"; Codex: check
`codex exec --help`'s `-m/--model` for the equivalent, and check `-c model_reasoning_effort=...`
as a cheaper-reasoning-effort alternative/companion lever to a full model swap), add a SEPARATE,
narrower option: let `defaultConfig` (or a documented recommendation in whatever settings UI/CLI
help text already exists) suggest a cheaper default for these two engines specifically for
LEADER role (e.g. claude `sonnet` instead of defaulting to whatever opus the account has, or
`model_reasoning_effort=medium` for codex) - but this is a recommendation/config-surface change,
not a forced default flip; verify a cheaper alias actually still produces schema-conformant
structured output before suggesting it (both engines' structured-output paths were hard-won in
D37/D41-D47 - don't assume a cheaper model has the same reliability without checking).

D69-3: Surface the CURRENTLY ACTIVE model somewhere visible (e.g. the desktop app's
existing `/status` line or model dropdown annotation) when leader is `codex/cli` or
`claude-code/cli` — today the user has no way to see the live resolved
`claude-opus-4-7[1m]`/`gpt-5.5` from inside Tandem itself (only from separately querying the
CLI/config directly, like I just did to answer this). If genuinely not cheaply obtainable
programmatically at session-start without an extra live call (check the JSON envelope's own
`model`/`modelUsage` field returned on the FIRST call of a session as the likely free source -
already present in every real response, confirmed present as `modelUsage` in the claude-code-cli
envelope), it's fine to only display it lazily once available rather than pre-fetching.

## Acceptance
tsc + `npm test` green. D69-1: unit test confirming a configured model name is passed through to
`--model` for both engines (extend existing exec.ts tests, same pattern as prior rounds). D69-2:
if a cheaper alias is verified live to still produce valid schema output for at least one real
call per engine, paste the real evidence in the completion report; if it doesn't hold up, report
that honestly rather than recommending an unverified alias (same discipline as every prior
live-verification round in this project). D69-3: confirm the resolved model string is visible
somewhere in the app after a real session's first call, live-verified via CDP against the
rebuilt desktop app (same bar as prior desktop-facing rounds). Commit `D69-<n>:`, create
`D69_done.txt`.
