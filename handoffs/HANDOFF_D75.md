# HANDOFF_D75.md

## Title
D75 - Re-implement desktop CLI model controls without clipped popover

## Context
D74 was attempted, then rolled back.

Rollback commits now on `master`:

- `7cf6416` reverted `D74-2`
- `4798c19` reverted `D74-1`

The repo is intentionally back to the state where `HANDOFF_D74.md` exists as the original untracked handoff, and the desktop code still only shows CLI model controls when the active leader/worker is already a CLI provider.

Do **not** modify `HANDOFF_D74.md`. Treat it as the original product request. D75 is the repair/re-implementation handoff.

## Problem To Fix
The D74 implementation direction was good, but the UI approach had a likely visual bug:

- It placed an absolutely positioned `.cliModelsPopover` inside `.statusBar`.
- `.statusBar` has `overflow-x: hidden` in `app/renderer/src/styles.css`.
- A child popover positioned below the status bar can be clipped by the status bar's overflow/box, so the new "CLI models" control may still appear broken or partially invisible.
- D74 also skipped the required live Electron smoke test, which was exactly the check needed for this visual behavior.

## Goal
Implement the original D74 UX safely:

Expose discoverable desktop controls for:

- Claude CLI model
- Codex CLI model
- Codex effort

These controls must be discoverable even when neither Leader nor Worker is currently set to `claude-code/cli` or `codex/cli`.

## Required Approach
Use one of these safe patterns:

1. Preferred: status-bar `CLI models` trigger + popover rendered outside the clipped `.statusBar`.
   - Use `position: fixed` with measured trigger coordinates, or a React portal attached near the app root/document body.
   - The popover must not be a clipped child of `.statusBar`.

2. Acceptable: an always-visible compact inline section that does not depend on popover overflow.
   - If using this, ensure the status bar wraps cleanly and does not overlap or clip text at normal desktop widths.

Do **not** reintroduce a popover whose visible content depends on escaping a parent with overflow clipping.

## Current Code Pointers
In `app/renderer/src/main.tsx`:

- Existing gated booleans:
  - `usesClaudeCli`
  - `usesCodexCli`
- Existing gated controls are around the status bar:
  - `Claude CLI model`
  - `Codex CLI model`
  - `Codex effort`
- Existing helpers/state:
  - `claudeCliModelOptions`
  - `codexEffortOptions`
  - `codexCliModelDraft`
  - `updateCliModelPin()`
  - `commitTextInputOnEnter()`

In `app/renderer/src/styles.css`:

- `.statusBar` currently has `overflow-x: hidden`.
- Account for this explicitly in the design.

## Required UX Details
The controls must behave exactly like D74 requested:

1. Claude CLI model
   - Select options:
     - `CLI default` with value `""`
     - `haiku`
     - `sonnet`
     - `opus`
   - On change, call `updateCliModelPin("claude-cli", value || "clear")`.

2. Codex CLI model
   - Free-text input bound to `codexCliModelDraft`.
   - On blur or Enter, call `updateCliModelPin("codex-cli", codexCliModelDraft.trim())`.

3. Codex effort
   - Select options:
     - `CLI default` with value `""`
     - `minimal`
     - `low`
     - `medium`
     - `high`
   - On change, call `updateCliModelPin("codex-effort", value)`.

## Acceptance Criteria
- With a normal non-CLI leader/worker selected, the user can discover and open/see CLI model controls.
- The controls persist values to `.tandem/config.json` through existing `tandem.setConfig()` flow.
- Selecting/defaulting clears the relevant config field instead of writing an empty string.
- The existing inline gated controls may remain for active CLI providers, but there must be one always-discoverable UI surface.
- No popover/control is clipped by `.statusBar`.
- No controls overlap or become unreadable on a normal desktop viewport.
- Existing Leader/Worker dropdown labels still reflect configured CLI pins through `modelDisplayName(model.id, effectiveConfig)`.

## Required Verification
Run:

1. `npm run typecheck`
2. `npm test`
3. `npx electron-vite build`
4. `git diff --check`

Also run a live Electron visual/config smoke test. This is not optional for D75.

Suggested smoke method:

- Use bundled Playwright if local project Playwright is absent:
  - Node packages path: `C:\Users\huizh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`
  - If plain `NODE_PATH` does not resolve Playwright correctly, use the existing repo/local smoke pattern from prior D71/D72 work or run a manual Electron click-through and document exact steps/results.
- Start the app with isolated `--user-data-dir` and temp `TANDEM_HOME`.
- Provide fake or real `CLAUDE_CLI_PATH` and `CODEX_CLI_PATH`.
- Open a project.
- Keep Leader/Worker on non-CLI defaults.
- Verify the CLI model UI is visible/discoverable.
- Open the UI surface and verify the controls are not clipped.
- Set Claude to `haiku`, `sonnet`, `opus`, then `CLI default`; verify config changes.
- Set Codex CLI model to `gpt-5-mini`; verify config changes.
- Set Codex effort to `medium`, then `CLI default`; verify config changes.
- Capture at least one screenshot path or bounding-box evidence in `D75_done.txt`.

If automated Playwright cannot run, do a manual Electron smoke and document:

- exact command used to launch the app
- viewport/window size
- what was clicked
- screenshot path
- observed config JSON after each control change

## Files Likely To Change
- `app/renderer/src/main.tsx`
- `app/renderer/src/styles.css`
- optionally a small test/smoke helper if useful

## Commit Message
`D75-1: fix desktop CLI model control visibility`

## Done Marker
After successful implementation and verification, create `D75_done.txt` in the repo root with:

- round number
- implementation commit hash
- verification summary
- live visual/config smoke evidence
- any deviations from this handoff
