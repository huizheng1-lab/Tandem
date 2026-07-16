# HANDOFF_D74.md

## Title
D74 - Make desktop CLI model controls discoverable

## User Report
The user still does not see any model picker/control in the desktop UI for Codex CLI or Claude Code CLI.

## Diagnosis
D71/D72 added the controls, but `app/renderer/src/main.tsx` currently renders them only when the active leader or worker is already using that CLI provider:

- `usesClaudeCli = effectiveConfig?.leader === "claude-code/cli" || effectiveConfig?.worker === "claude-code/cli"`
- `usesCodexCli = effectiveConfig?.leader === "codex/cli" || effectiveConfig?.worker === "codex/cli"`
- The Claude CLI model select is gated by `{usesClaudeCli ? (...) : null}`
- The Codex CLI model input and effort select are gated by `{usesCodexCli ? (...) : null}`

That means a user cannot discover or set the CLI model pin before switching the Leader/Worker dropdown to a CLI provider. If the CLI provider is unavailable/disabled/missing from the dropdown, the controls may never become visible.

## Goal
Make the desktop UI expose CLI model pin controls in a discoverable place even when `codex/cli` or `claude-code/cli` is not currently selected as leader/worker.

## Scope
Implement a desktop UI-only fix. Do not change CLI execution behavior, config schema, slash commands, provider registry, or D73 prompt caching.

## Required UX
In `app/renderer/src/main.tsx`, make the following controls visible whenever a project session is active and `effectiveConfig` is loaded:

1. `Claude CLI model`
   - Use the existing D72 dropdown.
   - Options must remain:
     - `CLI default` with value `""`, clearing `claudeCliModel`
     - `haiku`
     - `sonnet`
     - `opus`
   - On change, call the existing `updateCliModelPin("claude-cli", value || "clear")`.

2. `Codex CLI model`
   - Keep the existing free-text input.
   - It should remain bound to `codexCliModelDraft`.
   - On blur / Enter, call the existing `updateCliModelPin("codex-cli", codexCliModelDraft.trim())`.

3. `Codex effort`
   - Keep the existing select.
   - Options must remain:
     - `CLI default` with value `""`
     - `minimal`
     - `low`
     - `medium`
     - `high`
   - On change, call the existing `updateCliModelPin("codex-effort", value)`.

## Layout Guidance
The status bar is already crowded, and always showing all controls may wrap awkwardly. Prefer a compact implementation that is still immediately discoverable:

- Option A, preferred: add a small `CLI models` group/button in the status bar that opens an inline popover/panel containing all three controls.
- Option B: always show all three controls directly in the status bar, but adjust CSS so desktop and narrower widths do not hide or overlap text.

Do not bury the controls behind slash commands only. The user specifically expects to see them in the desktop UI.

## Files Likely To Change
- `app/renderer/src/main.tsx`
- `app/renderer/src/styles.css`
- Tests/smoke scripts if needed

## Important Existing Helpers
- `claudeCliModelOptions` already exists near the top of `app/renderer/src/main.tsx`.
- `codexEffortOptions` already exists.
- `codexCliModelDraft` state and sync effect already exist.
- `updateCliModelPin()` already translates UI changes through `cliModelPatch()` and persists with `tandem.setConfig()`.
- `commitTextInputOnEnter()` already commits the Codex text input on Enter.

## Acceptance Criteria
- The desktop UI exposes a visible/discoverable `Claude CLI model` control even when neither leader nor worker is `claude-code/cli`.
- The desktop UI exposes visible/discoverable `Codex CLI model` and `Codex effort` controls even when neither leader nor worker is `codex/cli`.
- Changing the Claude dropdown persists `claudeCliModel`; selecting `CLI default` removes/clears it.
- Editing the Codex model input persists `codexCliModel`; blank/default removes/clears it.
- Changing Codex effort persists `codexCliReasoningEffort`; selecting `CLI default` removes/clears it.
- Existing Leader and Worker model dropdowns still show `modelDisplayName(model.id, effectiveConfig)` with any configured CLI pins.
- No controls overlap or get clipped on a normal desktop viewport.

## Required Verification
Run all of these:

1. `npm run typecheck`
2. `npm test`
3. `npx electron-vite build`
4. `git diff --check`

Also run a live Electron smoke test with Playwright `_electron` or equivalent:

- Start the app with an isolated `--user-data-dir` and temp `TANDEM_HOME`.
- Provide fake or real `CLAUDE_CLI_PATH` and `CODEX_CLI_PATH` so CLI providers are available.
- Choose/open a project.
- With default non-CLI leader/worker settings, verify the CLI model controls are discoverable/visible.
- Set Claude to `haiku`, `sonnet`, `opus`, then `CLI default`; verify the on-disk `.tandem/config.json` changes accordingly.
- Set Codex CLI model to a test value such as `gpt-5-mini`; verify config persistence.
- Set Codex effort to `medium`, then `CLI default`; verify config persistence.
- Confirm the UI still renders without overlap at a normal desktop size.

## Commit Message
`D74-1: expose desktop CLI model controls`

## Done Marker
After implementation and successful verification, create `D74_done.txt` in the repo root with:

- round number
- commit hash
- verification summary
- any live-smoke limitations
