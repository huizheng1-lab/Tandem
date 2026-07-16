# Handoff D76 (consolidate CLI model pickers into the main Leader/Worker dropdown)

Sequenced AFTER D75 — do not start until `D75_done.txt` exists and D75's fix is committed.
D75 fixes a real clipping bug in the D74 popover; D76 then REMOVES that popover mechanism
entirely and replaces it with a different, simpler design. This is not wasted D75 effort — D75
must still land correctly on its own terms (it's a real bug fix), D76 is a separate follow-on
UX simplification the user asked for immediately after.

## User's request (verbatim intent)

"there are some duplicate in the model picker in the UI. need to consolidate. the easiest is to
list the cli models together with the api models in the same drop down"

Today there are two separate places to configure a leader/worker model: (1) the main Leader/
Worker `<select>` (lists `codex/cli`/`claude-code/cli` as single opaque entries alongside real
API models), and (2) the D74/D75 CLI-models control (popover or whatever D75 ships) for picking
the actual underlying CLI model/effort. The user wants ONE dropdown per role — no separate
control at all.

## Design (renderer-only, no backend/registry/schema changes needed)

`claudeCliModel`/`codexCliModel`/`codexCliReasoningEffort` are already free `TandemConfig`
fields (D69), not model-registry entries — so this is purely a UI-level list-construction change
in `app/renderer/src/main.tsx`, not a `src/providers/registry.ts`/`src/config/schema.ts` change.

D76-1: In the Leader and Worker `<select>` elements, when building the `<option>` list from
`models` (the array from `tandem.listModels()`), expand each CLI-provider entry
(`claude-code/cli`, `codex/cli`) into MULTIPLE options instead of one:
- For `claude-code/cli`: one option per known Claude CLI variant — `CLI default`, `haiku`,
  `sonnet`, `opus` (the same four values D72 already uses/verified live). Label each clearly,
  e.g. "claude-code/cli (haiku)", "claude-code/cli (sonnet)", etc., reusing `modelDisplayName`-
  style formatting.
- For `codex/cli`: one option per `codexCliReasoningEffort` value plus `CLI default` — `CLI
  default`, `minimal`, `low`, `medium`, `high` (the existing `CodexCliReasoningEffortSchema`
  enum, same list D71's Codex effort select already used). Free-form custom Codex MODEL names
  (not effort) stay out of this dropdown — D69's review found those are account-auth-dependent
  and a wrong guess 400s; keep `/model codex-cli <name>` (the D70 slash command) as the escape
  hatch for that, don't try to enumerate it here. Note this explicitly in the completion report
  so it's not mistaken for an oversight.
- All other (non-CLI) model entries render exactly as today, unchanged.

D76-2: Encode each expanded option's `value` so a single `onChange` can derive BOTH which base
engine to set (`leader`/`worker`) AND which CLI sub-field to set
(`claudeCliModel`/`codexCliReasoningEffort`) from one selection — e.g. a composite value like
`claude-code/cli::haiku` or `codex/cli::effort:low`, parsed in the select's `onChange` handler
into two `tandem.setConfig()` fields in one call: `{ leader: "claude-code/cli", claudeCliModel:
"haiku" }`. Reuse `cliModelPatch`'s clear-semantics (`undefined`, not `""`) for the `CLI default`
variant of each. Don't invent a new encoding scheme without checking whether `updateModel`/
`updateCliModelPin`'s existing shapes can be composed directly instead.

D76-3: Remove the D75 popover/trigger UI entirely (component, state, CSS) now that its job is
done by the consolidated dropdown — check whether the underlying `updateCliModelPin`/
`cliModelPatch` helpers are still needed elsewhere (they are — same helpers this round reuses)
before deleting anything beyond the UI-specific popover trigger/container/CSS classes.

D76-4: Confirm the Leader dropdown and Worker dropdown are independent — selecting a
`claude-code/cli (sonnet)` option for Leader must not affect Worker's selection or vice versa
(each role has its own `claudeCliModel`/`codexCliReasoningEffort`... wait, check this: today
`claudeCliModel`/`codexCliReasoningEffort` are GLOBAL config fields, not per-role. If leader is
`claude-code/cli (haiku)` and worker is ALSO `claude-code/cli`, they'd currently share the same
`claudeCliModel` value — confirm this existing behavior (from D69) is unchanged by this round,
and if the consolidated dropdown makes that shared-field limitation more visually confusing than
it already was (e.g. picking "claude-code/cli (opus)" for Worker silently changes what Leader's
dropdown now shows too, since they read the same field), flag it clearly in the completion report
as a pre-existing limitation, not something to silently fix or hide this round.

## Acceptance
tsc + `npm test` green. Live CDP verification required (same bar as every UI round this session):
rebuild the packaged app, confirm the Leader dropdown lists distinct entries for each Claude CLI
variant and Codex effort variant instead of one opaque `claude-code/cli`/`codex/cli` entry;
select `claude-code/cli (sonnet)`, confirm `leader="claude-code/cli"` AND
`claudeCliModel="sonnet"` both land in the on-disk config in one action; confirm the popover from
D75 no longer exists in the DOM. This time check ACTUAL VISIBILITY (bounding-box/screenshot
evidence), not just DOM presence/functional behavior — this project has now hit the same
DOM-presence-isn't-visibility gap twice (once in D26's history, once in this session's own D74
review), don't make it a third time. Commit `D76-<n>:`, create `D76_done.txt`.
