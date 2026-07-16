# Handoff D99 (fix: absurdly-low leaderContextBudgetTokens causes near-constant compaction)

Found while investigating a user-reported "why does this say Codex CLI when I'm using MiniMax"
question (turned out to be a false alarm — stale scrollback from before a real earlier model
switch, not a bug). While tracing that session's log, found a real, separate, currently-active
issue in the same project's config.

## What's confirmed (don't re-derive)

The user's config (`.tandem/config.json` in the affected project, AND the global
`~/.tandem/config.json`) has:
```json
"leaderContextBudgetTokens": 50
```
Default is 60000. There is **no UI control anywhere for this field** (confirmed: grepped
`app/` — zero references outside the schema itself) and **no CLI command sets it** (grepped
`src/commands/` — nothing) — it can only be hand-edited in the JSON file directly, so this was
very likely a manual edit/experiment gone stale, not something the app itself produced.

**Real-world effect, confirmed from the session log**: `compactionSource()`
(`src/session/compaction.ts`) computes `budgetChars = Math.max(1, config.leaderContextBudgetTokens)
* 4` — at 50 tokens that's **200 characters**. Essentially any real conversational turn exceeds
200 characters, so compaction fires on nearly every single leader call. The log shows "compacted
N earlier turns" recurring constantly (N growing: 1, then 3, appearing repeatedly across
successive requests), each firing a real extra summarization API call before the actual work
even starts — pure wasted cost and latency, working directly against this project's stated #1
priority (leader token efficiency).

## What to do — read the backward-compatibility warning before implementing

D99-1: clamp the EFFECTIVE budget used at the point of consumption to a sane floor — do NOT add
a hard schema minimum (see the warning below for why). The two consumption sites:
`src/session/compaction.ts`'s `budgetChars()` helper and `src/agents/live.ts`'s
`compactLeaderThread`'s `budgetChars` calculation. Introduce a shared minimum constant (suggest
`MIN_LEADER_CONTEXT_BUDGET_TOKENS`, somewhere sensible like a shared constants location or
exported from one of these two files and imported by the other — avoid duplicating the magic
number) — pick a value that keeps at least a few real turns of conversation before compaction
kicks in (2000–5000 tokens is a reasonable floor; use judgment, don't overthink it). Compute the
effective budget as `Math.max(config.leaderContextBudgetTokens, MIN_LEADER_CONTEXT_BUDGET_TOKENS)`
at both sites.

**⚠️ Backward-compatibility warning (confirmed by reading `src/config/load.ts` — this is why a
schema-level fix is the WRONG approach):** `mergeConfig()` calls `ConfigSchema.safeParse(...)`
and **throws a `ConfigError` on any validation failure** — it does not silently fall back to
defaults. If you add `.min(N)` to the `leaderContextBudgetTokens` Zod field, this exact user's
existing config (`leaderContextBudgetTokens: 50`) would make Tandem **fail to start entirely**
for that project (and globally, since the global config also has 50) the next time they launch
it. Clamping at the point of USE (not at the schema/load boundary) avoids this entirely — the
raw config value stays valid and loadable, only its effect on compaction timing is bounded.

D99-2 (small, do only if trivial while in this area): consider a one-time `notice` machine event
when the effective budget was clamped up from the configured value ("configured leader context
budget (50 tokens) is below the practical minimum; using 2000") — matches this project's general
transparency practice (e.g. the D89/D91 truncation notices) and helps a user who genuinely sees
odd compaction behavior understand why without needing to read source. Don't build new
infrastructure for this — a simple one-line notice, once per session or once per call, is enough;
use judgment on frequency so it doesn't spam.

## What NOT to do

- Do NOT add a schema-level `.min()` constraint (see warning above).
- Do NOT auto-rewrite the user's config.json files. That's a file-mutation side effect outside
  this fix's scope; let the user decide whether to update their own config after seeing D99-2's
  notice (if implemented) or this handoff's explanation.
- Do NOT build a UI control for this setting as part of this round — out of scope, unrelated to
  the bug.

## Acceptance

tsc + `npm test` green. Regression tests: (a) `compactionSource`/`compactLeaderThread`'s
effective-budget calculation with a pathologically low configured value (e.g. 50) produces a
budget at least `MIN_LEADER_CONTEXT_BUDGET_TOKENS`, not the raw tiny value; (b) a normal/high
configured value (e.g. 60000) is unaffected — passes through unclamped; (c) if D99-2 is
implemented, a test confirming the clamp notice fires only when clamping actually occurred, not
on every call. Live/functional verification: confirm loading a config with
`leaderContextBudgetTokens: 50` no longer causes near-every-turn compaction (construct a
multi-turn conversation history under the old 200-char threshold and the new floor, and diff how
many turns get preserved before compaction triggers). Commit `D99-<n>:`, create
`handoffs/D99_done.txt`.
