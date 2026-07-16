# Handoff D70 (D69 gap: no way to actually SET the CLI model pins from the UI)

D69 added `claudeCliModel`/`codexCliModel`/`codexCliReasoningEffort` config fields and wired
them into `--model`/`-c model_reasoning_effort=` on the real CLI calls (confirmed correct via
live testing during review). But D69 only wired **display** of the configured value
(`modelDisplayName()` in the status line, `/models` list, dropdown labels) — there is no UI
control or slash command anywhere that lets a user actually **set** these three fields. Today
the only way to use D69's feature is hand-editing `config.json` directly. User caught this
("there is no model selection for cli in the ui") immediately after D69 was approved.

Also relevant, from the reviewer's own live testing this round: pinning `codexCliModel` to a
model name not permitted under this account's Codex auth type (e.g. `gpt-5-mini` under a
ChatGPT-account login) fails with a clean 400 from the CLI itself
("The '<model>' model is not supported when using Codex with a ChatGPT account.") — so whatever
UI/command surface this round adds should let that error surface directly to the user (it
already will, if the setConfig path doesn't swallow it), not silently accept an invalid value.

## What to do

D70-1: Extend the existing `/model` command (`src/commands/model.ts`, wired identically in both
`src/tui/App.tsx` and `app/renderer/src/main.tsx`) to accept two new target names alongside the
existing `leader`/`worker`:
- `/model claude-cli <model-name-or-alias>` — sets `claudeCliModel` (e.g. `haiku`, `sonnet`, a
  full model string). `/model claude-cli clear` (or `default`) unsets it back to CLI-default
  behavior (`undefined`, not an empty string — check how the config schema/merge treats absence
  vs empty string for this optional field).
- `/model codex-cli <model-name>` — sets `codexCliModel`, same clear/default semantics.

Reuse the exact `tandem.setConfig({...})` / `saveProjectConfig` mechanism `/model leader`/`/model
worker` and `/rounds` already use (`app/main/tandem-service.ts`'s `setConfig` IPC handler, or the
CLI TUI's equivalent dispatch in `src/commands/model.ts`/`dispatchCommand`) — this is a config
merge + persist, no new plumbing needed. Do NOT validate the model name against a hardcoded list
(the whole point of D69 is these are free-form CLI-account-dependent strings) — let a bad value
surface as a real CLI error on the next call, same as it does today when set via config.json
directly.

D70-2: Add `/model codex-effort <minimal|low|medium|high|clear>` for `codexCliReasoningEffort`
(the existing `CodexCliReasoningEffortSchema` enum in `src/config/schema.ts` already defines the
valid values — reuse it for validation, reject anything else with a clear usage message rather
than silently accepting garbage).

D70-3: Update `composerHelpText()` (desktop) and the CLI TUI's `/help` text to list the new
`/model claude-cli`, `/model codex-cli`, `/model codex-effort` forms, matching the existing
`/model leader`/`/model worker` entries' style.

D70-4 (optional, lower priority — only if D70-1/2/3 go cleanly and time allows): desktop-only,
a small settings-panel or dropdown-adjacent affordance for the same three fields, so a user
doesn't have to know the slash-command syntax. Not required for this round — the slash-command
surface alone closes the actual gap (no way to set them at all); a nicer settings UI can be a
future round if the user asks for it. Do not build this speculatively if it doesn't fit cleanly
into the existing settings panel structure — report the feasibility instead.

## Acceptance
tsc + `npm test` green. Unit tests for the three new `/model` sub-targets (set + clear semantics,
invalid `codex-effort` value rejected with a usage message) mirroring the existing `/model
leader`/`/model worker` test style. Live verification required in BOTH the CLI TUI and the
rebuilt desktop app (same dual-surface bar as D51/D52/D69): run `/model claude-cli haiku`,
confirm `/status` and `/models` reflect it via `modelDisplayName()`, then make a real leader call
and confirm (via the activity strip or a direct check) it's actually using haiku, not the CLI
default. Also verify `/model claude-cli clear` genuinely reverts to CLI-default behavior, not an
empty-string model name (which could break the `--model` flag's `if (input.modelName)` guard in
`buildClaudeExecArgv`/Codex's argv builder in an unexpected way — check both). Commit
`D70-<n>:`, create `D70_done.txt`.
