# Handoff to GPT-5 — Round D32 (new Gemini models + config-only model additions)

User request: enable the newest Gemini models. Reviewer queried the live Google API with the
user's key; available now (relevant subset): `gemini-3.5-flash`, `gemini-3.1-pro-preview`,
`gemini-3-pro-preview`, `gemini-3.1-flash-lite`, plus the existing 2.5 line. NOTE: there is NO
`gemini-3.5-pro` — do not invent one.

## D32-1: customModels gains a `provider` field (durable fix)
Extend `CustomModel` in `src/config/schema.ts` with optional
`provider: "google" | "anthropic" | "openai" | "openai-compatible"` (default
"openai-compatible" for back-compat; `baseURL` required only for openai-compatible).
`customToModelEntry` and `makeModel` route accordingly. Result: any future model on any known
provider is a config entry, not a code change. Unit tests: google custom model resolves via the
native provider; back-compat entry without `provider` still works; missing baseURL rejected
only for openai-compatible.

## D32-2: Built-ins for the current Gemini lineup
Add to `src/providers/registry.ts` (provider "google", envKey GEMINI_API_KEY):
- `google/gemini-3.5-flash`
- `google/gemini-3.1-pro-preview`
- `google/gemini-3-pro-preview`
- `google/gemini-3.1-flash-lite`
Keep the 2.5 entries. Pricing for the 3.x line is post-knowledge-cutoff: omit costHints rather
than guessing (cost shows $0 until the user supplies costHints via a customModels override) and
note this in the README model table.

## Acceptance
tsc + `npm test` green; commits `D32-<n>:`. Reviewer will verify `/models` lists the new ids
with keys detected, the desktop dropdowns offer them, and run one small live prompt with
`google/gemini-3.5-flash` as leader to confirm the id works through the native provider
(tool-calling included).
