# Handoff to GPT-5 — Round D45 (prompt caching for the leader — token savings, not a bug fix)

Separate track from the D44 Claude-Code-CLI fix; can be worked in parallel. Goal: reduce leader
token cost, since the worker (MiniMax) is already near-zero marginal cost per the user — the
leader is the actual cost driver, and right now every leader call pays full price for its static
system prompt from scratch.

## Confirmed starting state (read `src/agents/live.ts`, do not re-derive from scratch)
- The AI-SDK leader path already builds a genuinely separate `system` string from the `messages`
  array for every call kind (`live.ts:397` question path, `:598` review, `:684` takeover, plan
  path similarly) — good foundation, no restructuring of that boundary needed.
- Each `system` string is assembled as `${leaderXPrompt}\n${hostPrompt}\n${await
  projectInstructions()}\n${memoryInstruction}\n<call-specific trailer>` — the first three pieces
  are stable for a given project across an entire session; `memoryInstruction` needs to be checked
  for per-call stability (if it changes turn-to-turn, e.g. reflects live goal/session state, the
  cache breakpoint must go BEFORE it, not after).
- Installed provider packages: `@ai-sdk/anthropic@2.0.85`, `@ai-sdk/google@^2.0.78`,
  `@ai-sdk/openai@2.0.110`, `@ai-sdk/openai-compatible@1.0.42`. Anthropic is available as a direct
  API leader option (separate from the Claude Code CLI subprocess engine, which Tandem does not
  control the request internals of — do not touch that engine for this round).

## D45-1: Stabilize and front-load the static prefix
Wherever a leader `system` string is built, ensure the byte-identical static block (persona +
`hostPrompt` + `projectInstructions()` + any other content stable for the session) comes first and
is byte-for-byte identical across repeated calls within a session, with any per-call-variable
content (memory/goal state, call-specific trailer instructions) appended after it. This is a
prerequisite for every provider's caching (explicit or automatic) — verify it holds for all of
plan/review/takeover/question-answer paths, not just one.

## D45-2: Anthropic — explicit cache breakpoint
For leader calls routed through `@ai-sdk/anthropic`, mark the static system prefix with a cache
breakpoint using whatever mechanism the installed `2.0.85` SDK actually exposes (check its
current docs/types — AI SDK's cache-control support has changed across versions; do not assume a
syntax from general knowledge). Typically this means attaching `providerOptions: { anthropic: {
cacheControl: { type: "ephemeral" } } }` to the relevant message/system part. Confirm the SDK
version installed actually supports this before writing code against it.

## D45-3: Gemini — verify implicit caching is actually landing
Gemini 2.5 models (the user's current leader is `google/gemini-2.5-pro`) support *implicit*
prompt caching automatically — no code change required, PROVIDED the shared prefix is stable and
sent first (see D45-1) and meets Google's minimum token threshold. No explicit flag needed here.
Do not add speculative explicit-cache-content code for Gemini unless implicit caching is
confirmed NOT to engage.

## D45-4: OpenAI-compatible (MiniMax/worker path) — out of scope
Worker calls are already near-zero marginal cost per the user; do not spend effort here. Only the
leader path matters for this round.

## Acceptance — must be proven live, not just code-reviewed
Given the pattern this project has established (three straight rounds where code review + the
implementer's own "verified live" claim did not hold up under my re-test), this round's acceptance
bar is: run a real live session with the CURRENT leader model (`google/gemini-2.5-pro`) that makes
at least two consecutive leader calls sharing the same static prefix (e.g. a plan call followed by
a review call, or two review calls in the same run), and paste the raw API response usage
metadata showing cached tokens were actually used — for Gemini that's `usageMetadata.
cachedContentTokenCount` (or equivalent field in the current `@ai-sdk/google` response), for
Anthropic that's `cache_read_input_tokens`/`cache_creation_input_tokens` in the usage block. A
code change that "looks correct" without this pasted evidence will not be treated as sufficient by
the reviewer. tsc + `npm test` green; commit `D45-<n>:`.
