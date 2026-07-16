# Handoff D77 (investigate: does codex/cli have any explicit caching lever Tandem could use)

Same overarching goal as always: minimize LEADER token cost first. Follow-on to D68 (which did
this exact investigation for `claude-code/cli`) and D73 (OpenAI prompt cache keys, confirmed
gated to `entry.provider === "openai"` only — does NOT reach `codex/cli`, a separate subprocess
path in `src/agents/codex-cli/exec.ts` that never touches `live.ts`/`runner.ts` at all).

## What's already confirmed (real, live-checked — don't re-derive)

- `src/agents/codex-cli/exec.ts` passes `--ephemeral` on every call ("Run without persisting
  session files to disk") — so every Tandem call to `codex/cli` (plan/review/takeover/worker
  build) is a cold, stateless subprocess invocation today, same design as
  `claude-code-cli`'s `--no-session-persistence`. No cross-round session reuse exists.
- Real evidence from a live `codex exec --json "say ok"` call this session: the response
  included `"usage":{"input_tokens":13470,"cached_input_tokens":10112,...}` — 75% of that
  single call's input was served from cache. This is OpenAI's own AUTOMATIC platform-level
  caching (no explicit key needed, works across any request sharing a prefix within the
  account's cache window) — real, but NOT something Tandem controls or can currently improve;
  it's whatever OpenAI's infrastructure decides to do.
- `codex --help` / `codex exec --help` (real installed CLI, v0.142.5) exposes a `resume`
  subcommand: `codex exec resume [SESSION_ID] [PROMPT]` (also `--last` to resume the most
  recent), plus the same `--ephemeral` flag available on both `exec` and `exec resume`. This is
  structurally identical to the `--session-id`/`--resume` mechanism D68 investigated for
  `claude-code/cli` (which found a real 3.3x cost win via cache-read reuse, but declined to ship
  it due to a real contamination risk — stale sessions persisting to disk with no auto-cleanup).

## What to investigate

D77-1: Run the exact same live A/B test D68 ran for `claude-code/cli`, adapted for `codex/cli`:
make two real `codex exec` calls with an IDENTICAL long system/prompt prefix (reuse the actual
`leaderPlannerPrompt`/`leaderReviewerPrompt` text via the real production prompt builders in
`src/agents/codex-cli/leader.ts`, not a toy string) — first cold (current default, `--ephemeral`
on), second via dropping `--ephemeral` and using `codex exec resume --last` (or a captured
session id from the first call's JSON output). Compare real `usage.cached_input_tokens`/
`usage.input_tokens` between the two. Report the real numbers either way.

D77-2: If a real, meaningful cache win shows up (matching or exceeding D68's precedent), assess
the SAME contamination risk D68 flagged and weighed: where do Codex session files actually get
written when `--ephemeral` is dropped (find via `codex exec --help`'s own docs or by testing —
likely somewhere under `$CODEX_HOME`/`~/.codex/`), is there any auto-cleanup, and could a
crashed/interrupted Tandem run leave a stale session file that a later UNRELATED request could
accidentally resume via `--last` (this would be a correctness bug, not just a cost issue — same
severity framing as D68). If the contamination risk is real and unmanageable within one
orchestration run's clean lifecycle, it is EXPLICITLY OK to conclude "not worth it" and not
implement — same permission D68 was given. Report the real evidence honestly either way; do not
implement something you can't cleanly scope to one orchestration run with reliable cleanup.

D77-3 (secondary, only if D77-1/D77-2 don't pan out cleanly): investigate whether `-c
key=value` config overrides expose anything caching-related that isn't visible in `--help`'s
top-level flag list (check `codex exec --help`'s own note that `-c` accepts "a dotted path" for
ANY config.toml field, including ones not individually documented as CLI flags — grep any
available Codex CLI documentation/config schema reference for a cache-related key, or test
empirically with a plausible guess like `-c model_prompt_cache_key=...` and see if it's accepted
or rejected as unrecognized). Do not guess-and-ship a config key without confirming the CLI
actually recognizes it (an unrecognized `-c` override may be silently ignored rather than
erroring, which would look like it worked but wouldn't).

## Acceptance
This is an investigation round — a "not worth it, don't implement" conclusion for D77-1/D77-2 is
an acceptable, complete outcome, exactly as it was for D68-1. If nothing yields a real win,
report the honest findings and stop; do not force an implementation to have something to ship.
If D77-1 does show a real win AND D77-2's contamination-risk review comes back clean (a real,
reliable per-orchestration-run cleanup path exists), implement it scoped exactly the way D68-1's
own hard constraint required: session reuse never crosses a single orchestration run's boundary.
tsc + `npm test` green for whatever ships (nothing to test if the conclusion is "don't
implement"). Commit `D77-<n>:` only if code changes; otherwise a `D77_done.txt` with the
investigation findings alone is a complete, valid round.
