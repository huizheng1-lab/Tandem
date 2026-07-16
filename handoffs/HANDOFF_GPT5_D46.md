# Handoff to GPT-5 — Round D46 (add MiniMax M3 as a worker option, make it the default)

Separate track from D44/D45; can run in parallel. User wants "minimax m3" added to the Worker
dropdown and set as the new default worker (current default is `minimax/minimax-m2.7`, keep that
entry in place — don't remove it, existing configs may still reference it).

## Confirmed starting state (read `src/config/schema.ts` and `src/providers/registry.ts`)
- `minimax/minimax-m2.7` is NOT in `builtInModels` (registry.ts) — it's seeded as a
  `customModels` entry in `defaultConfig` (schema.ts:82-89): `{ id: "minimax/minimax-m2.7",
  baseURL: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", modelName: "MiniMax-M2.7" }`,
  no `costHints`. `defaultConfig.worker` (schema.ts:75) is currently `"minimax/minimax-m2.7"`.
- `modelRegistry(customModels)` in registry.ts merges `customModels` + `builtInModels` (custom
  wins on id collision) and this is what feeds the Worker/Leader dropdowns — the mechanism already
  works for custom entries (confirmed working for m2.7 and previously for codex/cli,
  claude-code/cli in earlier rounds), so no dropdown-plumbing change should be needed, only a new
  registry entry.

## D46-1: Verify the real API model identifier before hardcoding anything
Do not guess or assume the exact string MiniMax uses for M3 (could be `MiniMax-M3`,
`MiniMax-M3-preview`, etc.) or its real pricing/context window. `MINIMAX_API_KEY` is already
present in the user's `.env`. Confirm the live, correct model name via MiniMax's own API docs
and/or a real minimal test call against `https://api.minimax.io/v1` (mirror how minimax-m2.7 and
every other model in this project was verified — a cheap real call, not an assumption) before
writing the registry entry. Report the exact confirmed string and any real pricing/context-window
numbers found in the completion report.

## D46-2: Add the new model entry
Add a new entry for MiniMax M3 following the exact same pattern as the existing minimax-m2.7
customModels entry (openai-compatible provider, same baseURL, same apiKeyEnv). Suggested id
`minimax/minimax-m3` unless the verified naming convention suggests otherwise. Include real
`costHints`/`contextWindow` if D46-1 turns up trustworthy numbers; otherwise omit them (matching
how m2.7 currently has no costHints) rather than guessing.

## D46-3: Make it the default worker
Change `defaultConfig.worker` (schema.ts) to the new model id. Note this only affects *fresh*
installs/configs — it will NOT retroactively change the value already written to the user's
existing `~/.tandem/config.json` or any project-level config. Mention this clearly in the
completion report; do not attempt to silently rewrite the user's live config file as a side
effect of this change.

## D46-4: Live verification
Run a real worker-build round using `minimax/minimax-m3` as the worker (any simple real task, same
discipline as every other live-model-facing round in this project) and confirm it completes a full
build + self-verification successfully, with real token/cost data recorded. Also confirm
`minimax/minimax-m2.7` still resolves and works unchanged (regression check — it must remain
selectable, just no longer the default).

## Acceptance
tsc + `npm test` green; commit `D46-<n>:`. Reviewer will check the new model appears in the
Worker dropdown in the actual desktop app, confirm the default worker is now MiniMax M3 on a fresh
config, and re-run a live worker-build scenario with the new model before approving.
