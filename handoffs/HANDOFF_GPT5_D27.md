# Handoff to GPT-5 — Round D27 (app shell must never scroll horizontally)

Reviewer-observed in three separate screenshots: the window content is wider than the viewport
(horizontal scrollbar at the bottom; the whole page pans sideways, sliding the sidebar half out
of view). This compounds every past visibility complaint — a user who has accidentally scrolled
right sees a sidebar with truncated or missing controls.

## D27-1: Fixed app shell
- Root layout: `html, body, #root { height: 100%; overflow: hidden }`; the app is a flex row of
  [fixed-width sidebar | flexible main pane]; only designated inner regions scroll vertically
  (transcript, session list, goals/schedules) and NOTHING scrolls horizontally.
- Find and fix whatever makes the content exceed the viewport width (suspects: the top status
  bar's fixed-width selects + labels overflowing at narrow widths — allow them to shrink with
  `min-width: 0` / flex-wrap; long unbroken strings in transcript cards — `overflow-wrap:
  anywhere` where missing).
- Sidebar gets a sane fixed width (e.g. 300–320px) that never changes with content.

## Acceptance
tsc + `npm test` green; commit `D27-1:`. Reviewer will verify via CDP at multiple window sizes
(1166px and ~900px wide): `document.documentElement.scrollWidth <= window.innerWidth`, no
horizontal scrollbar, sidebar fully visible at x >= 0, and the top-bar controls all reachable.
