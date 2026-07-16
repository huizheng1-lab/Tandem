# HANDOFF_D73.md

## Title
D73 - Add OpenAI GPT prompt cache keys

## Background
Tandem already marks Anthropic leader system prompts as cacheable, but GPT/OpenAI calls do not pass a `prompt_cache_key`. OpenAI's AI SDK supports this through `providerOptions.openai.promptCacheKey`. Without an explicit key, GPT requests may still get automatic cache hits, but Tandem cannot improve cache routing for repeated leader/worker prefixes.

## Scope
- Add deterministic OpenAI `promptCacheKey` provider options for API-backed GPT calls.
- Keep Anthropic cache-control behavior unchanged.
- Use role-scoped keys so leader and worker prompts do not collide.
- Do not add session reuse or mutable conversation-state reuse.
- Keep keys free of raw paths, usernames, or secrets.

## Implementation Notes
- Add a runner-level `providerOptions` field that is forwarded to `streamText`.
- Keep `systemProviderOptions` for message-attached Anthropic cache-control.
- Add helpers in `src/agents/live.ts` to build OpenAI provider options:
  - Leader: stable key based on `leader`, repo/cwd hash, and a prompt-cache version.
  - Worker: stable key based on `worker`, repo/cwd hash, stream/default role, and a prompt-cache version.
- Use short hashed material so keys remain within OpenAI's 64-character limit.
- Apply only to `entry.provider === "openai"`. Leave `openai-compatible`, CLI providers, Google, and Anthropic unchanged.

## Acceptance Criteria
- Tests assert Anthropic cache options remain unchanged.
- Tests assert OpenAI leader/worker prompt cache keys are deterministic, role-scoped, path-sanitized, and <= 64 chars.
- Typecheck passes.
- Unit tests pass.
- `git diff --check` passes.

## Verification
- `npm run typecheck`
- `npm test`
- `git diff --check`

## Commit Message
`D73-1: add OpenAI prompt cache keys`
