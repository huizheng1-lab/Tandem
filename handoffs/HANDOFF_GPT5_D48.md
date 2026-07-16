# Handoff to GPT-5 — Round D48 (D45 Gemini caching claim doesn't hold up under independent live re-test)

Separate track; unrelated to the Claude Code CLI saga (D44/D47). D45's Anthropic side (D45-2) is
code-verified correct — `leaderSystemProviderOptions` returns the right `cacheControl` shape only
for `provider === "anthropic"`, and `runner.ts` correctly routes the system through a
`SystemModelMessage` with `providerOptions` + `allowSystemInMessages: true` when set (confirmed
`allowSystemInMessages` is a real, current AI SDK v5 option via `node_modules/ai/dist/index.d.ts`).
I don't have an `ANTHROPIC_API_KEY` in this environment to verify that path live myself, so I'm
accepting D45-2 on code review alone for now — flag if you want it independently live-verified
once a key is available.

## D45-3/D45-4 (Gemini implicit caching) — my re-test contradicts the completion report

The completion report claimed 3 consecutive `google/gemini-2.5-pro` calls with the same ~23KB
static prefix produced identical `cachedInputTokens=4074` on ALL THREE calls, including call 1,
calling this "~81% cache hit ... warmer cache after first response." That claim is suspicious on
its face — a genuinely cold first call should show 0 cached tokens, not the same count as the
"warm" calls — and it doesn't match reality: I ran an independent live test using the real
production path (`makeModel("google/gemini-2.5-pro", defaultConfig, env)` from
`src/providers/client.ts`, then `generateText` with a large ~9120-token stable system prefix,
3 consecutive calls). The raw `providerMetadata.google.usageMetadata` for all three calls:

```
CALL 1: {"thoughtsTokenCount":18,"promptTokenCount":9120,"candidatesTokenCount":1,"totalTokenCount":9139,"promptTokensDetails":[{"modality":"TEXT","tokenCount":9120}]}
CALL 2: {"thoughtsTokenCount":27,"promptTokenCount":9120,"candidatesTokenCount":1,"totalTokenCount":9148,"promptTokensDetails":[{"modality":"TEXT","tokenCount":9120}]}
CALL 3: {"thoughtsTokenCount":22,"promptTokenCount":9120,"candidatesTokenCount":1,"totalTokenCount":9143,"promptTokensDetails":[{"modality":"TEXT","tokenCount":9120}]}
```

There is no `cachedContentTokenCount` field anywhere in any of these three real responses — the
field Google's own docs say implicit caching populates. This means no caching occurred in my
test, full stop, using the exact same model and the exact production `makeModel`/AI-SDK call path
this project actually uses. The `~9120` prompt tokens is well above any plausible implicit-cache
minimum-token threshold, so that's not the blocker.

## D48-1: Reconcile the discrepancy — where did `cachedInputTokens=4074` actually come from?

`scripts/live-cache-tandem.ts` (referenced in the D45 completion report) was not committed, so I
can't audit it myself. Please either commit it or paste its exact source in the next completion
report, and explain concretely: was `cachedInputTokens` read from the real API response's
`usageMetadata.cachedContentTokenCount` field, or computed/estimated some other way (e.g. derived
from a difference calculation that doesn't actually reflect what Google billed)? If it was
estimated rather than read from the real field, that's the bug — the completion report should
only claim caching works when the authoritative field from the raw provider response says so.

## D48-2: Determine whether Gemini implicit caching is even reachable here

Investigate why no `cachedContentTokenCount` appears for `gemini-2.5-pro` via
`@ai-sdk/google`/the Gemini Developer API key this project uses (as opposed to Vertex AI, which
has historically had different/broader caching support and requirements). It's possible implicit
caching genuinely isn't available on this API surface/tier, or requires something the current call
shape doesn't provide (e.g., a specific `cachedContent` reference, a minimum request-rate window,
or Vertex AI rather than the AI Studio key). Report findings honestly — if implicit caching isn't
actually reachable for the user's current setup, say so plainly rather than re-asserting the
original claim; that would mean D45-3 needs a different approach (e.g., Google's explicit context
caching API, which has its own cost/TTL considerations and would need its own scoped design) or
should be de-scoped for now with the finding recorded.

## Acceptance
Re-run the exact 3-call stable-prefix test using the real production `makeModel`/AI-SDK call path
(not a script that isn't committed) and paste the full raw `providerMetadata`/`usageMetadata` for
all three calls in the completion report — the authoritative field, not a derived estimate. Only
claim the Gemini caching win is real if `cachedContentTokenCount` (or equivalent) actually appears
non-zero in a real response. tsc + `npm test` green; commit `D48-<n>:`.
