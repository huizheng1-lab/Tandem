# Handoff D78 (fix: Anthropic direct-API calls 404 due to a broken system env var)

Real bug found and fully root-caused live — not a guess, confirmed end to end. This currently
blocks the ENTIRE Anthropic direct-API leader/worker path (the option previously identified as
structurally the best for minimizing leader token cost, since it has real prompt caching + a
persistent conversation thread, unlike `claude-code/cli`).

## Root cause (confirmed, do not re-derive)

The user's machine has a system/shell-level environment variable set:
```
ANTHROPIC_BASE_URL=https://api.anthropic.com
```
This is missing the required `/v1` path segment (the correct value would be
`https://api.anthropic.com/v1`). It is NOT set in either `~/.tandem/.env` or the project
`.env` — it's set outside Tandem entirely, likely by some other tool on the machine (found via
plain shell `echo $ANTHROPIC_BASE_URL`, not a Tandem file).

`@ai-sdk/anthropic`'s `createAnthropic()` (installed version 2.0.85, confirmed via
`node_modules/@ai-sdk/anthropic/dist/index.js`) resolves `baseURL` via:
```js
const baseURL = withoutTrailingSlash(loadOptionalSetting({
  settingValue: options.baseURL,
  environmentVariableName: "ANTHROPIC_BASE_URL"
})) ?? "https://api.anthropic.com/v1";
```
Tandem's own `src/providers/client.ts` (the `entry.provider === "anthropic"` branch, ~line 19-24)
calls `createAnthropic({ apiKey })` and does NOT pass an explicit `baseURL` — so when the stray
system env var is present, the SDK silently uses it INSTEAD of its own correct `/v1` default.
The resulting request goes to `https://api.anthropic.com/messages` (no `/v1`), which 404s.

Confirmed via live reproduction, isolating every variable:
- Raw HTTP `POST https://api.anthropic.com/v1/messages` with the real key and `claude-sonnet-5`
  → clean 200, real response, real usage data. Key and model are both fine.
- Minimal AI SDK call (`createAnthropic({apiKey})("claude-sonnet-5")` + `generateText({model,
  prompt})`, completely bypassing all of Tandem's own code) → same 404 at `.../messages` (no
  `/v1`). Confirms the bug is in the SDK's baseURL resolution picking up the stray env var, not
  in anything Tandem's runner/client code does.
- Checked for a `node_modules` duplicate-dependency theory first (a plausible alternate
  explanation) — ruled out, only single copies of `@ai-sdk/provider`/`@ai-sdk/provider-utils`
  exist in `node_modules`. The env var is the confirmed, sole cause.

## What to do

D78-1: In `src/providers/client.ts`'s `entry.provider === "anthropic"` branch, explicitly pass
`baseURL: "https://api.anthropic.com/v1"` to `createAnthropic({...})` (or read it from a new
optional config/env override if Tandem wants to support genuinely intentional Anthropic base-URL
overrides in the future — check whether that's worth adding now or is out of scope; if unsure,
default to the simpler hardcoded-correct-default fix and note the tradeoff in the completion
report rather than guessing at a config surface nobody asked for).

D78-2: Do the same audit for the `openai`/`google`/`openai-compatible` branches in the same file
— check whether `OPENAI_BASE_URL`/similar stray env vars could cause the identical class of bug
for those providers too (the AI SDK packages for those providers likely have their own analogous
`environmentVariableName` fallback). If any of those providers have a currently-configured,
non-empty API key in this environment, live-test them the same way (raw HTTP call vs. SDK call)
to confirm whether they're similarly affected before deciding whether to also pin their baseURL
explicitly. Don't fix speculatively without confirming the same bug class actually applies.

D78-3: Add a regression test asserting the anthropic branch of `makeModel`/the client
construction passes an explicit, correct `baseURL` (not relying on SDK defaults or env
fallbacks) — this is the kind of bug that's invisible in unit tests unless something actually
asserts the constructed client's config, so make sure the test would have caught this (e.g.
inspect the returned `LanguageModel`'s internal config if the SDK exposes it, or mock
`createAnthropic` and assert the call arguments include the correct baseURL).

## Acceptance
tsc + `npm test` green. Live verification required: with the user's real `ANTHROPIC_API_KEY`
present (already configured in `~/.tandem/.env`) and the stray `ANTHROPIC_BASE_URL` system env
var still present (do NOT ask the user to unset it — the fix must work despite that var existing,
since Tandem shouldn't depend on the user's system environment being clean), make a real
`makeModel("anthropic/claude-sonnet-5", ...)` call through Tandem's actual production code path
and confirm it succeeds (200, real response) instead of 404ing. Paste the real evidence in the
completion report. Commit `D78-<n>:`, create `D78_done.txt`.
