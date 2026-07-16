# Handoff D71 (D70-4: surface the CLI model pin in the desktop dropdown UI)

D70 shipped `/model claude-cli`/`/model codex-cli`/`/model codex-effort` slash commands (correctly
scoped — D70-4, a dropdown/settings-panel affordance, was explicitly marked optional and skipped
that round). User just confirmed directly against the real running desktop app that there's no
UI-visible way to set these next to the existing Leader/Worker dropdowns — only the slash-command
surface exists. Build D70-4 now.

## Where to add it

`app/renderer/src/main.tsx`, in the `statusBar` header, immediately after the existing Leader and
Worker `<select>` elements (~line 1108-1130). Reuse the exact pattern `updatePermissionMode`
already uses (`tandem.setConfig({...})` directly, no new IPC channel needed — same mechanism
`updateModel`/`updatePermissionMode`/`updateShowThinking` all already use).

## What to build

D71-1: Conditionally render an additional control based on which CLI engine is currently
selected as leader OR worker (not just leader — `codex/cli`/`claude-code/cli` can be either
role):
- When `effectiveConfig.leader === "claude-code/cli"` OR `effectiveConfig.worker ===
  "claude-code/cli"`: show a free-form text input (not a `<select>` — model names are
  CLI-account-dependent strings, same reasoning as the D70 slash command's "don't validate
  against a hardcoded list") bound to `effectiveConfig.claudeCliModel`, placeholder text like
  "CLI default (e.g. haiku, sonnet)". On change/blur, call `tandem.setConfig({ claudeCliModel:
  value || undefined })` — empty string must clear to `undefined`, not persist as `""` (mirror
  the exact clear-semantics bug class D70's `cliModelPatch` already got right — check
  `src/commands/model.ts`'s `cliModelPatch` for the reference behavior, don't reinvent it, ideally
  reuse `cliModelPatch`/`setCliModelConfig` from `src/commands/model.ts` directly instead of
  duplicating the undefined-vs-empty-string logic in the renderer).
- When `effectiveConfig.leader === "codex/cli"` OR `effectiveConfig.worker === "codex/cli"`: show
  a similar free-form text input for `codexCliModel`, PLUS a `<select>` for
  `codexCliReasoningEffort` with options CLI default (empty/clear) / minimal / low / medium /
  high (reuse `CodexCliReasoningEffortSchema` from `src/config/schema.ts` for the option list
  instead of hardcoding the four strings a second time).
- When neither engine is a CLI provider, render nothing extra (current behavior unchanged).

D71-2: Both new inputs should update on blur or Enter (not on every keystroke — avoid
`saveProjectConfig` firing on every character typed into a free-form model-name field; the
existing composer/goal inputs in this file may already have a pattern for this, check before
inventing one).

D71-3: Update `modelDisplayName()` usage or the status line so the currently-set CLI model pin
is visible without opening/inspecting the new input (it already is — `modelDisplayName()` shows
it in the Leader/Worker `<option>` labels — verify this still reads correctly once D71-1 lands,
don't just assume).

## Acceptance
tsc + `npm test` green. Live CDP verification against the rebuilt packaged app is REQUIRED this
round (this is the exact UI-facing gap the user pointed out twice — a code-only review is not
enough): switch leader to `claude-code/cli`, confirm the new input appears; type `haiku`, blur,
confirm `tandem.setConfig` fired and the Leader dropdown's own label updates via
`modelDisplayName()`; clear the input, confirm it reverts to CLI-default display; switch leader
to `codex/cli`, confirm both the model text input and the effort `<select>` appear; switch leader
to a non-CLI engine (e.g. `google/gemini-...`), confirm the extra inputs disappear entirely.
Commit `D71-<n>:`, create `D71_done.txt`.
