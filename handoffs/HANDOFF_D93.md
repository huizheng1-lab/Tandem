# Handoff D93 (feature: desktop day/night theme, auto-switching by local time)

User request (originally "small change: i want t the UI to switch between day and night time
theme based on local time"). Held per the batching policy since investigation showed it's
genuinely large, not small — the user has now asked about it directly, which per that same
policy means write it now rather than continue holding.

## Scope confirmed before writing this (don't re-derive)

`app/renderer/src/styles.css` has **zero theme infrastructure**: `:root { color-scheme: dark; }`
is hardcoded, and there are **150 hardcoded hex color values** across 826 lines — every
`.sidebar`, `.transcript`, `.modal`, button, badge, etc. sets its own literal color. There is no
existing CSS custom-property layer to hook a theme switch into. This is a real refactor, not a
toggle.

## What to do

D93-1: refactor `styles.css` to CSS custom properties. Introduce a palette of custom properties
on `:root` (background layers, text, border, accent/role colors for leader/worker/system
bubbles, danger/success states — survey the existing 150 hex values to derive a reasonably
complete but not excessive palette, e.g. 15-25 named variables) and replace every hardcoded hex
value with `var(--name)`. Define two value sets: the current dark palette (used as
`:root` / `[data-theme="dark"]`) and a new light palette (`[data-theme="light"]`) with real,
readable light-mode colors — don't just invert dark values blindly; check contrast for text,
borders, and the role-colored chat bubbles specifically, since those carry semantic meaning
(leader/worker/system) that must stay visually distinct in both themes.

D93-2: theme selection logic in the renderer (`app/renderer/src/main.tsx` or a new small
`theme.ts` alongside `session-state.ts`, matching this codebase's existing pattern of splitting
out renderer logic modules):
- Compute "day" vs "night" from local time by default (pick a reasonable window, e.g. 6:00-19:00
  local = day; make the boundary a named constant, not a magic literal scattered in the code).
- Re-evaluate on an interval (a few minutes is plenty — this doesn't need to be real-time) and on
  window focus, so a session left open across the day/night boundary actually switches without
  requiring a restart.
- Add a config option to override auto-detection with an explicit choice (`"auto" | "light" |
  "dark"`), persisted the same way `showThinking` and other desktop config already round-trip
  through `TandemConfig`/`app/shared/ipc.ts`'s config get/set channels — reuse that existing
  mechanism, don't invent a separate settings store.
- Apply the resolved theme by setting `data-theme` on `document.documentElement` (or `:root`),
  matching the `[data-theme="light"|"dark"]` selectors from D93-1.

D93-3 (small, do only if trivial while in this area): expose the override as a simple control in
the desktop UI (e.g. next to the existing Permissions/Show-thinking checkboxes) — a 3-way
toggle or dropdown (Auto/Light/Dark), not a bigger settings panel.

## What NOT to do

- Don't touch the CLI TUI — it's terminal-rendered (Ink), theming there is a different problem
  and out of scope.
- Don't add a full design-system or component library refactor. Reuse the existing class names
  and DOM structure; only the color VALUES move to variables.
- Don't build a custom color-picker or arbitrary theme system — exactly two themes (light, dark)
  plus auto-detection, per the original request.

## Required tests / acceptance

tsc + `npm test` green. Since this is CSS-driven with a small amount of renderer logic, the
meaningful test coverage is on the TIME-TO-THEME logic (D93-2's day/night boundary function) —
add a unit test covering boundary times (just before/at/after the switch points) and the
auto/light/dark override resolution, pure-function style so it doesn't need a DOM. Live
verification is required for the visual part (this is exactly the kind of change that needs an
actual look, not just passing tests): rebuild the packaged app, force each theme via the config
override, and confirm readability — pay particular attention to the leader/worker/system chat
bubble colors and the sidebar session list in light mode, since those are the areas most likely
to have low-contrast surprises from a mechanical variable-ization pass. Paste a description (or
screenshot if practical) of both themes in the completion report. Commit `D93-<n>:`, create
`handoffs/D93_done.txt`.
