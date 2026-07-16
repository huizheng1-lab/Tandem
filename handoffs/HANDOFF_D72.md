# Handoff D72 (replace the free-text Claude CLI model input with a dropdown)

User feedback on D71: doesn't want to type/remember a Claude model name in the desktop UI —
wants it listed in a dropdown instead, same shape as the existing Leader/Worker selects. Scoped
to `claudeCliModel` only (that's what the user asked about) — leave `codexCliModel` as the
free-text input D71 already shipped, since D69's review found Codex CLI model names are
account-auth-dependent (a plausible-looking `gpt-5-mini` 400'd under a ChatGPT-account login;
there's no safe fixed list to offer there without risking a stale/wrong option).

## Verified live before writing this (don't re-derive, just use these)

Ran real, cheap `claude --model <alias> -p "say ok" --no-session-persistence` calls against the
actual installed CLI:
```
sonnet -> claude-sonnet-4-6   (is_error: false)
opus   -> claude-opus-4-7     (is_error: false)
haiku  -> claude-haiku-4-5-20251001 (is_error: false)
```
An invalid alias (`bogus-alias-xyz`) returns a clean `api_error_status: 404` with
`is_error: true` and a human-readable message — cheap to fail safely on, in case any of these
aliases drift on a future CLI version.

## What to do

D72-1: In `app/renderer/src/main.tsx`, replace the "Claude CLI model" `<input className=
"cliPinInput">` (added in D71, ~line 1153-1163) with a `<select>`, matching the existing Leader/
Worker/`Codex effort` select pattern exactly (not the free-text input pattern). Options:
- `CLI default` (value `""`, clears `claudeCliModel` via the existing `cliModelPatch("claude-cli",
  "clear")` path — reuse it, don't hand-roll the clear logic again)
- `haiku`, `sonnet`, `opus` (the three verified above)

Wire `onChange` the same way the `Codex effort` select already does in this same file (call
`updateCliModelPin("claude-cli", event.target.value || "clear")` — check the exact existing
call shape for `codex-effort` and mirror it for consistency, don't diverge unnecessarily).

D72-2: Before hardcoding the three-alias list, do your own cheap live check (same pattern as
above — a real `-p "say ok"` call per alias, not a guess) to confirm they still resolve on
whatever CLI version is installed at implementation time; if a 4th widely-known alias exists and
resolves cleanly (e.g. check `claude --help`'s own model description text again for any
additional named alias), it's fine to include it, but don't add speculative entries that aren't
verified.

D72-3: Remove the now-dead `claudeCliModelDraft` state/`useEffect` sync logic and
`commitTextInputOnEnter` usage for the Claude input specifically IF nothing else in the file
still needs it (check `codexCliModelDraft` still needs its own copy for the Codex free-text
input, which is unchanged this round — don't remove shared logic the Codex input still needs).

## Acceptance
tsc + `npm test` green. Live CDP verification required (same bar as D71 — this is a UI-facing
change): rebuild the packaged app, confirm the Claude CLI model control is now a `<select>` with
exactly `CLI default`/`haiku`/`sonnet`/`opus`, confirm selecting each option updates the Leader
dropdown's own label via `modelDisplayName()` (e.g. "claude-code/cli (model sonnet)"), confirm
`CLI default` clears it back to `undefined` (check the on-disk config, not just the label, same
verification depth as D70/D71's own review). Confirm the Codex CLI model input is UNCHANGED
(still free-text) and the Codex effort select is UNCHANGED. Commit `D72-<n>:`, create
`D72_done.txt`.
